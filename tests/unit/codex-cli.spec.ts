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
`);

    expect(capabilities).toEqual({
      supportsSearchFlag: true,
      supportsAskForApprovalFlag: false,
      supportsOutputLastMessageFlag: true,
    });
  });

  test("builds minimal args when optional flags are unsupported", () => {
    const unsupported: CodexExecCapabilities = {
      supportsSearchFlag: false,
      supportsAskForApprovalFlag: false,
      supportsOutputLastMessageFlag: false,
    };

    const args = buildCodexExecArgs({
      model: "gpt-5.4-mini-high",
      workspaceDir: "/tmp/workspace",
      outputPath: "/tmp/out.txt",
      enableWebSearch: true,
      capabilities: unsupported,
    });

    expect(args).toEqual([
      "exec",
      "--model",
      "gpt-5.4-mini-high",
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
    };

    const args = buildCodexExecArgs({
      model: "gpt-5.4-mini-high",
      workspaceDir: "/tmp/workspace",
      outputPath: "/tmp/out.txt",
      enableWebSearch: true,
      capabilities: supported,
    });

    expect(args).toEqual([
      "--search",
      "exec",
      "--model",
      "gpt-5.4-mini-high",
      "--cd",
      "/tmp/workspace",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "--output-last-message",
      "/tmp/out.txt",
      "-",
    ]);
  });
});
