import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, type ConfigModel } from "../../src/config.js";
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

  // Helper: isolated harnessHome so tests don't pick up real ~/harness/config.json
  function opts(extra: Record<string, string> = {}) {
    const homeDir = path.join(tmpBase, "home");
    mkdirSync(homeDir, { recursive: true });
    return { cwd: tmpBase, homeDir, harnessHome: tmpBase, ...extra };
  }

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

    const result = await loadConfig({ cwd: foreignDir, homeDir, harnessHome: tmpBase });

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

    const result = await loadConfig({ cwd, homeDir, harnessHome: tmpBase });

    expect(result.models).toEqual(cwdModels);
    expect(result.source).toBe("cwd");
    expect(result.error).toBeUndefined();
  });

  it("falls back to default models with a visible warning when no config is found", async () => {
    const foreignDir = path.join(tmpBase, "nowhere");
    mkdirSync(foreignDir, { recursive: true });

    const homeDir = path.join(tmpBase, "empty_home");
    mkdirSync(homeDir, { recursive: true });

    const result = await loadConfig({ cwd: foreignDir, homeDir, harnessHome: tmpBase });

    expect(result.models).toEqual([
      { provider: "minimax", model: "MiniMax-M2.7", alias: "MiniMax M2.7" },
    ]);
    expect(result.source).toBeUndefined();
    expect(result.error).toContain("No config found");
  });

  it("merges provider defaults into models", async () => {
    const cwd = path.join(tmpBase, "project");
    mkdirSync(cwd, { recursive: true });

    const config = {
      providers: {
        neuralwatt: {
          type: "openai",
          baseUrl: "https://api.neuralwatt.com/v1",
          apiKey: "sk-test",
        },
      },
      models: [
        { provider: "neuralwatt", model: "kimi-k2.7-code", alias: "Kimi K2.7 Code" },
      ],
    };
    writeFileSync(path.join(cwd, "harness.config.json"), JSON.stringify(config));

    const result = await loadConfig({ cwd, harnessHome: tmpBase });

    expect(result.providers.neuralwatt?.baseUrl).toBe("https://api.neuralwatt.com/v1");
    expect(result.models[0]?.baseUrl).toBe("https://api.neuralwatt.com/v1");
    expect(result.models[0]?.apiKey).toBe("sk-test");
    expect(result.models[0]?.api).toBe("openai-completions");
  });

  it("expands environment variables in config values", async () => {
    process.env.HARNESS_TEST_API_KEY = "sk-from-env";
    const cwd = path.join(tmpBase, "project");
    mkdirSync(cwd, { recursive: true });

    const config = {
      providers: {
        neuralwatt: {
          type: "openai",
          baseUrl: "https://api.neuralwatt.com/v1",
          apiKey: "${HARNESS_TEST_API_KEY}",
        },
      },
      models: [
        { provider: "neuralwatt", model: "kimi-k2.7-code", alias: "Kimi K2.7 Code" },
      ],
    };
    writeFileSync(path.join(cwd, "harness.config.json"), JSON.stringify(config));

    const result = await loadConfig({ cwd, harnessHome: tmpBase });

    expect(result.providers.neuralwatt?.apiKey).toBe("sk-from-env");
    expect(result.models[0]?.apiKey).toBe("sk-from-env");

    delete process.env.HARNESS_TEST_API_KEY;
  });

  it("resolves env:VAR_NAME references", async () => {
    process.env.HARNESS_TEST_BRAVE_KEY = "sk-brave-env";
    const cwd = path.join(tmpBase, "project");
    mkdirSync(cwd, { recursive: true });

    const config = {
      web_search: {
        providers: [
          { type: "brave", apiKey: "env:HARNESS_TEST_BRAVE_KEY" },
        ],
      },
    };
    writeFileSync(path.join(cwd, "harness.config.json"), JSON.stringify(config));

    const result = await loadConfig({ cwd, harnessHome: tmpBase });

    const provider = result.webConfig.web_search?.providers?.[0];
    expect(provider && "apiKey" in provider ? provider.apiKey : undefined).toBe("sk-brave-env");

    delete process.env.HARNESS_TEST_BRAVE_KEY;
  });

  it("throws when env:VAR_NAME references a missing variable", async () => {
    delete process.env.HARNESS_TEST_MISSING_KEY;
    const cwd = path.join(tmpBase, "project");
    mkdirSync(cwd, { recursive: true });

    const config = {
      web_search: {
        providers: [
          { type: "tavily", apiKey: "env:HARNESS_TEST_MISSING_KEY" },
        ],
      },
    };
    writeFileSync(path.join(cwd, "harness.config.json"), JSON.stringify(config));

    await expect(loadConfig({ cwd, harnessHome: tmpBase })).rejects.toThrow(
      "Missing environment variable referenced by config: HARNESS_TEST_MISSING_KEY"
    );
  });

  it("returns a clear error for invalid JSON in a config file", async () => {
    const cwd = path.join(tmpBase, "project");
    mkdirSync(cwd, { recursive: true });

    writeFileSync(path.join(cwd, "harness.config.json"), "{ invalid json !!!");

    const result = await loadConfig({ cwd, homeDir: tmpBase, harnessHome: tmpBase });

    expect(result.models).toEqual([
      { provider: "minimax", model: "MiniMax-M2.7", alias: "MiniMax M2.7" },
    ]);
    expect(result.source).toBe("cwd");
    expect(result.error).toContain("Failed to parse config");
    expect(result.error).toContain("harness.config.json");
  });

  it("does not fall back to a later candidate when JSON is invalid", async () => {
    const cwd = path.join(tmpBase, "project");
    mkdirSync(cwd, { recursive: true });

    const homeDir = path.join(tmpBase, "home");
    const harnessDir = path.join(homeDir, ".harness");
    mkdirSync(harnessDir, { recursive: true });

    // CWD config has invalid JSON — should surface error, NOT skip to home config.
    writeFileSync(path.join(cwd, "harness.config.json"), "{ broken");
    const homeModels: ConfigModel[] = [
      { provider: "openai", model: "gpt-5.2", alias: "GPT 5.2" },
    ];
    writeFileSync(path.join(harnessDir, "config.json"), JSON.stringify({ models: homeModels }));

    const result = await loadConfig({ cwd, homeDir, harnessHome: tmpBase });

    expect(result.source).toBe("cwd");
    expect(result.error).toContain("Failed to parse config");
    // Should NOT have loaded the home config.
    expect(result.models).not.toEqual(homeModels);
  });

  it("returns defaultModel with merged provider defaults", async () => {
    const cwd = path.join(tmpBase, "project");
    mkdirSync(cwd, { recursive: true });

    const config = {
      providers: {
        neuralwatt: {
          type: "openai",
          baseUrl: "https://api.neuralwatt.com/v1",
          apiKey: "sk-test",
        },
      },
      models: [
        { provider: "neuralwatt", model: "kimi-k2.7-code", alias: "Kimi K2.7 Code" },
      ],
      defaultModel: {
        provider: "neuralwatt",
        model: "kimi-k2.7-code",
        alias: "Kimi K2.7 Code",
      },
    };
    writeFileSync(path.join(cwd, "harness.config.json"), JSON.stringify(config));

    const result = await loadConfig({ cwd, harnessHome: tmpBase });

    expect(result.defaultModel).toBeDefined();
    expect(result.defaultModel?.provider).toBe("neuralwatt");
    expect(result.defaultModel?.apiKey).toBe("sk-test");
  });
});
