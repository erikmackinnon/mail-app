import { test, expect } from "@playwright/test";
import { z } from "zod";
import type { AgentToolSpec } from "../../src/main/agents/types";
import { toOpenAiJsonSchema } from "../../src/main/agents/providers/openai-compatible-agent-provider";

function makeTool(inputSchema: AgentToolSpec["inputSchema"]): AgentToolSpec {
  return {
    name: "test_tool",
    description: "test",
    inputSchema,
  };
}

test.describe("toOpenAiJsonSchema", () => {
  test("preserves non-string types from zod schema", () => {
    const schema = toOpenAiJsonSchema(
      makeTool(
        z.object({
          query: z.string(),
          count: z.number().int().optional(),
          includeDrafts: z.boolean(),
          tags: z.array(z.string()),
          meta: z.object({ priority: z.enum(["high", "low"]) }),
        }),
      ),
    );

    expect(schema).toMatchObject({
      type: "object",
      properties: {
        query: { type: "string" },
        count: { type: "integer" },
        includeDrafts: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        meta: {
          type: "object",
          properties: {
            priority: { type: "string", enum: ["high", "low"] },
          },
        },
      },
    });

    expect("$schema" in schema).toBe(false);
  });

  test("falls back to object schema for non-object inputs", () => {
    const schema = toOpenAiJsonSchema(makeTool(z.string()));
    expect(schema).toEqual({ type: "object", additionalProperties: true });
  });
});
