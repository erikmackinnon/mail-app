import type {
  AgentProvider,
  AgentProviderConfig,
  AgentRunParams,
  AgentRunResult,
  AgentEvent,
  AgentFrameworkConfig,
} from "../types";

/**
 * Codex provider placeholder.
 * Interactive agent orchestration still runs on Claude Agent SDK; this provider
 * intentionally fails fast so we never silently delegate to a different runtime.
 */
export class CodexAgentProvider implements AgentProvider {
  readonly config: AgentProviderConfig = {
    id: "codex",
    name: "Codex Agent",
    description: "Unavailable: Codex interactive agent runtime is not yet implemented",
    auth: { type: "oauth" },
  };

  constructor(_frameworkConfig: AgentFrameworkConfig) {}

  async *run(_params: AgentRunParams): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    const message =
      "Codex interactive agent runtime is not available yet. Use the Claude provider for agent tasks.";
    yield { type: "error", message };
    return { state: "failed" };
  }

  cancel(_taskId: string): void {}

  updateConfig(_config: Partial<AgentFrameworkConfig>): void {}

  async isAvailable(): Promise<boolean> {
    return false;
  }
}
