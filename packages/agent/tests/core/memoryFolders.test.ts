import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveHarnessPaths, ensureDirs } from "@harness/core";
import { ensureInbox, resolveMemoryConfig } from "../../src/core/memoryFolders.js";
import { rm, access, readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("memoryFolders (legacy compat)", () => {
  beforeEach(() => resetEnv());

  it("resolveMemoryConfig delegates to resolveHarnessPaths", () => {
    process.env.HARNESS_HOME = "/custom/home";
    delete process.env.HARNESS_STATE;
    delete process.env.XDG_STATE_HOME;

    const config = resolveMemoryConfig();
    expect(config.memoryPath).toBe("/custom/home/memory");
    expect(config.sourcesPath).toBe("/custom/home/sources");
    expect(config.inboxPath).toBe("/custom/home/memory/_inbox.md");
  });

  it("resolveMemoryConfig falls back to ~/harness when no env", () => {
    delete process.env.HARNESS_HOME;
    delete process.env.HARNESS_STATE;
    delete process.env.XDG_STATE_HOME;

    const config = resolveMemoryConfig();
    expect(config.memoryPath).toBe(join(process.env.HOME ?? "/home/user", "harness", "memory"));
  });
});

describe("ensureInbox", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = resolve(tmpdir(), `harness-inbox-${Date.now()}`);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("creates inbox file with default header when missing", async () => {
    const inboxPath = resolve(baseDir, "memory", "_inbox.md");
    await mkdir(resolve(baseDir, "memory"), { recursive: true });

    await ensureInbox(inboxPath);

    const content = await readFile(inboxPath, "utf-8");
    expect(content).toContain("# Inbox");
  });

  it("does not overwrite existing inbox", async () => {
    const inboxPath = resolve(baseDir, "memory", "_inbox.md");
    await mkdir(resolve(baseDir, "memory"), { recursive: true });
    await readFile;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(inboxPath, "existing content", "utf-8");

    await ensureInbox(inboxPath);

    const content = await readFile(inboxPath, "utf-8");
    expect(content).toBe("existing content");
  });

  it("end-to-end: ensureDirs + ensureInbox creates full structure", async () => {
    const paths = resolveHarnessPaths({ home: join(baseDir, "home") });
    // Override state to keep everything under baseDir
    const customPaths = { ...paths, state: join(baseDir, "state") };

    await ensureDirs(customPaths);
    await ensureInbox(customPaths.inbox);

    // All dirs exist
    await access(customPaths.memory);
    await access(customPaths.sources);
    await access(customPaths.sessions);
    await access(customPaths.metrics);
    await access(customPaths.index);

    // Inbox file exists
    const inboxContent = await readFile(customPaths.inbox, "utf-8");
    expect(inboxContent).toContain("# Inbox");

    // Idempotent
    await ensureDirs(customPaths);
    await ensureInbox(customPaths.inbox);
  });
});
