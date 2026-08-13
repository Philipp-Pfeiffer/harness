/**
 * voiceOutbound Tests — daemon-side registry gate + rate limit.
 *
 * Verifies:
 * - Registry loading: valid, missing, corrupt JSON, wrong shape
 * - Number normalization in registry contacts
 * - findRegistryContact (digits-only matching)
 * - Rate limit: first call ok, second within window rejected with wait time
 * - Rate limit persistence (restart-safe): state survives a reload
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadVoiceRegistry,
  findRegistryContact,
  checkAndRecordRateLimit,
  clearRateLimit,
  normalizeVoiceNumber,
  OUTBOUND_RATE_LIMIT_WINDOW_MS,
} from "../../src/daemon/voiceOutbound.js";
import { resolveVoiceContact } from "../../src/daemon/voiceRegistry.js";

const TEST_DIR = join(tmpdir(), `harness-voiceoutbound-test-${process.pid}-${Date.now()}`);
const REGISTRY = join(TEST_DIR, "voice-registry.json");
const RATELIMIT = join(TEST_DIR, "voice-ratelimit.json");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("normalizeVoiceNumber", () => {
  it("strips non-digits", () => {
    expect(normalizeVoiceNumber("+49 151 10619636")).toBe("4915110619636");
  });
});

describe("loadVoiceRegistry", () => {
  it("loads a valid registry and normalizes contact numbers", async () => {
    await writeFile(
      REGISTRY,
      JSON.stringify({
        contacts: [
          { number: "+49 151 10619636", name: "Philipp", note: "Betreiber" },
        ],
      }),
      "utf-8",
    );
    const result = await loadVoiceRegistry(REGISTRY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contacts).toEqual([
        { number: "4915110619636", name: "Philipp", note: "Betreiber" },
      ]);
    }
  });

  it("is fail-closed when the file is missing", async () => {
    const result = await loadVoiceRegistry(REGISTRY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("fail-closed");
  });

  it("is fail-closed when the JSON is corrupt", async () => {
    await writeFile(REGISTRY, "{ not valid json", "utf-8");
    const result = await loadVoiceRegistry(REGISTRY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("fail-closed");
  });

  it("is fail-closed when contacts is missing", async () => {
    await writeFile(REGISTRY, JSON.stringify({ other: [] }), "utf-8");
    const result = await loadVoiceRegistry(REGISTRY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("contacts");
  });

  it("is valid (but empty) for an empty contacts array — no call allowed", async () => {
    await writeFile(REGISTRY, JSON.stringify({ contacts: [] }), "utf-8");
    const result = await loadVoiceRegistry(REGISTRY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contacts).toEqual([]);
  });

  it("skips contacts without a number string", async () => {
    await writeFile(
      REGISTRY,
      JSON.stringify({ contacts: [{ name: "no number" }, { number: "4915110619636" }] }),
      "utf-8",
    );
    const result = await loadVoiceRegistry(REGISTRY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contacts).toEqual([{ number: "4915110619636" }]);
  });
});

describe("findRegistryContact", () => {
  it("matches a digits-only number against normalized contacts", () => {
    const contacts = [{ number: "4915110619636", name: "Philipp" }];
    expect(findRegistryContact(contacts, "+49 151 10619636")?.name).toBe("Philipp");
    expect(findRegistryContact(contacts, "4915110619636")?.name).toBe("Philipp");
    expect(findRegistryContact(contacts, "4915110610000")).toBeUndefined();
  });
});

describe("checkAndRecordRateLimit", () => {
  it("allows the first call and persists the timestamp", async () => {
    const now = 1_000_000;
    const first = await checkAndRecordRateLimit(RATELIMIT, "4915110619636", now);
    expect(first.ok).toBe(true);

    // State file exists and contains the timestamp.
    const raw = await import("node:fs/promises").then((m) => m.readFile(RATELIMIT, "utf-8"));
    const state = JSON.parse(raw);
    expect(state["4915110619636"]).toBe(now);
  });

  it("rejects a second call within the window with a wait time", async () => {
    const now = 1_000_000;
    await checkAndRecordRateLimit(RATELIMIT, "4915110619636", now);

    const second = await checkAndRecordRateLimit(RATELIMIT, "4915110619636", now + 60_000);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toContain("Rate-Limit");
      expect(second.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("allows a call after the window has elapsed", async () => {
    const now = 1_000_000;
    await checkAndRecordRateLimit(RATELIMIT, "4915110619636", now);

    const later = await checkAndRecordRateLimit(
      RATELIMIT,
      "4915110619636",
      now + OUTBOUND_RATE_LIMIT_WINDOW_MS + 1,
    );
    expect(later.ok).toBe(true);
  });

  it("persists state restart-safe across a fresh read", async () => {
    const now = 1_000_000;
    await checkAndRecordRateLimit(RATELIMIT, "4915110619636", now);

    // A "restart" is modeled by calling again without the in-memory state —
    // checkAndRecordRateLimit always re-reads the file, so this IS the restart path.
    const afterRestart = await checkAndRecordRateLimit(RATELIMIT, "4915110619636", now + 30_000);
    expect(afterRestart.ok).toBe(false);
  });

  it("tracks different numbers independently", async () => {
    const now = 1_000_000;
    await checkAndRecordRateLimit(RATELIMIT, "4915110619636", now);
    const other = await checkAndRecordRateLimit(RATELIMIT, "4915110610000", now);
    expect(other.ok).toBe(true);
  });

  it("clearRateLimit removes the entry", async () => {
    const now = 1_000_000;
    await checkAndRecordRateLimit(RATELIMIT, "4915110619636", now);
    await clearRateLimit(RATELIMIT, "4915110619636");
    const again = await checkAndRecordRateLimit(RATELIMIT, "4915110619636", now + 1);
    expect(again.ok).toBe(true);
  });
});

describe("resolveVoiceContact", () => {
  const savedHome = process.env.HARNESS_HOME;

  beforeEach(() => {
    process.env.HARNESS_HOME = TEST_DIR;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = savedHome;
  });

  it("resolves a known number to its name", async () => {
    await writeFile(
      REGISTRY,
      JSON.stringify({ contacts: [{ number: "4915110619636", name: "Philipp" }] }),
      "utf-8",
    );
    expect(await resolveVoiceContact(REGISTRY, "4915110619636")).toBe("Philipp");
    expect(await resolveVoiceContact(REGISTRY, "+49 151 10619636")).toBe("Philipp");
  });

  it("returns null for an unknown number", async () => {
    await writeFile(
      REGISTRY,
      JSON.stringify({ contacts: [{ number: "4915110619636", name: "Philipp" }] }),
      "utf-8",
    );
    expect(await resolveVoiceContact(REGISTRY, "4915110699999")).toBeNull();
  });

  it("returns null when the registry file is missing", async () => {
    expect(await resolveVoiceContact(REGISTRY, "4915110619636")).toBeNull();
  });
});
