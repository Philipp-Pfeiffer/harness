import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveVoiceContact } from "../../src/daemon/voiceRegistry.js";

async function withRegistry(contents: string, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "harness-voice-registry-"));
  const registryPath = join(dir, "voice-registry.json");
  await writeFile(registryPath, contents, "utf-8");
  try {
    await fn(registryPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveVoiceContact", () => {
  it("resolves a known number to its name (normalized)", async () => {
    await withRegistry(
      JSON.stringify({
        contacts: [
          { number: "4915110619636", name: "Philipp" },
          { number: "491701234567", name: "Anna" },
        ],
      }),
      async (path) => {
        expect(await resolveVoiceContact(path, "+49 151 10619636")).toBe("Philipp");
        expect(await resolveVoiceContact(path, "4915110619636")).toBe("Philipp");
      },
    );
  });

  it("returns the normalized number for a listed contact without a name", async () => {
    await withRegistry(
      JSON.stringify({ contacts: [{ number: "491701234567" }] }),
      async (path) => {
        expect(await resolveVoiceContact(path, "+491701234567")).toBe("491701234567");
      },
    );
  });

  it("returns null for an unknown number", async () => {
    await withRegistry(
      JSON.stringify({ contacts: [{ number: "4915110619636", name: "Philipp" }] }),
      async (path) => {
        expect(await resolveVoiceContact(path, "+491999999999")).toBeNull();
      },
    );
  });

  it("returns null when the registry file is missing", async () => {
    expect(await resolveVoiceContact(join(tmpdir(), "does-not-exist.json"), "+4915110619636")).toBeNull();
  });

  it("returns null for invalid JSON or a missing contacts array (fail-open)", async () => {
    await withRegistry("{not json", async (path) => {
      expect(await resolveVoiceContact(path, "+4915110619636")).toBeNull();
    });
    await withRegistry(JSON.stringify({ foo: [] }), async (path) => {
      expect(await resolveVoiceContact(path, "+4915110619636")).toBeNull();
    });
  });

  it("normalizes both registry numbers and query numbers to digits", async () => {
    await withRegistry(
      JSON.stringify({ contacts: [{ number: "49 151 10619636", name: "Philipp" }] }),
      async (path) => {
        // Registry-Nummern werden NICHT normalisiert — der Abgleich ist
        // digits-only gegen den Registry-Eintrag (wie im Outbound-Gate).
        expect(await resolveVoiceContact(path, "4915110619636")).toBeNull();
        await writeFile(path, JSON.stringify({ contacts: [{ number: "4915110619636", name: "Philipp" }] }), "utf-8");
        expect(await resolveVoiceContact(path, "+49(151)10619636")).toBe("Philipp");
      },
    );
  });
});
