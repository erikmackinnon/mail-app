import { execFileSync } from "node:child_process";

export interface CodexExecCapabilities {
  supportsSearchFlag: boolean;
  supportsAskForApprovalFlag: boolean;
  supportsOutputLastMessageFlag: boolean;
}

const DEFAULT_CAPABILITIES: CodexExecCapabilities = {
  supportsSearchFlag: false,
  supportsAskForApprovalFlag: false,
  supportsOutputLastMessageFlag: false,
};

let cachedCapabilities: CodexExecCapabilities | null = null;

export function _parseCodexExecHelp(helpText: string): CodexExecCapabilities {
  const normalized = helpText.toLowerCase();
  return {
    supportsSearchFlag: normalized.includes("--search"),
    supportsAskForApprovalFlag: normalized.includes("--ask-for-approval"),
    supportsOutputLastMessageFlag: normalized.includes("--output-last-message"),
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

  if (capabilities.supportsAskForApprovalFlag) {
    args.push("--ask-for-approval", "never");
  }

  if (options.outputPath && capabilities.supportsOutputLastMessageFlag) {
    args.push("--output-last-message", options.outputPath);
  }

  args.push("-");
  return args;
}
