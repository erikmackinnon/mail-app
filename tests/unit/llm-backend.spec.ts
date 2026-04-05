import { test, expect } from "@playwright/test";
import {
  normalizeLlmBackend,
  getDefaultAgentProviderIdForBackend,
} from "../../src/main/services/llm-backend";

test.describe("llm-backend routing", () => {
  test("normalizes unknown backend values to anthropic", () => {
    expect(normalizeLlmBackend(undefined)).toBe("anthropic");
    expect(normalizeLlmBackend("other")).toBe("anthropic");
  });

  test("keeps codex backend value for model routing", () => {
    expect(normalizeLlmBackend("codex")).toBe("codex");
  });

  test("routes interactive agents to claude for every backend", () => {
    expect(getDefaultAgentProviderIdForBackend("anthropic")).toBe("claude");
    expect(getDefaultAgentProviderIdForBackend("codex")).toBe("claude");
  });
});
