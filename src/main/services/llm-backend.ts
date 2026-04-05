import type { LlmBackend } from "../../shared/types";

const DEFAULT_BACKEND: LlmBackend = "anthropic";
let activeBackend: LlmBackend = DEFAULT_BACKEND;

export function normalizeLlmBackend(value: unknown): LlmBackend {
  return value === "codex" ? "codex" : DEFAULT_BACKEND;
}

export function resolveLlmBackend(configuredBackend: unknown): LlmBackend {
  return normalizeLlmBackend(configuredBackend);
}

export function setActiveLlmBackend(configuredBackend: unknown): LlmBackend {
  activeBackend = resolveLlmBackend(configuredBackend);
  return activeBackend;
}

export function getActiveLlmBackend(): LlmBackend {
  return activeBackend;
}

export function getDefaultAgentProviderIdForBackend(backend: LlmBackend): "claude" | "codex" {
  return backend === "codex" ? "codex" : "claude";
}

export function getDefaultAgentProviderId(): "claude" | "codex" {
  return getDefaultAgentProviderIdForBackend(getActiveLlmBackend());
}
