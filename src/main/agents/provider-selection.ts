import type { LlmBackend } from "../../shared/types";

export type BuiltInAgentProviderId = "claude" | "openai-compatible";

export function getAgentProviderPreferenceOrder(
  llmBackend: LlmBackend | undefined,
): BuiltInAgentProviderId[] {
  if (llmBackend === "openai_compatible") {
    return ["openai-compatible", "claude"];
  }
  return ["claude", "openai-compatible"];
}

export async function resolveAgentProviderWithFallback(params: {
  llmBackend: LlmBackend | undefined;
  isProviderAvailable: (providerId: BuiltInAgentProviderId) => Promise<boolean>;
}): Promise<{
  providerId: BuiltInAgentProviderId;
  preferredProviderId: BuiltInAgentProviderId;
  usedFallback: boolean;
}> {
  const [preferredProviderId, fallbackProviderId] = getAgentProviderPreferenceOrder(params.llmBackend);
  if (await params.isProviderAvailable(preferredProviderId)) {
    return { providerId: preferredProviderId, preferredProviderId, usedFallback: false };
  }
  if (await params.isProviderAvailable(fallbackProviderId)) {
    return { providerId: fallbackProviderId, preferredProviderId, usedFallback: true };
  }
  return { providerId: preferredProviderId, preferredProviderId, usedFallback: false };
}
