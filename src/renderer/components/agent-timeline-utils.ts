import type { ScopedAgentEvent } from "../../shared/agent-types";

/**
 * Event types that render visible UI rows in the agent timeline.
 * State/done/tool_call_end events are status-only and do not produce rows.
 */
const RENDERABLE_EVENT_TYPES = new Set<ScopedAgentEvent["type"]>([
  "text_delta",
  "user_message",
  "tool_call_start",
  "confirmation_required",
  "error",
]);

export function hasRenderableTimelineEvents(events: ScopedAgentEvent[]): boolean {
  return events.some((event) => RENDERABLE_EVENT_TYPES.has(event.type));
}

export function getTimelineFallbackText(
  events: ScopedAgentEvent[],
  runFinished: boolean,
): string | null {
  if (!runFinished) {
    return hasRenderableTimelineEvents(events) ? null : "Agent is running. Waiting for response...";
  }

  if (hasRenderableTimelineEvents(events)) {
    return null;
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "done" && event.summary.trim().length > 0) {
      return event.summary;
    }
    if (event.type === "error" && event.message.trim().length > 0) {
      return event.message;
    }
  }

  return "Agent run completed with no visible output.";
}
