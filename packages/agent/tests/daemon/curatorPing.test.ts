/**
 * Tests for: curator-ping script job (system event bus ping after a
 * stage-2 curator run).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveHarnessPaths, type HarnessPaths } from "@harness/core";

import {
  buildCuratorPingText,
  parseProposalCount,
} from "../../src/daemon/curatorPing.js";
import { DaemonLogger } from "../../src/daemon/logger.js";
import { getScriptJob } from "../../src/daemon/scripts.js";

let TEST_DIR: string;
let paths: HarnessPaths;
let logger: DaemonLogger;

beforeEach(async () => {
  TEST_DIR = await mkdtemp(join(tmpdir(), "harness-curator-ping-"));
  process.env.HARNESS_HOME = join(TEST_DIR, "home");
  process.env.HARNESS_STATE = join(TEST_DIR, "state");
  paths = resolveHarnessPaths();
  logger = new DaemonLogger({ logDir: join(TEST_DIR, "logs") });
  await logger.init();
});

afterEach(async () => {
  restoreEnv();
  await rm(TEST_DIR, { recursive: true, force: true });
});

const ORIGINAL_ENV = {
  HARNESS_HOME: process.env.HARNESS_HOME,
  HARNESS_STATE: process.env.HARNESS_STATE,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function writeReport(date: string, body: string): Promise<void> {
  await mkdir(join(paths.state, "curator", "reports"), { recursive: true });
  await writeFile(join(paths.state, "curator", "reports", `${date}.md`), body);
}

const REPORT_BODY = `# Curator Report

1. [typ: skill-create]
   Vorschlag eins.
   Beleg: b1. Risiko: r1.
2. [typ: frage]
   Frage zwei.
   Beleg: b2. Risiko: r2.
`;

/** Fixed local clock for deterministic freshness tests. */
const FIXED_NOW = () => new Date(2026, 7, 12, 4, 50); // 2026-08-12 04:50 local
const TODAY = "2026-08-12";
const YESTERDAY = "2026-08-11";

describe("parseProposalCount", () => {
  it("counts numbered proposal lines with typ tags", () => {
    expect(parseProposalCount(REPORT_BODY)).toBe(2);
  });

  it("ignores unnumbered lines, inline numbers and non-typ brackets", () => {
    const body = [
      "# Curator Report",
      "1. [typ: skill-create]",
      "   Beleg: x.",
      "3. [typ: frage]",
      "10. [typ: skill-merge]",
      "42 [typ: skill-create] (no dot)",
      "5. [irgendwas: skill-create]",
      "6. [typ: memory-fix] Vorschlag.",
    ].join("\n");
    expect(parseProposalCount(body)).toBe(4);
  });

  it("returns 0 for empty content", () => {
    expect(parseProposalCount("")).toBe(0);
    expect(parseProposalCount("no proposals here")).toBe(0);
  });
});

describe("buildCuratorPingText", () => {
  it("builds metadata-only text from the newest report", async () => {
    await writeReport(YESTERDAY, REPORT_BODY);
    await writeReport(TODAY, REPORT_BODY);

    const text = await buildCuratorPingText(paths.state, logger, { now: FIXED_NOW });
    expect(text).toBe(
      "Curator-Report fertig: 2 Vorschläge, Pfad ~/.harness/curator/reports/2026-08-12.md (2026-08-12)",
    );
  });

  it("returns null when no reports exist", async () => {
    const text = await buildCuratorPingText(paths.state, logger, { now: FIXED_NOW });
    expect(text).toBeNull();
  });

  it("returns null when the newest report has no proposals", async () => {
    await writeReport(TODAY, "# Curator Report\n\nKeine Vorschläge.\n");
    const text = await buildCuratorPingText(paths.state, logger, { now: FIXED_NOW });
    expect(text).toBeNull();
  });

  it("returns null when the newest report is stale (yesterday)", async () => {
    await writeReport(YESTERDAY, REPORT_BODY);
    const text = await buildCuratorPingText(paths.state, logger, { now: FIXED_NOW });
    expect(text).toBeNull();
  });

  it("pings a today report even when an older one has proposals", async () => {
    await writeReport(YESTERDAY, REPORT_BODY);
    await writeReport(TODAY, REPORT_BODY);
    const text = await buildCuratorPingText(paths.state, logger, { now: FIXED_NOW });
    expect(text).toContain("2026-08-12");
  });

  it("picks the newest report even when an older one has proposals", async () => {
    await writeReport("2026-08-11", REPORT_BODY);
    await writeReport(TODAY, "# Leerer Report\n");
    const text = await buildCuratorPingText(paths.state, logger, { now: FIXED_NOW });
    expect(text).toBeNull();
  });
});

describe("curator-ping script job", () => {
  it("is registered and injects via the context", async () => {
    const fn = getScriptJob("curator-ping");
    expect(fn).toBeTypeOf("function");

    await writeReport(TODAY, REPORT_BODY);
    const events: { origin: string; text: string }[] = [];
    await fn!({
      paths,
      logger: logger.child("cron-script"),
      retentionDays: 14,
      now: FIXED_NOW,
      injectEvent: async (event) => {
        events.push(event);
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.origin).toBe("Curator");
    expect(events[0]!.text).toContain("2 Vorschläge");
    expect(events[0]!.text).toContain("~/.harness/curator/reports/2026-08-12.md");
  });

  it("does not inject when no report exists", async () => {
    const fn = getScriptJob("curator-ping")!;
    const events: { origin: string; text: string }[] = [];
    await fn({
      paths,
      logger: logger.child("cron-script"),
      retentionDays: 14,
      now: FIXED_NOW,
      injectEvent: async (event) => {
        events.push(event);
      },
    });
    expect(events).toHaveLength(0);
  });

  it("does not inject when the report is empty of proposals", async () => {
    const fn = getScriptJob("curator-ping")!;
    await writeReport(TODAY, "# Curator Report\n");
    const events: { origin: string; text: string }[] = [];
    await fn({
      paths,
      logger: logger.child("cron-script"),
      retentionDays: 14,
      now: FIXED_NOW,
      injectEvent: async (event) => {
        events.push(event);
      },
    });
    expect(events).toHaveLength(0);
  });

  it("does not inject when the newest report is stale", async () => {
    const fn = getScriptJob("curator-ping")!;
    await writeReport(YESTERDAY, REPORT_BODY);
    const events: { origin: string; text: string }[] = [];
    await fn({
      paths,
      logger: logger.child("cron-script"),
      retentionDays: 14,
      now: FIXED_NOW,
      injectEvent: async (event) => {
        events.push(event);
      },
    });
    expect(events).toHaveLength(0);
  });
});
