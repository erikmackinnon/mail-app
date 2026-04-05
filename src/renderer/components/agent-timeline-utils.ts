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

