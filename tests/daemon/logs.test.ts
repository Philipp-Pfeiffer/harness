import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(
  tmpdir(),
  `harness-logs-test-${process.pid}-${Date.now()}`,
);

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("daemonLogs", () => {
  it("reports no log files when logs dir is empty", async () => {
    const { daemonLogs } = await import("../../src/daemon/commands.js");
    process.env.HARNESS_STATE = TEST_DIR;
    const result = await daemonLogs();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No daemon log");
    delete process.env.HARNESS_STATE;
  });

  it("tails the most recent log file", async () => {
    const logsDir = join(TEST_DIR, "logs");
    await mkdir(logsDir, { recursive: true });

    // Write two dated log files
    const oldFile = join(logsDir, "daemon-2026-07-10.log");
    const newFile = join(logsDir, "daemon-2026-07-11.log");
    await writeFile(oldFile, "old line 1\nold line 2\n", "utf-8");
    const lines: string[] = [];
    for (let i = 1; i <= 150; i++) lines.push(`line ${i}`);
    await writeFile(newFile, lines.join("\n") + "\n", "utf-8");

    const { daemonLogs } = await import("../../src/daemon/commands.js");
    process.env.HARNESS_STATE = TEST_DIR;
    const result = await daemonLogs();
    delete process.env.HARNESS_STATE;

    expect(result.exitCode).toBe(0);
    // Should read the most recent file
    expect(result.stdout).toContain("daemon-2026-07-11.log");
    // Should show last 100 lines (out of 150)
    expect(result.stdout).toContain("line 51");
    expect(result.stdout).toContain("line 150");
    expect(result.stdout).not.toContain("line 50");
  });

  it("handles missing logs directory gracefully", async () => {
    const { daemonLogs } = await import("../../src/daemon/commands.js");
    process.env.HARNESS_STATE = join(TEST_DIR, "nonexistent");
    const result = await daemonLogs();
    delete process.env.HARNESS_STATE;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No daemon log");
  });
});
