import type {
  AgentProvider,
  AgentProviderConfig,
  AgentRunParams,
  AgentRunResult,
  AgentEvent,
  AgentFrameworkConfig,
} from "../types";
import { ClaudeAgentProvider } from "./claude-agent-provider";

/**
 * Codex provider ID for backend-aware routing.
 *
 * The current implementation reuses the Claude tool-orchestration runtime so
 * agent capabilities stay identical while backend selection, auth routing, and
 * run paths are codex-aware.
 */
export class CodexAgentProvider implements AgentProvider {
  readonly config: AgentProviderConfig = {
    id: "codex",
    name: "Codex Agent",
    description: "Codex backend with full tool access",
    auth: { type: "oauth" },
  };

  private delegate: ClaudeAgentProvider;

  constructor(frameworkConfig: AgentFrameworkConfig) {
    this.delegate = new ClaudeAgentProvider(frameworkConfig);
  }

  async *run(params: AgentRunParams): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    return yield* this.delegate.run(params);
  }

  cancel(taskId: string): void {
    this.delegate.cancel(taskId);
  }

  updateConfig(config: Partial<AgentFrameworkConfig>): void {
    this.delegate.updateConfig?.(config);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
