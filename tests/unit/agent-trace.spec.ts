import { test, expect } from "@playwright/test";
import type { ScopedAgentEvent } from "../../src/shared/agent-types";
import { deriveReplayProviderIds } from "../../src/renderer/utils/agent-trace";

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
});
