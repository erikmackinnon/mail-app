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
import {
  buildCodexExecArgs,
  getCodexExecCapabilities,
  type CodexExecCapabilities,
} from "../../utils/codex-cli";
import { createLogger } from "../../services/logger";

const CODEX_AGENT_MODEL = "gpt-5.4-mini";
const CODEX_AGENT_REASONING_EFFORT = "high" as const;
const CODEX_AGENT_TIMEOUT_MS = 180_000;
const MAX_PROMPT_TEXT_LENGTH = 2_000;
const MAX_THREAD_MESSAGES = 6;
const log = createLogger("codex-agent");

export interface CodexAgentRunInput {
  prompt: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface CodexAgentProviderDeps {
  isCliAvailable?: () => boolean;
  runPrompt?: (input: CodexAgentRunInput) => Promise<string>;
}

interface HydratedEmailContext {
  id?: string;
  from?: string;
  to?: string;
  date?: string;
  subject?: string;
  body?: string;
}

interface HydratedThreadMessage {
  id?: string;
  from?: string;
  date?: string;
  subject?: string;
  body?: string;
}

interface HydratedThreadContext {
  threadId: string;
  totalMessages: number;
  messages: HydratedThreadMessage[];
}

interface HydratedDraftContext {
  id?: string;
  subject?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  body?: string;
}

export interface CodexHydratedPromptContext {
  email?: HydratedEmailContext;
  thread?: HydratedThreadContext;
  draft?: HydratedDraftContext;
}

export function _buildCodexAgentExecArgs(
  outputPath: string,
  workspaceDir: string,
  options: { capabilities?: CodexExecCapabilities } = {},
): string[] {
  return buildCodexExecArgs({
    model: CODEX_AGENT_MODEL,
    reasoningEffort: CODEX_AGENT_REASONING_EFFORT,
    workspaceDir,
    outputPath,
    capabilities: options.capabilities,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function normalizeText(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function truncateForPrompt(text: string, maxLength = MAX_PROMPT_TEXT_LENGTH): string {
  const normalized = normalizeText(text);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}…`;
}

function extractEmailContext(raw: unknown): HydratedEmailContext | null {
  const record = asRecord(raw);
  if (!record) return null;
  const body = asString(record.body) ?? asString(record.bodyText) ?? asString(record.snippet);
  return {
    id: asString(record.id),
    from: asString(record.from),
    to: asString(record.to),
    date: asString(record.date),
    subject: asString(record.subject),
    body: body ? truncateForPrompt(body) : undefined,
  };
}

function extractThreadMessage(raw: unknown): HydratedThreadMessage | null {
  const record = asRecord(raw);
  if (!record) return null;
  const body = asString(record.body) ?? asString(record.bodyText) ?? asString(record.snippet);
  return {
    id: asString(record.id),
    from: asString(record.from),
    date: asString(record.date),
    subject: asString(record.subject),
    body: body ? truncateForPrompt(body, 700) : undefined,
  };
}

function extractDraftContext(raw: unknown): HydratedDraftContext | null {
  const record = asRecord(raw);
  if (!record) return null;
  const body = asString(record.bodyText) ?? asString(record.bodyHtml);
  return {
    id: asString(record.id),
    subject: asString(record.subject),
    to: asStringArray(record.to),
    cc: asStringArray(record.cc),
    bcc: asStringArray(record.bcc),
    body: body ? truncateForPrompt(body) : undefined,
  };
}

export async function _hydrateCodexPromptContext(
  params: AgentRunParams,
): Promise<CodexHydratedPromptContext> {
  const hydrated: CodexHydratedPromptContext = {};
  const ops: Promise<void>[] = [];
  const { currentEmailId, currentThreadId, currentDraftId, accountId } = params.context;

  if (currentEmailId) {
    ops.push(
      (async () => {
        try {
          const raw = await params.toolExecutor("read_email", { emailId: currentEmailId });
          const email = extractEmailContext(raw);
          if (email) hydrated.email = email;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(
            { taskId: params.taskId, emailId: currentEmailId, err: message },
            "Failed to hydrate current email context for Codex prompt",
          );
        }
      })(),
    );
  }

  if (currentThreadId) {
    ops.push(
      (async () => {
        try {
          const raw = await params.toolExecutor("read_thread", {
            threadId: currentThreadId,
            accountId,
          });
          const messages = Array.isArray(raw)
            ? raw
                .map((msg) => extractThreadMessage(msg))
                .filter((msg): msg is HydratedThreadMessage => msg !== null)
            : [];
          if (messages.length > 0) {
            hydrated.thread = {
              threadId: currentThreadId,
              totalMessages: messages.length,
              messages,
            };
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(
            { taskId: params.taskId, threadId: currentThreadId, err: message },
            "Failed to hydrate thread context for Codex prompt",
          );
        }
      })(),
    );
  }

  if (currentDraftId) {
    ops.push(
      (async () => {
        try {
          const raw = await params.toolExecutor("read_draft", { draftId: currentDraftId });
          const draft = extractDraftContext(raw);
          if (draft) hydrated.draft = draft;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(
            { taskId: params.taskId, draftId: currentDraftId, err: message },
            "Failed to hydrate draft context for Codex prompt",
          );
        }
      })(),
    );
  }

  await Promise.all(ops);
  return hydrated;
}

export function _buildCodexAgentPrompt(
  params: AgentRunParams,
  hydratedContext: CodexHydratedPromptContext = {},
): string {
  const contextLines = [
    params.context.currentEmailId ? `- currentEmailId: ${params.context.currentEmailId}` : null,
    params.context.currentThreadId ? `- currentThreadId: ${params.context.currentThreadId}` : null,
    params.context.currentDraftId ? `- currentDraftId: ${params.context.currentDraftId}` : null,
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

  if (hydratedContext.email) {
    lines.push("CURRENT EMAIL (hydrated via read_email):");
    if (hydratedContext.email.id) lines.push(`ID: ${hydratedContext.email.id}`);
    if (hydratedContext.email.subject) lines.push(`Subject: ${hydratedContext.email.subject}`);
    if (hydratedContext.email.from) lines.push(`From: ${hydratedContext.email.from}`);
    if (hydratedContext.email.to) lines.push(`To: ${hydratedContext.email.to}`);
    if (hydratedContext.email.date) lines.push(`Date: ${hydratedContext.email.date}`);
    if (hydratedContext.email.body) lines.push(`Body: ${hydratedContext.email.body}`);
    lines.push("");
  } else if (params.context.emailBody) {
    lines.push("CURRENT EMAIL BODY (from renderer context):");
    lines.push(truncateForPrompt(params.context.emailBody));
    lines.push("");
  }

  if (hydratedContext.thread) {
    lines.push("THREAD CONTEXT (hydrated via read_thread):");
    lines.push(
      `Thread ID: ${hydratedContext.thread.threadId} (showing latest ${Math.min(
        hydratedContext.thread.totalMessages,
        MAX_THREAD_MESSAGES,
      )} of ${hydratedContext.thread.totalMessages} messages)`,
    );
    const recentMessages = hydratedContext.thread.messages.slice(-MAX_THREAD_MESSAGES);
    for (let index = 0; index < recentMessages.length; index += 1) {
      const message = recentMessages[index];
      lines.push(`Message ${index + 1}:`);
      if (message.id) lines.push(`  ID: ${message.id}`);
      if (message.subject) lines.push(`  Subject: ${message.subject}`);
      if (message.from) lines.push(`  From: ${message.from}`);
      if (message.date) lines.push(`  Date: ${message.date}`);
      if (message.body) lines.push(`  Body: ${message.body}`);
    }
    lines.push("");
  }

  if (hydratedContext.draft) {
    lines.push("CURRENT DRAFT (hydrated via read_draft):");
    if (hydratedContext.draft.id) lines.push(`ID: ${hydratedContext.draft.id}`);
    if (hydratedContext.draft.subject) lines.push(`Subject: ${hydratedContext.draft.subject}`);
    if (hydratedContext.draft.to) lines.push(`To: ${hydratedContext.draft.to.join(", ")}`);
    if (hydratedContext.draft.cc) lines.push(`CC: ${hydratedContext.draft.cc.join(", ")}`);
    if (hydratedContext.draft.bcc) lines.push(`BCC: ${hydratedContext.draft.bcc.join(", ")}`);
    if (hydratedContext.draft.body) lines.push(`Body: ${hydratedContext.draft.body}`);
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
  const capabilities = getCodexExecCapabilities();
  const args = _buildCodexAgentExecArgs(outputPath, tmpDir, { capabilities });
  const env = { ...process.env };
  delete env.CLAUDECODE;
  let stdoutText = "";

  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Request cancelled"));
        return;
      }

      const child = spawn("codex", args, {
        cwd: tmpDir,
        env,
        stdio: ["pipe", capabilities.supportsOutputLastMessageFlag ? "ignore" : "pipe", "pipe"],
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

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutText += chunk.toString();
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
        if (!capabilities.supportsOutputLastMessageFlag && !stdoutText.trim()) {
          reject(new Error("Codex CLI returned an empty response"));
          return;
        }
        resolve();
      });

      if (!child.stdin) {
        reject(new Error("Codex CLI stdin is unavailable"));
        return;
      }

      child.stdin.write(prompt);
      child.stdin.end();
    });

    const text = capabilities.supportsOutputLastMessageFlag
      ? readFileSync(outputPath, "utf-8").trim()
      : stdoutText.trim();
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

      const hydratedContext = await _hydrateCodexPromptContext(params);
      const prompt = _buildCodexAgentPrompt(params, hydratedContext);
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
