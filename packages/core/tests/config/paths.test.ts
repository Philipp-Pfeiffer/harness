import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { resolveHarnessPaths, ensureDirs } from "../../src/config/paths.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

beforeEach(() => {
  resetEnv();
});

describe("resolveHarnessPaths", () => {
  it("defaults home to ~/harness and state to ~/.harness", () => {
    delete process.env.HARNESS_HOME;
    delete process.env.HARNESS_STATE;
    delete process.env.XDG_STATE_HOME;

    const paths = resolveHarnessPaths();
    expect(paths.home).toBe(join(process.env.HOME ?? "/home/user", "harness"));
    expect(paths.state).toBe(join(process.env.HOME ?? "/home/user", ".harness"));
  });

  it("uses HARNESS_HOME env when set", () => {
    process.env.HARNESS_HOME = "/custom/home";
    delete process.env.HARNESS_STATE;
    delete process.env.XDG_STATE_HOME;

    const paths = resolveHarnessPaths();
    expect(paths.home).toBe("/custom/home");
  });

  it("uses HARNESS_STATE env when set", () => {
    process.env.HARNESS_HOME = "/custom/home";
    process.env.HARNESS_STATE = "/custom/state";

    const paths = resolveHarnessPaths();
    expect(paths.state).toBe("/custom/state");
  });

  it("falls back to XDG_STATE_HOME/harness when set", () => {
    process.env.HARNESS_HOME = "/custom/home";
    delete process.env.HARNESS_STATE;
    process.env.XDG_STATE_HOME = "/xdg/state";

    const paths = resolveHarnessPaths();
    expect(paths.state).toBe("/xdg/state/harness");
  });

  it("defaults do not resolve to cwd or repo", () => {
    delete process.env.HARNESS_HOME;
    delete process.env.HARNESS_STATE;
    delete process.env.XDG_STATE_HOME;

    const paths = resolveHarnessPaths();
    const cwd = process.cwd();

    // HOME must not be under cwd
    expect(paths.home).not.toBe(cwd);
    expect(paths.home.startsWith(cwd + "/")).toBe(false);
    // STATE must not be under cwd
    expect(paths.state).not.toBe(cwd);
    expect(paths.state.startsWith(cwd + "/")).toBe(false);
    // QMD index must not be in <cwd>/.qmd
    expect(paths.index).not.toBe(join(cwd, ".qmd"));
    // Memory must not be <cwd>/memory
    expect(paths.memory).not.toBe(join(cwd, "memory"));
  });

  it("opts.home takes precedence over env", () => {
    process.env.HARNESS_HOME = "/env/home";
    delete process.env.HARNESS_STATE;
    delete process.env.XDG_STATE_HOME;

    const paths = resolveHarnessPaths({ home: "/opt/home" });
    expect(paths.home).toBe("/opt/home");
    // state still resolved independently
    expect(paths.state).toBe(join(process.env.HOME ?? "/home/user", ".harness"));
  });

  it("opts.state takes precedence over env", () => {
    process.env.HARNESS_HOME = "/env/home";
    process.env.HARNESS_STATE = "/env/state";
    process.env.XDG_STATE_HOME = "/xdg/state";

    const paths = resolveHarnessPaths({ state: "/opt/state" });
    expect(paths.state).toBe("/opt/state");
    // home still resolved independently
    expect(paths.home).toBe("/env/home");
  });

  it("opts.state ignores HARNESS_STATE and XDG_STATE_HOME", () => {
    process.env.HARNESS_STATE = "/env/state";
    process.env.XDG_STATE_HOME = "/xdg/state";

    const paths = resolveHarnessPaths({ home: "/opt/home", state: "/opt/state" });
    expect(paths.state).toBe("/opt/state");
    expect(paths.sessions).toBe("/opt/state/sessions");
  });

  it("derives all subpaths correctly", () => {
    process.env.HARNESS_HOME = "/h";
    process.env.HARNESS_STATE = "/s";

    const paths = resolveHarnessPaths();
    expect(paths.core).toBe("/h/core.md");
    expect(paths.agents).toBe("/h/AGENTS.md");
    expect(paths.config).toBe("/h/config.json");
    expect(paths.memory).toBe("/h/memory");
    expect(paths.inbox).toBe("/h/memory/_inbox.md");
    expect(paths.sources).toBe("/h/sources");
    expect(paths.skills).toBe("/h/skills");
    expect(paths.sessions).toBe("/s/sessions");
    expect(paths.metrics).toBe("/s/metrics");
    expect(paths.index).toBe("/s/index");
    expect(paths.logs).toBe("/s/logs");
    expect(paths.jobs).toBe("/s/jobs");
    expect(paths.pidFile).toBe("/s/daemon.pid");
    expect(paths.socketFile).toBe("/s/daemon.sock");
  });
});

describe("ensureDirs", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "harness-paths-test-"));
  });

  afterEach(() => {
    try {
      rmdirSync(baseDir, { recursive: true });
    } catch {
      // ignore cleanup failures
    }
  });

  it("creates all directories idempotently", async () => {
    const paths = resolveHarnessPaths({ home: join(baseDir, "home") });
    // Override state manually to keep it inside baseDir
    const customPaths = { ...paths, state: join(baseDir, "state") };

    await ensureDirs(customPaths);

    const dirs = [
      customPaths.memory,
      customPaths.sources,
      customPaths.skills,
      customPaths.sessions,
      customPaths.metrics,
      customPaths.index,
      customPaths.logs,
      customPaths.jobs,
    ];

    for (const dir of dirs) {
      const s = await stat(dir);
      expect(s.isDirectory()).toBe(true);
    }

    // Idempotent second call must not throw
    await ensureDirs(customPaths);
  });
});
