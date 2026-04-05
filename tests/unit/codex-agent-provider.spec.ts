import { test, expect } from "@playwright/test";
import { z } from "zod";
import { CodexAgentProvider } from "../../src/main/agents/providers/codex-agent-provider";
import type { AgentRunParams } from "../../src/main/agents/types";

function makeRunParams(): AgentRunParams {
  return {
    taskId: "task-1",
    prompt: "hello",
    context: {
      userEmail: "user@example.com",
      accountId: "default",
    },
    tools: [
      {
        name: "noop",
        description: "noop",
        inputSchema: z.object({}),
      },
    ],
    toolExecutor: async () => ({}),
    netFetch: async () => {
      throw new Error("not used");
    },
    signal: new AbortController().signal,
  };
}

test.describe("CodexAgentProvider", () => {
  test("is not available until codex runtime is implemented", async () => {
    const provider = new CodexAgentProvider({ model: "claude-sonnet-4-20250514" });
    await expect(provider.isAvailable()).resolves.toBe(false);
  });

  test("fails fast instead of silently delegating to another runtime", async () => {
    const provider = new CodexAgentProvider({ model: "claude-sonnet-4-20250514" });
    const gen = provider.run(makeRunParams());

    const first = await gen.next();
    expect(first.done).toBe(false);
    if (!first.done) {
      expect(first.value.type).toBe("error");
      if (first.value.type === "error") {
        expect(first.value.message).toContain("not available");
      }
    }

    const second = await gen.next();
    expect(second.done).toBe(true);
    if (second.done) {
      expect(second.value.state).toBe("failed");
    }
  });
});
