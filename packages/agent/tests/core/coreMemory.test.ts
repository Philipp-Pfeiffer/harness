import { describe, it, expect, vi } from "vitest";
import {
  loadCoreMemoryRaw,
  parseCoreMemorySections,
  formatCoreMemoryBlock,
  composeSystemPrompt,
} from "../../src/core/coreMemory.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const TEST_CORE_MD = `## Wer

Alice – Software-Entwicklerin

## Projekte

- Projekt Alpha
- Projekt Beta

## Working-Protocol

Siehe AGENTS.md

## Aktive Themen

Phase 2A
`;

describe("coreMemory", () => {
  describe("loadCoreMemoryRaw", () => {
    it("reads core.md when present", async () => {
      const dir = resolve(tmpdir(), `harness-test-${Date.now()}`);
      await mkdir(dir, { recursive: true });
      const corePath = resolve(dir, "core.md");
      await writeFile(corePath, TEST_CORE_MD, "utf-8");

      const result = await loadCoreMemoryRaw(corePath);
      expect(result).toBe(TEST_CORE_MD.trim());

      await rm(dir, { recursive: true });
    });

    it("returns undefined and warns when core.md is missing", async () => {
      const dir = resolve(tmpdir(), `harness-test-missing-${Date.now()}`);
      await mkdir(dir, { recursive: true });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await loadCoreMemoryRaw(resolve(dir, "core.md"));
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("core.md not found"));
      warnSpy.mockRestore();

      await rm(dir, { recursive: true });
    });
  });

  describe("parseCoreMemorySections", () => {
    it("parses all four sections", () => {
      const sections = parseCoreMemorySections(TEST_CORE_MD);
      expect(sections.wer).toContain("Alice");
      expect(sections.projekte).toContain("Projekt Alpha");
      expect(sections.workingProtocol).toContain("AGENTS.md");
      expect(sections.aktiveThemen).toContain("Phase 2A");
    });

    it("returns empty strings for missing sections", () => {
      const sections = parseCoreMemorySections("");
      expect(sections.wer).toBe("");
      expect(sections.projekte).toBe("");
      expect(sections.workingProtocol).toBe("");
      expect(sections.aktiveThemen).toBe("");
    });
  });

  describe("formatCoreMemoryBlock", () => {
    it("wraps content in core_memory tags", () => {
      const result = formatCoreMemoryBlock("hello");
      expect(result).toBe("<core_memory>\nhello\n</core_memory>");
    });

    it("returns empty block when content is missing", () => {
      const result = formatCoreMemoryBlock(undefined);
      expect(result).toBe("<core_memory></core_memory>");
    });
  });

  describe("composeSystemPrompt", () => {
    it("appends core memory block to base prompt", () => {
      const result = composeSystemPrompt("Base prompt", "core content");
      expect(result).toContain("Base prompt");
      expect(result).toContain("<core_memory>");
      expect(result).toContain("core content");
    });

    it("works without core memory", () => {
      const result = composeSystemPrompt("Base prompt", undefined);
      expect(result).toContain("Base prompt");
      expect(result).toContain("<core_memory></core_memory>");
    });
  });
});
