import type { ScopedAgentEvent } from "../../shared/agent-types";

const REPLAY_PROVIDER_FALLBACK_ORDER = ["claude", "openai-compatible"] as const;

function normalizeProviderId(providerId: string | undefined): string | undefined {
  const trimmed = providerId?.trim();
  return trimmed ? trimmed : undefined;
}

export function selectReplayFallbackProviderId(params: {
  traceProviderId?: string;
  preferredProviderId?: string;
  availableProviderIds?: string[];
  defaultProviderId?: string;
}): string {
  const traceProviderId = normalizeProviderId(params.traceProviderId);
  if (traceProviderId) return traceProviderId;

  const preferredProviderId = normalizeProviderId(params.preferredProviderId);
  if (preferredProviderId) return preferredProviderId;

  const availableProviderIds = new Set(
    (params.availableProviderIds ?? []).map((id) => normalizeProviderId(id)).filter(Boolean),
  );

  for (const providerId of REPLAY_PROVIDER_FALLBACK_ORDER) {
    if (availableProviderIds.has(providerId)) {
      return providerId;
    }
  }

  return normalizeProviderId(params.defaultProviderId) ?? "claude";
}

export function deriveReplayProviderIds(
  events: ScopedAgentEvent[],
  fallbackProviderId: string = "claude",
): string[] {
  const providerIds = new Set<string>();
  for (const event of events) {
    if (event.providerId && event.providerId.trim().length > 0) {
      providerIds.add(event.providerId);
    }
  }
  if (providerIds.size > 0) {
    return [...providerIds];
  }
  return [fallbackProviderId];
}
