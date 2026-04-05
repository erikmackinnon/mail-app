import { test, expect } from "@playwright/test";
import {
  normalizeLlmBackend,
  getDefaultAgentProviderIdForBackend,
  resolveLlmBackend,
  setActiveLlmBackend,
  getActiveLlmBackend,
} from "../../src/main/services/llm-backend";

test.describe("llm-backend routing", () => {
  test("normalizes unknown backend values to anthropic", () => {
    expect(normalizeLlmBackend(undefined)).toBe("anthropic");
    expect(normalizeLlmBackend("other")).toBe("anthropic");
  });

  test("keeps codex backend value for model routing", () => {
    expect(normalizeLlmBackend("codex")).toBe("codex");
  });

  test("resolves backend from persisted config value", () => {
    expect(resolveLlmBackend("anthropic")).toBe("anthropic");
    expect(resolveLlmBackend("codex")).toBe("codex");
  });

  test("falls back to anthropic when configured backend is missing or invalid", () => {
    expect(resolveLlmBackend(undefined)).toBe("anthropic");
    expect(resolveLlmBackend("invalid")).toBe("anthropic");
  });

  test("tracks active backend from persisted config updates", () => {
    expect(setActiveLlmBackend("codex")).toBe("codex");
    expect(getActiveLlmBackend()).toBe("codex");
    expect(setActiveLlmBackend("invalid")).toBe("anthropic");
    expect(getActiveLlmBackend()).toBe("anthropic");
  });

  test("routes default interactive provider by backend", () => {
    expect(getDefaultAgentProviderIdForBackend("anthropic")).toBe("claude");
    expect(getDefaultAgentProviderIdForBackend("codex")).toBe("codex");
  });
});
