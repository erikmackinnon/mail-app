import type { ScopedAgentEvent } from "./agent-types";

const INVALID_TRACE_PROVIDER_IDS = new Set(["auto-draft"]);

export function normalizeTraceProviderId(providerId: string | undefined): string | undefined {
  const trimmed = providerId?.trim();
  if (!trimmed) return undefined;
  if (INVALID_TRACE_PROVIDER_IDS.has(trimmed)) return undefined;
  return trimmed;
}

export function resolvePersistedTraceProviderId(params: {
  events: ScopedAgentEvent[];
  requestedProviderIds?: string[];
  defaultProviderId?: string;
}): string {
  for (const event of params.events) {
    const providerId = normalizeTraceProviderId(event.providerId);
    if (providerId) return providerId;
  }

  for (const providerId of params.requestedProviderIds ?? []) {
    const normalized = normalizeTraceProviderId(providerId);
    if (normalized) return normalized;
  }

  return normalizeTraceProviderId(params.defaultProviderId) ?? "claude";
}
