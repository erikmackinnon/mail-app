import { test, expect } from "@playwright/test";
import type { ScopedAgentEvent } from "../../src/shared/agent-types";
import {
  deriveReplayProviderIds,
  selectReplayFallbackProviderId,
} from "../../src/renderer/utils/agent-trace";

function stateEvent(providerId?: string): ScopedAgentEvent {
  return {
    type: "state",
    state: "running",
    ...(providerId ? { providerId } : {}),
  };
}

test.describe("deriveReplayProviderIds", () => {
  test("uses provider IDs found in trace events", () => {
    const ids = deriveReplayProviderIds([
      stateEvent("openai-compatible"),
      stateEvent("openai-compatible"),
      stateEvent("claude"),
    ]);

    expect(ids).toEqual(["openai-compatible", "claude"]);
  });

  test("ignores blank provider IDs", () => {
    const ids = deriveReplayProviderIds([stateEvent(""), stateEvent(" "), stateEvent("claude")]);
    expect(ids).toEqual(["claude"]);
  });

  test("falls back when events do not include provider IDs", () => {
    const ids = deriveReplayProviderIds([stateEvent(), stateEvent()], "openai-compatible");
    expect(ids).toEqual(["openai-compatible"]);
  });

  test("ignores invalid provider IDs from legacy traces", () => {
    const ids = deriveReplayProviderIds([stateEvent("auto-draft"), stateEvent("")], "claude");
    expect(ids).toEqual(["claude"]);
  });
});

test.describe("selectReplayFallbackProviderId", () => {
  test("uses persisted trace provider metadata when available", () => {
    const providerId = selectReplayFallbackProviderId({
      traceProviderId: "openai-compatible",
      availableProviderIds: ["claude"],
    });
    expect(providerId).toBe("openai-compatible");
  });

  test("uses explicit fallback order instead of available-provider array order", () => {
    const providerId = selectReplayFallbackProviderId({
      availableProviderIds: ["openai-compatible", "claude"],
    });
    expect(providerId).toBe("claude");
  });

  test("falls back to default provider when no metadata or providers exist", () => {
    const providerId = selectReplayFallbackProviderId({});
    expect(providerId).toBe("claude");
  });

  test("ignores invalid persisted trace provider metadata", () => {
    const providerId = selectReplayFallbackProviderId({
      traceProviderId: "auto-draft",
      availableProviderIds: ["openai-compatible", "claude"],
    });
    expect(providerId).toBe("claude");
  });

  test("replays missing-provider traces deterministically after restart", () => {
    const fallbackProviderId = selectReplayFallbackProviderId({
      traceProviderId: "openai-compatible",
      availableProviderIds: ["claude", "openai-compatible"],
    });
    const replayProviderIds = deriveReplayProviderIds([stateEvent(), stateEvent()], fallbackProviderId);
    expect(replayProviderIds).toEqual(["openai-compatible"]);
  });
});
