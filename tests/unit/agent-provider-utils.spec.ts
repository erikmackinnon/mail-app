import { test, expect } from "@playwright/test";
import type { ScopedAgentEvent } from "../../src/shared/agent-types";
import { resolvePersistedTraceProviderId } from "../../src/shared/agent-provider-utils";

function stateEvent(providerId?: string): ScopedAgentEvent {
  return {
    type: "state",
    state: "running",
    ...(providerId ? { providerId } : {}),
  };
}

test.describe("resolvePersistedTraceProviderId", () => {
  test("uses provider IDs from trace events when present", () => {
    const providerId = resolvePersistedTraceProviderId({
      events: [stateEvent("openai-compatible"), stateEvent("claude")],
      requestedProviderIds: ["claude"],
    });
    expect(providerId).toBe("openai-compatible");
  });

  test("falls back to requested provider IDs when events omit provider IDs", () => {
    const providerId = resolvePersistedTraceProviderId({
      events: [stateEvent(), stateEvent()],
      requestedProviderIds: ["openai-compatible"],
    });
    expect(providerId).toBe("openai-compatible");
  });

  test("ignores invalid legacy provider IDs", () => {
    const providerId = resolvePersistedTraceProviderId({
      events: [stateEvent("auto-draft"), stateEvent(" ")],
      requestedProviderIds: ["", "auto-draft", "claude"],
    });
    expect(providerId).toBe("claude");
  });
});
