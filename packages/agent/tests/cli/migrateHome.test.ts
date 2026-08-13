import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { migrateHome } from "../../src/cli/migrateHome.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("migrateHome", () => {
  let projectRoot: string;
  let homeDir: string;
  let stateDir: string;
  let logs: string[];

  beforeEach(() => {
    resetEnv();
    projectRoot = mkdtempSync(join(tmpdir(), "harness-migrate-cwd-"));
    homeDir = mkdtempSync(join(tmpdir(), "harness-migrate-home-"));
    stateDir = mkdtempSync(join(tmpdir(), "harness-migrate-state-"));
    process.env.HARNESS_HOME = homeDir;
    process.env.HARNESS_STATE = stateDir;
    logs = [];
  });

  afterEach(() => {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
    try { rmSync(homeDir, { recursive: true, force: true }); } catch {}
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
  });

  it("dry-run shows planned moves without executing", async () => {
    // Create legacy files
    writeFileSync(resolve(projectRoot, "core.md"), "# Core");
    mkdirSync(resolve(projectRoot, "memory"), { recursive: true });

    const result = await migrateHome(true, projectRoot, (msg) => logs.push(msg));

    expect(result.dryRun).toBe(true);
    expect(result.moved).toEqual([]);
    // Source files still exist
    expect(existsSync(resolve(projectRoot, "core.md"))).toBe(true);
    expect(existsSync(resolve(projectRoot, "memory"))).toBe(true);

    // Log mentions dry run
    expect(logs.join("\n")).toContain("Dry run");
    expect(logs.join("\n")).toContain("core.md");
  });

  it("moves core.md to HARNESS_HOME", async () => {
    writeFileSync(resolve(projectRoot, "core.md"), "# Core Memory");

    const result = await migrateHome(false, projectRoot, () => {});

    expect(result.moved).toContain("core.md");
    expect(existsSync(resolve(projectRoot, "core.md"))).toBe(false);
    expect(existsSync(resolve(homeDir, "core.md"))).toBe(true);
  });

  it("moves memory/ directory to HARNESS_HOME/memory", async () => {
    mkdirSync(resolve(projectRoot, "memory"), { recursive: true });
    writeFileSync(resolve(projectRoot, "memory", "note.md"), "# Note");

    const result = await migrateHome(false, projectRoot, () => {});

    expect(result.moved).toContain("memory/");
    expect(existsSync(resolve(projectRoot, "memory"))).toBe(false);
    expect(existsSync(resolve(homeDir, "memory", "note.md"))).toBe(true);
  });

  it("moves harness.config.json to HARNESS_HOME/config.json", async () => {
    writeFileSync(resolve(projectRoot, "harness.config.json"), '{"models":[]}');

    const result = await migrateHome(false, projectRoot, () => {});

    expect(result.moved).toContain("harness.config.json → config.json");
    expect(existsSync(resolve(projectRoot, "harness.config.json"))).toBe(false);
    expect(existsSync(resolve(homeDir, "config.json"))).toBe(true);
  });

  it("detects legacy .qmd index and flags for reindex", async () => {
    mkdirSync(resolve(projectRoot, ".qmd"), { recursive: true });
    writeFileSync(resolve(projectRoot, ".qmd", "index.sqlite"), "fake");

    const result = await migrateHome(false, projectRoot, () => {});

    expect(result.indexNeedsRebuild).toBe(true);
    // Index NOT moved
    expect(existsSync(resolve(projectRoot, ".qmd", "index.sqlite"))).toBe(true);
    expect(existsSync(resolve(stateDir, "index", "index.sqlite"))).toBe(false);
  });

  it("is idempotent — second run does nothing", async () => {
    writeFileSync(resolve(projectRoot, "core.md"), "# Core");

    await migrateHome(false, projectRoot, () => {});
    const result2 = await migrateHome(false, projectRoot, (msg) => logs.push(msg));

    expect(result2.moved).toEqual([]);
    expect(logs.join("\n")).toContain("Nothing to migrate");
  });

  it("does not overwrite when target already exists", async () => {
    // Pre-create target
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(resolve(homeDir, "core.md"), "# Existing core");

    // Source also exists
    writeFileSync(resolve(projectRoot, "core.md"), "# Legacy core");

    const result = await migrateHome(false, projectRoot, () => {});

    // Target preserved
    expect(existsSync(resolve(homeDir, "core.md"))).toBe(true);
    // Source also preserved (not moved because target existed)
    expect(existsSync(resolve(projectRoot, "core.md"))).toBe(true);
    expect(result.moved).not.toContain("core.md");
  });
});
