import { test, expect } from "@playwright/test";
import {
  normalizeLlmBackend,
  getDefaultAgentProviderIdForBackend,
  resolveLlmBackend,
} from "../../src/main/services/llm-backend";

test.describe("llm-backend routing", () => {
  test("normalizes unknown backend values to anthropic", () => {
    expect(normalizeLlmBackend(undefined)).toBe("anthropic");
    expect(normalizeLlmBackend("other")).toBe("anthropic");
  });

  test("keeps codex backend value for model routing", () => {
    expect(normalizeLlmBackend("codex")).toBe("codex");
  });

  test("prefers explicit env backend when resolving active backend", () => {
    expect(resolveLlmBackend("anthropic", "codex")).toBe("codex");
    expect(resolveLlmBackend("codex", "anthropic")).toBe("anthropic");
  });

  test("falls back to configured backend when env backend is invalid or missing", () => {
    expect(resolveLlmBackend("codex", undefined)).toBe("codex");
    expect(resolveLlmBackend("codex", "invalid")).toBe("codex");
  });

  test("routes interactive agents to claude for every backend", () => {
    expect(getDefaultAgentProviderIdForBackend("anthropic")).toBe("claude");
    expect(getDefaultAgentProviderIdForBackend("codex")).toBe("claude");
  });
});
