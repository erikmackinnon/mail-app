import type { LlmBackend } from "../../shared/types";

const DEFAULT_BACKEND: LlmBackend = "anthropic";

export function normalizeLlmBackend(value: unknown): LlmBackend {
  return value === "codex" ? "codex" : DEFAULT_BACKEND;
}

export function getActiveLlmBackend(): LlmBackend {
  return normalizeLlmBackend(process.env.EXO_LLM_BACKEND);
}

export function getDefaultAgentProviderIdForBackend(backend: LlmBackend): "claude" | "codex" {
  return backend === "codex" ? "codex" : "claude";
}

export function getDefaultAgentProviderId(): "claude" | "codex" {
  return getDefaultAgentProviderIdForBackend(getActiveLlmBackend());
}
