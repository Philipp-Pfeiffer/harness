import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseCronJobFile,
  parseDurationMs,
  loadCronJobs,
  CronJobParseError,
} from "../../src/daemon/jobs.js";

let TEST_DIR: string;

beforeEach(async () => {
  TEST_DIR = await mkdtemp(join(tmpdir(), "harness-cron-jobs-"));
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

function jobFile(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n${body}\n`;
}

describe("parseDurationMs", () => {
  it("parses all supported units", () => {
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("15m")).toBe(900_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
  });

  it("rejects malformed durations", () => {
    expect(() => parseDurationMs("abc")).toThrow();
    expect(() => parseDurationMs("10")).toThrow();
    expect(() => parseDurationMs("5x")).toThrow();
    expect(() => parseDurationMs("")).toThrow();
  });
});

describe("parseCronJobFile", () => {
  it("parses a complete agent job file", () => {
    const job = parseCronJobFile(
      "/jobs/daily.md",
      jobFile(
        [
          "name: daily-summary",
          "schedule: 0 7 * * *",
          "enabled: true",
          "type: agent",
          "jitter: 2h",
        ].join("\n"),
        "Write the daily summary.",
      ),
    );
    expect(job).toMatchObject({
      name: "daily-summary",
      schedule: "0 7 * * *",
      enabled: true,
      type: "agent",
      jitterMs: 7_200_000,
      body: "Write the daily summary.",
      filePath: "/jobs/daily.md",
    });
  });

  it("parses a 6-field schedule with seconds", () => {
    const job = parseCronJobFile(
      "/jobs/fast.md",
      jobFile("name: fast\nschedule: */10 * * * * *\ntype: script", "metrics-rotation"),
    );
    expect(job.schedule).toBe("*/10 * * * * *");
  });

  it("defaults enabled to true and jitter to 0", () => {
    const job = parseCronJobFile(
      "/jobs/defaults.md",
      jobFile("name: d\nschedule: 0 0 * * *\ntype: script", "metrics-rotation"),
    );
    expect(job.enabled).toBe(true);
    expect(job.jitterMs).toBe(0);
  });

  it("parses enabled: false", () => {
    const job = parseCronJobFile(
      "/jobs/off.md",
      jobFile("name: off\nschedule: 0 0 * * *\nenabled: false\ntype: agent", "prompt"),
    );
    expect(job.enabled).toBe(false);
  });

  it("accepts quoted values", () => {
    const job = parseCronJobFile(
      "/jobs/quoted.md",
      jobFile('name: "quoted job"\nschedule: "0 0 * * *"\ntype: agent', "prompt"),
    );
    expect(job.name).toBe("quoted job");
    expect(job.schedule).toBe("0 0 * * *");
  });

  it("rejects an invalid cron schedule", () => {
    expect(() =>
      parseCronJobFile(
        "/jobs/bad.md",
        jobFile("name: bad\nschedule: not a cron\ntype: agent", "prompt"),
      ),
    ).toThrow(CronJobParseError);
  });

  it("rejects missing name, schedule and type", () => {
    expect(() =>
      parseCronJobFile("/jobs/a.md", jobFile("schedule: 0 0 * * *\ntype: agent", "x")),
    ).toThrow(/name/);
    expect(() =>
      parseCronJobFile("/jobs/b.md", jobFile("name: b\ntype: agent", "x")),
    ).toThrow(/schedule/);
    expect(() =>
      parseCronJobFile("/jobs/c.md", jobFile("name: c\nschedule: 0 0 * * *", "x")),
    ).toThrow(/type/);
  });

  it("rejects an unknown type", () => {
    expect(() =>
      parseCronJobFile(
        "/jobs/t.md",
        jobFile("name: t\nschedule: 0 0 * * *\ntype: webhook", "x"),
      ),
    ).toThrow(CronJobParseError);
  });

  it("rejects invalid enabled and jitter values", () => {
    expect(() =>
      parseCronJobFile(
        "/jobs/e.md",
        jobFile("name: e\nschedule: 0 0 * * *\nenabled: maybe\ntype: agent", "x"),
      ),
    ).toThrow(/enabled/);
    expect(() =>
      parseCronJobFile(
        "/jobs/j.md",
        jobFile("name: j\nschedule: 0 0 * * *\njitter: forever\ntype: agent", "x"),
      ),
    ).toThrow(/duration/);
  });

  it("rejects missing frontmatter and empty body", () => {
    expect(() => parseCronJobFile("/jobs/plain.md", "just text")).toThrow(
      CronJobParseError,
    );
    expect(() =>
      parseCronJobFile("/jobs/empty.md", jobFile("name: e\nschedule: 0 0 * * *\ntype: agent", "")),
    ).toThrow(/body/);
  });

  it("parses the optional agent profile field", () => {
    const job = parseCronJobFile(
      "/jobs/profiled.md",
      jobFile(
        "name: p\nschedule: 0 0 * * *\ntype: agent\nagent: distillation",
        "prompt",
      ),
    );
    expect(job.agent).toBe("distillation");
  });

  it("defaults agent to undefined when absent", () => {
    const job = parseCronJobFile(
      "/jobs/plain-agent.md",
      jobFile("name: p\nschedule: 0 0 * * *\ntype: agent", "prompt"),
    );
    expect(job.agent).toBeUndefined();
  });

  it("rejects an invalid agent profile name", () => {
    expect(() =>
      parseCronJobFile(
        "/jobs/bad-agent.md",
        jobFile("name: p\nschedule: 0 0 * * *\ntype: agent\nagent: Not A Profile", "prompt"),
      ),
    ).toThrow(/invalid agent/);
  });

  it("parses once: true", () => {
    const job = parseCronJobFile(
      "/jobs/once.md",
      jobFile("name: once\nschedule: 0 0 * * *\ntype: agent\nonce: true", "prompt"),
    );
    expect(job.once).toBe(true);
  });

  it("parses once: false", () => {
    const job = parseCronJobFile(
      "/jobs/once-false.md",
      jobFile("name: once-false\nschedule: 0 0 * * *\ntype: agent\nonce: false", "prompt"),
    );
    expect(job.once).toBe(false);
  });

  it("defaults once to undefined when absent", () => {
    const job = parseCronJobFile(
      "/jobs/no-once.md",
      jobFile("name: no-once\nschedule: 0 0 * * *\ntype: agent", "prompt"),
    );
    expect(job.once).toBeUndefined();
  });

  it("rejects an invalid once value", () => {
    expect(() =>
      parseCronJobFile(
        "/jobs/bad-once.md",
        jobFile("name: bad\nschedule: 0 0 * * *\ntype: agent\nonce: maybe", "x"),
      ),
    ).toThrow(/once/);
  });
});

describe("loadCronJobs", () => {
  it("loads valid jobs and reports broken files without throwing", async () => {
    await writeFile(
      join(TEST_DIR, "good.md"),
      jobFile("name: good\nschedule: 0 0 * * *\ntype: script", "metrics-rotation"),
    );
    await writeFile(join(TEST_DIR, "broken.md"), "no frontmatter here");
    await writeFile(join(TEST_DIR, "ignored.txt"), "not a markdown file");

    const result = await loadCronJobs(TEST_DIR);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.name).toBe("good");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("broken.md");
  });

  it("returns empty result for a missing directory", async () => {
    const result = await loadCronJobs(join(TEST_DIR, "does-not-exist"));
    expect(result.jobs).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
