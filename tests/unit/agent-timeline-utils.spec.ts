import { test, expect } from "@playwright/test";
import type { ScopedAgentEvent } from "../../src/shared/agent-types";
import {
  hasRenderableTimelineEvents,
  getTimelineFallbackText,
} from "../../src/renderer/components/agent-timeline-utils";

test.describe("hasRenderableTimelineEvents", () => {
  test("returns false when run only has status events", () => {
    const events: ScopedAgentEvent[] = [
      { type: "state", state: "running", providerId: "codex" },
      { type: "done", summary: "Done", providerId: "codex" },
    ];

    expect(hasRenderableTimelineEvents(events)).toBe(false);
  });

  test("returns true when run has timeline-visible events", () => {
    const events: ScopedAgentEvent[] = [
      { type: "state", state: "running", providerId: "codex" },
      { type: "text_delta", text: "Hello", providerId: "codex" },
    ];

    expect(hasRenderableTimelineEvents(events)).toBe(true);
  });
});

test.describe("getTimelineFallbackText", () => {
  test("returns running placeholder for non-terminal runs without renderable events", () => {
    const events: ScopedAgentEvent[] = [{ type: "state", state: "running", providerId: "codex" }];
    expect(getTimelineFallbackText(events, false)).toBe("Agent is running. Waiting for response...");
  });

  test("returns done summary for terminal runs without renderable events", () => {
    const events: ScopedAgentEvent[] = [
      { type: "state", state: "running", providerId: "codex" },
      { type: "done", summary: "Codex run completed", providerId: "codex" },
      { type: "state", state: "completed", providerId: "codex" },
    ];
    expect(getTimelineFallbackText(events, true)).toBe("Codex run completed");
  });

  test("returns null when renderable events exist", () => {
    const events: ScopedAgentEvent[] = [
      { type: "state", state: "running", providerId: "codex" },
      { type: "text_delta", text: "hello", providerId: "codex" },
    ];
    expect(getTimelineFallbackText(events, true)).toBeNull();
  });
});
