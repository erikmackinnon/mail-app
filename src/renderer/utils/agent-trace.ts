import type { ScopedAgentEvent } from "../../shared/agent-types";
import { normalizeTraceProviderId } from "../../shared/agent-provider-utils";

const REPLAY_PROVIDER_FALLBACK_ORDER = ["claude", "openai-compatible"] as const;

export function selectReplayFallbackProviderId(params: {
  traceProviderId?: string;
  preferredProviderId?: string;
  availableProviderIds?: string[];
  defaultProviderId?: string;
}): string {
  const traceProviderId = normalizeTraceProviderId(params.traceProviderId);
  if (traceProviderId) return traceProviderId;

  const preferredProviderId = normalizeTraceProviderId(params.preferredProviderId);
  if (preferredProviderId) return preferredProviderId;

  const availableProviderIds = new Set(
    (params.availableProviderIds ?? [])
      .map((id) => normalizeTraceProviderId(id))
      .filter((id): id is string => Boolean(id)),
  );

  for (const providerId of REPLAY_PROVIDER_FALLBACK_ORDER) {
    if (availableProviderIds.has(providerId)) {
      return providerId;
    }
  }

  return normalizeTraceProviderId(params.defaultProviderId) ?? "claude";
}

export function deriveReplayProviderIds(
  events: ScopedAgentEvent[],
  fallbackProviderId: string = "claude",
): string[] {
  const providerIds = new Set<string>();
  for (const event of events) {
    const providerId = normalizeTraceProviderId(event.providerId);
    if (providerId) providerIds.add(providerId);
  }
  if (providerIds.size > 0) {
    return [...providerIds];
  }
  return [fallbackProviderId];
}
