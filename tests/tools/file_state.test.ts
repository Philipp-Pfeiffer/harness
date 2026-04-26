import { describe, it, expect, beforeEach } from "vitest";
import { markRead, wasRead } from "../../src/tools/file_state.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";

describe("file_state", () => {
  beforeEach(() => {
    markRead(resolve("/clear/state"));
  });

  describe("markRead", () => {
    it("marks a path as read", () => {
      const path = resolve("/test/path");
      markRead(path);
      expect(wasRead(path)).toBe(true);
    });
  });

  describe("wasRead", () => {
    it("returns false for never-read path", () => {
      expect(wasRead(resolve("/never/read/path"))).toBe(false);
    });

    it("returns true for path that was marked read", () => {
      const path = resolve("/test/file");
      markRead(path);
      expect(wasRead(path)).toBe(true);
    });
  });

  describe("path normalization", () => {
    it("treats tilde path and absolute path as equivalent", () => {
      const home = homedir();
      const tildePath = resolve(home, "somefile");
      const absolutePath = resolve(tildePath);

      markRead(tildePath);
      expect(wasRead(absolutePath)).toBe(true);
    });

    it("treats relative and absolute paths as equivalent after normalization", () => {
      const absPath = resolve("/tmp/normalized/test");
      markRead(absPath);
      expect(wasRead(absPath)).toBe(true);
    });

    it("marks different representations of the same path as read", () => {
      const home = homedir();
      markRead(resolve(home, "project", "file.txt"));
      expect(wasRead(resolve(home, "project", "file.txt"))).toBe(true);
    });
  });
});