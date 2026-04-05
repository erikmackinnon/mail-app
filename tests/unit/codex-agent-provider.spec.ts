import { test, expect } from "@playwright/test";
import { z } from "zod";
import {
  CodexAgentProvider,
  _buildCodexAgentExecArgs,
  _buildCodexAgentPrompt,
  _hydrateCodexPromptContext,
} from "../../src/main/agents/providers/codex-agent-provider";
import type { AgentRunParams } from "../../src/main/agents/types";
import type { CodexExecCapabilities } from "../../src/main/utils/codex-cli";

const FULL_CAPABILITIES: CodexExecCapabilities = {
  supportsSearchFlag: true,
  supportsAskForApprovalFlag: true,
  supportsOutputLastMessageFlag: true,
  supportsReasoningEffortFlag: true,
  supportsReasoningFlag: false,
};

function makeRunParams(taskId = "task-1"): AgentRunParams {
  return {
    taskId,
    prompt: "Draft a short reply",
    context: {
      userEmail: "user@example.com",
      accountId: "default",
      currentEmailId: "email-1",
      emailSubject: "Quarterly update",
      emailFrom: "Alex <alex@example.com>",
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
  test("omits unsupported optional codex exec flags by default", () => {
    const args = _buildCodexAgentExecArgs("/tmp/out.txt", "/tmp/workspace");
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5.4-mini");
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).not.toContain("--reasoning-effort");
    expect(args).not.toContain("--reasoning");
    expect(args).not.toContain("--ask-for-approval");
    expect(args).not.toContain("--output-last-message");
  });

  test("uses optional codex exec flags when capabilities indicate support", () => {
    const args = _buildCodexAgentExecArgs("/tmp/out.txt", "/tmp/workspace", {
      capabilities: FULL_CAPABILITIES,
    });
    expect(args).toContain("--reasoning-effort");
    expect(args).toContain("high");
    expect(args).toContain("--ask-for-approval");
    expect(args).toContain("never");
    expect(args).toContain("--output-last-message");
  });

  test("builds a prompt with user request and context", () => {
    const prompt = _buildCodexAgentPrompt(makeRunParams());
    expect(prompt).toContain("USER REQUEST:");
    expect(prompt).toContain("Draft a short reply");
    expect(prompt).toContain("currentEmailId: email-1");
    expect(prompt).toContain("emailSubject: Quarterly update");
  });

  test("runs and emits completed events when codex execution succeeds", async () => {
    const provider = new CodexAgentProvider(
      { model: "claude-sonnet-4-20250514" },
      {
        isCliAvailable: () => true,
        runPrompt: async () => "Here is a concise response.",
      },
    );

    await expect(provider.isAvailable()).resolves.toBe(true);

    const gen = provider.run(makeRunParams("task-success"));
    const first = await gen.next();
    expect(first.done).toBe(false);
    if (!first.done) {
      expect(first.value.type).toBe("state");
      if (first.value.type === "state") {
        expect(first.value.state).toBe("running");
      }
    }

    const second = await gen.next();
    expect(second.done).toBe(false);
    if (!second.done) {
      expect(second.value.type).toBe("text_delta");
      if (second.value.type === "text_delta") {
        expect(second.value.text).toContain("concise response");
      }
    }

    const third = await gen.next();
    expect(third.done).toBe(false);
    if (!third.done) {
      expect(third.value.type).toBe("done");
    }

    const fourth = await gen.next();
    expect(fourth.done).toBe(true);
    if (fourth.done) {
      expect(fourth.value.state).toBe("completed");
    }
  });

  test("supports cancellation", async () => {
    const provider = new CodexAgentProvider(
      { model: "claude-sonnet-4-20250514" },
      {
        isCliAvailable: () => true,
        runPrompt: async ({ signal }) =>
          new Promise<string>((resolve, reject) => {
            const onAbort = () => reject(new Error("Request cancelled"));
            signal.addEventListener("abort", onAbort, { once: true });
            setTimeout(() => {
              signal.removeEventListener("abort", onAbort);
              resolve("late response");
            }, 200);
          }),
      },
    );

    const taskId = "task-cancel";
    const gen = provider.run(makeRunParams(taskId));

    const first = await gen.next();
    expect(first.done).toBe(false);
    provider.cancel(taskId);

    const second = await gen.next();
    expect(second.done).toBe(false);
    if (!second.done) {
      expect(second.value.type).toBe("state");
      if (second.value.type === "state") {
        expect(second.value.state).toBe("cancelled");
      }
    }

    const third = await gen.next();
    expect(third.done).toBe(true);
    if (third.done) {
      expect(third.value.state).toBe("cancelled");
    }
  });

  test("hydrates current email/thread/draft context before running prompt", async () => {
    const toolCalls: string[] = [];
    let capturedPrompt = "";
    const params = makeRunParams("task-hydration");
    params.context.currentThreadId = "thread-1";
    params.context.currentDraftId = "draft-1";
    params.toolExecutor = async (toolName) => {
      toolCalls.push(toolName);
      if (toolName === "read_email") {
        return {
          id: "email-1",
          subject: "Quarterly update",
          from: "Alex <alex@example.com>",
          body: "Hi team, here is the detailed quarterly update with action items.",
        };
      }
      if (toolName === "read_thread") {
        return [
          {
            id: "email-0",
            subject: "Kickoff",
            from: "Jordan <jordan@example.com>",
            body: "Starting thread context.",
          },
          {
            id: "email-1",
            subject: "Quarterly update",
            from: "Alex <alex@example.com>",
            body: "Detailed context in this message.",
          },
        ];
      }
      if (toolName === "read_draft") {
        return {
          id: "draft-1",
          to: ["alex@example.com"],
          subject: "Re: Quarterly update",
          bodyText: "Thanks Alex, I reviewed this and have one question.",
        };
      }
      throw new Error(`unexpected tool: ${toolName}`);
    };

    const provider = new CodexAgentProvider(
      { model: "claude-sonnet-4-20250514" },
      {
        isCliAvailable: () => true,
        runPrompt: async ({ prompt }) => {
          capturedPrompt = prompt;
          return "Hydrated response";
        },
      },
    );

    const gen = provider.run(params);
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        expect(next.value.state).toBe("completed");
        break;
      }
    }

    expect(toolCalls.sort()).toEqual(["read_draft", "read_email", "read_thread"]);
    expect(capturedPrompt).toContain("CURRENT EMAIL (hydrated via read_email):");
    expect(capturedPrompt).toContain("Detailed context in this message.");
    expect(capturedPrompt).toContain("THREAD CONTEXT (hydrated via read_thread):");
    expect(capturedPrompt).toContain("CURRENT DRAFT (hydrated via read_draft):");
    expect(capturedPrompt).toContain("Thanks Alex, I reviewed this and have one question.");
  });

  test("does not throw when hydration tool calls fail", async () => {
    const params = makeRunParams("task-hydration-fail");
    params.context.currentThreadId = "thread-1";
    params.toolExecutor = async (toolName) => {
      if (toolName === "read_email") {
        return {
          id: "email-1",
          subject: "Quarterly update",
          from: "Alex <alex@example.com>",
          body: "fallback context",
        };
      }
      if (toolName === "read_thread") {
        throw new Error("db unavailable");
      }
      return {};
    };

    await expect(_hydrateCodexPromptContext(params)).resolves.toMatchObject({
      email: {
        id: "email-1",
      },
    });

    const provider = new CodexAgentProvider(
      { model: "claude-sonnet-4-20250514" },
      {
        isCliAvailable: () => true,
        runPrompt: async () => "Still completes",
      },
    );

    const gen = provider.run(params);
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        expect(next.value.state).toBe("completed");
        break;
      }
    }
  });
});
