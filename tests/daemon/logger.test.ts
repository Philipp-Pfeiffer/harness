import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaemonLogger } from "../../src/daemon/logger.js";

const TEST_DIR = join(tmpdir(), `harness-logger-test-${process.pid}-${Date.now()}`);

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("DaemonLogger", () => {
  it("creates log directory on init", async () => {
    const logDir = join(TEST_DIR, "logs");
    const logger = new DaemonLogger({ logDir });
    await logger.init();
    const files = await readdir(logDir);
    expect(files).toHaveLength(0); // no logs written yet
  });

  it("writes JSON-line entries to daily log file", async () => {
    const logDir = join(TEST_DIR, "logs");
    const logger = new DaemonLogger({ logDir });
    await logger.init();

    logger.info("test message", { key: "value" });

    // Wait for fire-and-forget write
    await new Promise((r) => setTimeout(r, 50));

    const dateKey = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(logDir, `daemon-${dateKey}.log`), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe("info");
    expect(entry.component).toBe("daemon");
    expect(entry.msg).toBe("test message");
    expect(entry.data).toEqual({ key: "value" });
    expect(typeof entry.ts).toBe("string");
  });

  it("respects minLevel filtering", async () => {
    const logDir = join(TEST_DIR, "logs");
    const logger = new DaemonLogger({ logDir, minLevel: "warn" });
    await logger.init();

    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    await new Promise((r) => setTimeout(r, 50));

    const dateKey = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(logDir, `daemon-${dateKey}.log`), "utf-8");
    const entries = content.trim().split("\n").map((l) => JSON.parse(l));

    expect(entries).toHaveLength(2);
    expect(entries[0].level).toBe("warn");
    expect(entries[1].level).toBe("error");
  });

  it("child logger uses component name", async () => {
    const logDir = join(TEST_DIR, "logs");
    const logger = new DaemonLogger({ logDir });
    await logger.init();

    const child = logger.child("gateway");
    child.info("gateway starting");

    await new Promise((r) => setTimeout(r, 50));

    const dateKey = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(logDir, `daemon-${dateKey}.log`), "utf-8");
    const entry = JSON.parse(content.trim());

    expect(entry.component).toBe("gateway");
    expect(entry.msg).toBe("gateway starting");
  });

  it("cleanup removes old log files", async () => {
    const logDir = join(TEST_DIR, "logs");
    const logger = new DaemonLogger({ logDir, retentionDays: 1 });
    await logger.init();

    // Write a file with an old date
    const oldDate = "2020-01-01";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(logDir, `daemon-${oldDate}.log`), '{"ts":"2020-01-01T00:00:00Z","level":"info","component":"daemon","msg":"old"}\n');

    // Also write today's file
    logger.info("today's message");
    await new Promise((r) => setTimeout(r, 50));

    await logger.cleanup();

    const files = await readdir(logDir);
    const oldFile = files.find((f) => f.includes("2020-01-01"));
    expect(oldFile).toBeUndefined();

    // Today's file should still exist
    const todayKey = new Date().toISOString().slice(0, 10);
    expect(files).toContain(`daemon-${todayKey}.log`);
  });

  it("never throws on write failure", async () => {
    const logDir = join(TEST_DIR, "readonly");
    const { mkdir, chmod } = await import("node:fs/promises");
    await mkdir(logDir, { recursive: true });
    await chmod(logDir, 0o444);

    const logger = new DaemonLogger({ logDir });
    await logger.init(); // should not throw
    logger.info("test"); // should not throw

    await new Promise((r) => setTimeout(r, 50));
    await chmod(logDir, 0o755);
  });
});
