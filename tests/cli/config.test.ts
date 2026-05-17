import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, type ConfigModel } from "../../src/cli/config.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("loadConfig", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(path.join(tmpdir(), "harness-config-test-"));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("finds user config in ~/.harness when started from a foreign directory", async () => {
    const foreignDir = path.join(tmpBase, "foreign");
    mkdirSync(foreignDir, { recursive: true });

    const homeDir = path.join(tmpBase, "home");
    const harnessDir = path.join(homeDir, ".harness");
    mkdirSync(harnessDir, { recursive: true });

    const userModels: ConfigModel[] = [
      { provider: "openai", model: "gpt-5.2", alias: "GPT 5.2" },
    ];
    writeFileSync(path.join(harnessDir, "config.json"), JSON.stringify({ models: userModels }));

    const result = await loadConfig({ cwd: foreignDir, homeDir });

    expect(result.models).toEqual(userModels);
    expect(result.source).toBe("home");
    expect(result.error).toBeUndefined();
  });

  it("prefers CWD config over user-default config", async () => {
    const cwd = path.join(tmpBase, "project");
    mkdirSync(cwd, { recursive: true });

    const homeDir = path.join(tmpBase, "home");
    const harnessDir = path.join(homeDir, ".harness");
    mkdirSync(harnessDir, { recursive: true });

    const cwdModels: ConfigModel[] = [
      { provider: "minimax", model: "MiniMax-M2.7", alias: "MiniMax M2.7" },
    ];
    const homeModels: ConfigModel[] = [
      { provider: "openai", model: "gpt-5.2", alias: "GPT 5.2" },
    ];

    writeFileSync(path.join(cwd, "harness.config.json"), JSON.stringify({ models: cwdModels }));
    writeFileSync(path.join(harnessDir, "config.json"), JSON.stringify({ models: homeModels }));

    const result = await loadConfig({ cwd, homeDir });

    expect(result.models).toEqual(cwdModels);
    expect(result.source).toBe("cwd");
    expect(result.error).toBeUndefined();
  });

  it("falls back to default models with a visible warning when no config is found", async () => {
    const foreignDir = path.join(tmpBase, "nowhere");
    mkdirSync(foreignDir, { recursive: true });

    const homeDir = path.join(tmpBase, "empty_home");
    mkdirSync(homeDir, { recursive: true });

    const result = await loadConfig({ cwd: foreignDir, homeDir });

    expect(result.models).toEqual([
      { provider: "minimax", model: "MiniMax-M2.7", alias: "MiniMax M2.7" },
    ]);
    expect(result.source).toBeUndefined();
    expect(result.error).toContain("No config found");
  });
});
