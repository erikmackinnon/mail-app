import type { LlmBackend } from "../../shared/types";

export type BuiltInAgentProviderId = "claude" | "openai-compatible";
const DEFAULT_PROVIDER_AVAILABILITY_TIMEOUT_MS = 1_000;

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
  availabilityTimeoutMs?: number;
}): Promise<{
  providerId: BuiltInAgentProviderId;
  preferredProviderId: BuiltInAgentProviderId;
  usedFallback: boolean;
}> {
  const checkProviderWithTimeout = async (
    providerId: BuiltInAgentProviderId,
    timeoutMs: number,
  ): Promise<boolean> => {
    const timeout = Math.max(0, timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race<boolean>([
        params.isProviderAvailable(providerId),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeout);
        }),
      ]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const timeoutMs = params.availabilityTimeoutMs ?? DEFAULT_PROVIDER_AVAILABILITY_TIMEOUT_MS;
  const [preferredProviderId, fallbackProviderId] = getAgentProviderPreferenceOrder(params.llmBackend);
  const preferredCheck = checkProviderWithTimeout(preferredProviderId, timeoutMs);
  const fallbackCheck = checkProviderWithTimeout(fallbackProviderId, timeoutMs);

  if (await preferredCheck) {
    return { providerId: preferredProviderId, preferredProviderId, usedFallback: false };
  }
  if (await fallbackCheck) {
    return { providerId: fallbackProviderId, preferredProviderId, usedFallback: true };
  }
  return { providerId: preferredProviderId, preferredProviderId, usedFallback: false };
}
