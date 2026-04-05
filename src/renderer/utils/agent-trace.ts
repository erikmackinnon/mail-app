import type { ScopedAgentEvent } from "../../shared/agent-types";

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
