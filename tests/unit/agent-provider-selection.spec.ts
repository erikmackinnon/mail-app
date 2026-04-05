import { test, expect } from "@playwright/test";
import {
  getAgentProviderPreferenceOrder,
  resolveAgentProviderWithFallback,
  type BuiltInAgentProviderId,
} from "../../src/main/agents/provider-selection";

test.describe("agent provider fallback selection", () => {
  test("prefers openai-compatible first when backend is openai_compatible", () => {
    expect(getAgentProviderPreferenceOrder("openai_compatible")).toEqual([
      "openai-compatible",
      "claude",
    ]);
  });

  test("prefers claude first when backend is anthropic", () => {
    expect(getAgentProviderPreferenceOrder("anthropic")).toEqual(["claude", "openai-compatible"]);
  });

  test("returns preferred provider when it is available", async () => {
    const checks: BuiltInAgentProviderId[] = [];
    const resolved = await resolveAgentProviderWithFallback({
      llmBackend: "openai_compatible",
      isProviderAvailable: async (providerId) => {
        checks.push(providerId);
        return providerId === "openai-compatible";
      },
    });

    expect(resolved).toEqual({
      providerId: "openai-compatible",
      preferredProviderId: "openai-compatible",
      usedFallback: false,
    });
    expect(checks).toEqual(["openai-compatible"]);
  });

  test("falls back when preferred provider is unavailable", async () => {
    const resolved = await resolveAgentProviderWithFallback({
      llmBackend: "openai_compatible",
      isProviderAvailable: async (providerId) => providerId === "claude",
    });

    expect(resolved).toEqual({
      providerId: "claude",
      preferredProviderId: "openai-compatible",
      usedFallback: true,
    });
  });

  test("returns preferred provider when both are unavailable", async () => {
    const resolved = await resolveAgentProviderWithFallback({
      llmBackend: "openai_compatible",
      isProviderAvailable: async () => false,
    });

    expect(resolved).toEqual({
      providerId: "openai-compatible",
      preferredProviderId: "openai-compatible",
      usedFallback: false,
    });
  });
});
