import { test, expect } from "@playwright/test";
import type { ScopedAgentEvent } from "../../src/shared/agent-types";
import { hasRenderableTimelineEvents } from "../../src/renderer/components/agent-timeline-utils";

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

