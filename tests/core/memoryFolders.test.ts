import { describe, it, expect } from "vitest";
import { resolveMemoryConfig, ensureMemoryFolders } from "../../src/core/memoryFolders.js";
import { rm, access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

describe("memoryFolders", () => {
  describe("resolveMemoryConfig", () => {
    it("uses defaults when no env is set", () => {
      const config = resolveMemoryConfig({});
      expect(config.memoryPath).toContain("memory");
      expect(config.sourcesPath).toContain("sources");
      expect(config.inboxPath).toContain("_inbox.md");
    });

    it("reads paths from env vars", () => {
      const config = resolveMemoryConfig({
        HARNESS_MEMORY_PATH: "/custom/memory",
        HARNESS_SOURCES_PATH: "/custom/sources",
        HARNESS_INBOX_PATH: "/custom/inbox.md",
      });
      expect(config.memoryPath).toBe("/custom/memory");
      expect(config.sourcesPath).toBe("/custom/sources");
      expect(config.inboxPath).toBe("/custom/inbox.md");
    });

    it("expands ~ to home directory", () => {
      const config = resolveMemoryConfig({
        HARNESS_MEMORY_PATH: "~/my-memory",
      });
      expect(config.memoryPath).not.toContain("~");
      expect(config.memoryPath).toContain("my-memory");
    });
  });

  describe("ensureMemoryFolders", () => {
    it("creates folders and inbox idempotently", async () => {
      const dir = resolve(tmpdir(), `harness-mem-${Date.now()}`);
      const memoryPath = resolve(dir, "memory");
      const sourcesPath = resolve(dir, "sources");
      const inboxPath = resolve(memoryPath, "_inbox.md");

      const result = await ensureMemoryFolders({ memoryPath, sourcesPath, inboxPath });
      expect(result.memoryPath).toBe(memoryPath);
      expect(result.sourcesPath).toBe(sourcesPath);
      expect(result.inboxPath).toBe(inboxPath);

      // Verify directories exist
      await access(memoryPath);
      await access(sourcesPath);

      // Verify inbox was created
      const inboxContent = await readFile(inboxPath, "utf-8");
      expect(inboxContent).toContain("# Inbox");

      // Second call should not throw (idempotent)
      await ensureMemoryFolders({ memoryPath, sourcesPath, inboxPath });

      await rm(dir, { recursive: true });
    });
  });
});
