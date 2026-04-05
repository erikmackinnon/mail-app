import { execFileSync } from "node:child_process";

export interface CodexExecCapabilities {
  supportsSearchFlag: boolean;
  supportsAskForApprovalFlag: boolean;
  supportsOutputLastMessageFlag: boolean;
  supportsReasoningEffortFlag: boolean;
  supportsReasoningFlag: boolean;
}

const DEFAULT_CAPABILITIES: CodexExecCapabilities = {
  supportsSearchFlag: false,
  supportsAskForApprovalFlag: false,
  supportsOutputLastMessageFlag: false,
  supportsReasoningEffortFlag: false,
  supportsReasoningFlag: false,
};

let cachedCapabilities: CodexExecCapabilities | null = null;

function hasFlag(helpText: string, flag: string): boolean {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedFlag}(?:[\\s,<]|$)`, "i");
  return pattern.test(helpText);
}

export function _parseCodexExecHelp(helpText: string): CodexExecCapabilities {
  return {
    supportsSearchFlag: hasFlag(helpText, "--search"),
    supportsAskForApprovalFlag: hasFlag(helpText, "--ask-for-approval"),
    supportsOutputLastMessageFlag: hasFlag(helpText, "--output-last-message"),
    supportsReasoningEffortFlag: hasFlag(helpText, "--reasoning-effort"),
    supportsReasoningFlag: hasFlag(helpText, "--reasoning"),
  };
}

function readCodexExecHelp(): string | null {
  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    return execFileSync("codex", ["exec", "--help"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export function getCodexExecCapabilities(): CodexExecCapabilities {
  if (cachedCapabilities) {
    return cachedCapabilities;
  }

  const helpText = readCodexExecHelp();
  if (!helpText) {
    cachedCapabilities = { ...DEFAULT_CAPABILITIES };
    return cachedCapabilities;
  }

  cachedCapabilities = _parseCodexExecHelp(helpText);
  return cachedCapabilities;
}

export interface BuildCodexExecArgsOptions {
  model: string;
  workspaceDir: string;
  outputPath?: string;
  enableWebSearch?: boolean;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  capabilities?: CodexExecCapabilities;
}

export function buildCodexExecArgs(options: BuildCodexExecArgsOptions): string[] {
  const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  const args: string[] = [];

  if (options.enableWebSearch && capabilities.supportsSearchFlag) {
    args.push("--search");
  }

  args.push(
    "exec",
    "--model",
    options.model,
    "--cd",
    options.workspaceDir,
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
  );

  if (options.reasoningEffort) {
    if (capabilities.supportsReasoningEffortFlag) {
      args.push("--reasoning-effort", options.reasoningEffort);
    } else if (capabilities.supportsReasoningFlag) {
      args.push("--reasoning", options.reasoningEffort);
    }
  }

  if (capabilities.supportsAskForApprovalFlag) {
    args.push("--ask-for-approval", "never");
  }

  if (options.outputPath && capabilities.supportsOutputLastMessageFlag) {
    args.push("--output-last-message", options.outputPath);
  }

  args.push("-");
  return args;
}
