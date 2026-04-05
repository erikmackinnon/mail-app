import { expect, test } from "@playwright/test";
import {
  _parseCodexExecHelp,
  buildCodexExecArgs,
  type CodexExecCapabilities,
} from "../../src/main/utils/codex-cli";

test.describe("codex cli compatibility", () => {
  test("parses help text capability flags", () => {
    const capabilities = _parseCodexExecHelp(`
Usage: codex exec [OPTIONS] [PROMPT]
  --search
  --output-last-message <FILE>
  --reasoning-effort <EFFORT>
`);

    expect(capabilities).toEqual({
      supportsSearchFlag: true,
      supportsAskForApprovalFlag: false,
      supportsOutputLastMessageFlag: true,
      supportsReasoningEffortFlag: true,
      supportsReasoningFlag: false,
    });
  });

  test("builds minimal args when optional flags are unsupported", () => {
    const unsupported: CodexExecCapabilities = {
      supportsSearchFlag: false,
      supportsAskForApprovalFlag: false,
      supportsOutputLastMessageFlag: false,
      supportsReasoningEffortFlag: false,
      supportsReasoningFlag: false,
    };

    const args = buildCodexExecArgs({
      model: "gpt-5.4-mini",
      workspaceDir: "/tmp/workspace",
      outputPath: "/tmp/out.txt",
      enableWebSearch: true,
      reasoningEffort: "high",
      capabilities: unsupported,
    });

    expect(args).toEqual([
      "exec",
      "--model",
      "gpt-5.4-mini",
      "--cd",
      "/tmp/workspace",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-",
    ]);
  });

  test("includes supported optional flags", () => {
    const supported: CodexExecCapabilities = {
      supportsSearchFlag: true,
      supportsAskForApprovalFlag: true,
      supportsOutputLastMessageFlag: true,
      supportsReasoningEffortFlag: true,
      supportsReasoningFlag: false,
    };

    const args = buildCodexExecArgs({
      model: "gpt-5.4-mini",
      workspaceDir: "/tmp/workspace",
      outputPath: "/tmp/out.txt",
      enableWebSearch: true,
      reasoningEffort: "high",
      capabilities: supported,
    });

    expect(args).toEqual([
      "--search",
      "exec",
      "--model",
      "gpt-5.4-mini",
      "--cd",
      "/tmp/workspace",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--reasoning-effort",
      "high",
      "--ask-for-approval",
      "never",
      "--output-last-message",
      "/tmp/out.txt",
      "-",
    ]);
  });

  test("falls back to --reasoning when only legacy flag is supported", () => {
    const supportedLegacy: CodexExecCapabilities = {
      supportsSearchFlag: false,
      supportsAskForApprovalFlag: false,
      supportsOutputLastMessageFlag: false,
      supportsReasoningEffortFlag: false,
      supportsReasoningFlag: true,
    };

    const args = buildCodexExecArgs({
      model: "gpt-5.4-mini",
      workspaceDir: "/tmp/workspace",
      reasoningEffort: "high",
      capabilities: supportedLegacy,
    });

    expect(args).toContain("--reasoning");
    expect(args).toContain("high");
    expect(args).not.toContain("--reasoning-effort");
  });
});
