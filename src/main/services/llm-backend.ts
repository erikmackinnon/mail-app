import type { LlmBackend } from "../../shared/types";

const DEFAULT_BACKEND: LlmBackend = "anthropic";

export function normalizeLlmBackend(value: unknown): LlmBackend {
  return value === "codex" ? "codex" : DEFAULT_BACKEND;
}

export function resolveLlmBackend(
  configuredBackend: unknown,
  envBackend: unknown = process.env.EXO_LLM_BACKEND,
): LlmBackend {
  if (envBackend === "codex" || envBackend === "anthropic") {
    return envBackend;
  }
  return normalizeLlmBackend(configuredBackend);
}

export function getActiveLlmBackend(): LlmBackend {
  return resolveLlmBackend(DEFAULT_BACKEND);
}

export function getDefaultAgentProviderIdForBackend(backend: LlmBackend): "claude" | "codex" {
  // Interactive agent tasks currently run on Claude Agent SDK for all backends.
  // Keep provider routing aligned with the runtime that actually executes.
  void backend;
  return "claude";
}

export function getDefaultAgentProviderId(): "claude" | "codex" {
  return getDefaultAgentProviderIdForBackend(getActiveLlmBackend());
}
