import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentProvider,
  AgentProviderConfig,
  AgentRunParams,
  AgentRunResult,
  AgentEvent,
  AgentFrameworkConfig,
} from "../types";

const CODEX_AGENT_MODEL = "gpt-5.4-mini-high";
const CODEX_AGENT_TIMEOUT_MS = 180_000;

export interface CodexAgentRunInput {
  prompt: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface CodexAgentProviderDeps {
  isCliAvailable?: () => boolean;
  runPrompt?: (input: CodexAgentRunInput) => Promise<string>;
}

export function _buildCodexAgentExecArgs(outputPath: string, workspaceDir: string): string[] {
  return [
    "exec",
    "--model",
    CODEX_AGENT_MODEL,
    "--cd",
    workspaceDir,
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--output-last-message",
    outputPath,
    "-",
  ];
}

export function _buildCodexAgentPrompt(params: AgentRunParams): string {
  const contextLines = [
    params.context.currentEmailId ? `- currentEmailId: ${params.context.currentEmailId}` : null,
    params.context.currentThreadId ? `- currentThreadId: ${params.context.currentThreadId}` : null,
    params.context.userEmail ? `- userEmail: ${params.context.userEmail}` : null,
    params.context.emailSubject ? `- emailSubject: ${params.context.emailSubject}` : null,
    params.context.emailFrom ? `- emailFrom: ${params.context.emailFrom}` : null,
  ].filter(Boolean) as string[];

  const lines: string[] = [];
  lines.push("You are Exo's mail assistant.");
  lines.push("Respond directly to the user request in plain text.");
  lines.push("Do not claim to have run tools, shell commands, or file operations.");
  lines.push("If an action is unavailable, explain the limitation and suggest next steps.");
  lines.push("");

  if (contextLines.length > 0) {
    lines.push("CONTEXT:");
    lines.push(...contextLines);
    lines.push("");
  }

  lines.push("USER REQUEST:");
  lines.push(params.prompt.trim());
  return lines.join("\n");
}

function isCodexCliAvailable(): boolean {
  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    execFileSync("codex", ["--version"], {
      env,
      timeout: 5_000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function runCodexPrompt({ prompt, signal, timeoutMs }: CodexAgentRunInput): Promise<string> {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "exo-codex-agent-"));
  const outputPath = path.join(tmpDir, "last-message.txt");
  const args = _buildCodexAgentExecArgs(outputPath, tmpDir);
  const env = { ...process.env };
  delete env.CLAUDECODE;

  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Request cancelled"));
        return;
      }

      const child = spawn("codex", args, {
        cwd: tmpDir,
        env,
        stdio: ["pipe", "ignore", "pipe"],
      });

      let timedOut = false;
      let stderr = "";
      const onAbort = () => {
        child.kill("SIGTERM");
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs ?? CODEX_AGENT_TIMEOUT_MS);

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(err);
      });

      child.on("exit", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);

        if (signal.aborted) {
          reject(new Error("Request cancelled"));
          return;
        }
        if (timedOut) {
          reject(new Error(`Codex CLI timed out after ${timeoutMs ?? CODEX_AGENT_TIMEOUT_MS}ms`));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Codex CLI exited with code ${code}`));
          return;
        }
        resolve();
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });

    const text = readFileSync(outputPath, "utf-8").trim();
    if (!text) {
      throw new Error("Codex CLI returned an empty response");
    }
    return text;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export class CodexAgentProvider implements AgentProvider {
  readonly config: AgentProviderConfig = {
    id: "codex",
    name: "Codex Agent",
    description: "Codex CLI runtime (non-interactive)",
    auth: { type: "oauth" },
  };

  private frameworkConfig: AgentFrameworkConfig;
  private readonly deps: Required<CodexAgentProviderDeps>;
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(frameworkConfig: AgentFrameworkConfig, deps: CodexAgentProviderDeps = {}) {
    this.frameworkConfig = frameworkConfig;
    this.deps = {
      isCliAvailable: deps.isCliAvailable ?? isCodexCliAvailable,
      runPrompt: deps.runPrompt ?? runCodexPrompt,
    };
  }

  async *run(params: AgentRunParams): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    if (!this.deps.isCliAvailable()) {
      yield { type: "error", message: "Codex CLI not found on PATH" };
      return { state: "failed" };
    }

    const runController = new AbortController();
    this.activeRuns.set(params.taskId, runController);
    const onParentAbort = () => runController.abort();
    params.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      if (runController.signal.aborted || params.signal.aborted) {
        yield { type: "state", state: "cancelled" };
        return { state: "cancelled" };
      }

      yield { type: "state", state: "running" };

      const prompt = _buildCodexAgentPrompt(params);
      const text = await this.deps.runPrompt({
        prompt,
        signal: runController.signal,
      });

      if (runController.signal.aborted || params.signal.aborted) {
        yield { type: "state", state: "cancelled" };
        return { state: "cancelled" };
      }

      yield { type: "text_delta", text };
      yield { type: "done", summary: "Codex run completed" };
      return { state: "completed" };
    } catch (err) {
      if (runController.signal.aborted || params.signal.aborted) {
        yield { type: "state", state: "cancelled" };
        return { state: "cancelled" };
      }

      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", message };
      return { state: "failed" };
    } finally {
      params.signal.removeEventListener("abort", onParentAbort);
      this.activeRuns.delete(params.taskId);
    }
  }

  cancel(taskId: string): void {
    const controller = this.activeRuns.get(taskId);
    if (controller) {
      controller.abort();
      this.activeRuns.delete(taskId);
    }
  }

  updateConfig(config: Partial<AgentFrameworkConfig>): void {
    this.frameworkConfig = { ...this.frameworkConfig, ...config };
  }

  async isAvailable(): Promise<boolean> {
    return this.deps.isCliAvailable();
  }
}
