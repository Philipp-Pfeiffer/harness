import { describe, it, expect } from "vitest";
import { markRead, wasRead } from "../../src/tools/file_state.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";

const SESSION_A = "test-session-a";
const SESSION_B = "test-session-b";

describe("file_state", () => {
  describe("markRead", () => {
    it("marks a path as read within the same session", () => {
      const path = resolve("/test/path");
      markRead(SESSION_A, path);
      expect(wasRead(SESSION_A, path)).toBe(true);
    });
  });

  describe("wasRead", () => {
    it("returns false for never-read path", () => {
      expect(wasRead(SESSION_A, resolve("/never/read/path"))).toBe(false);
    });

    it("returns true for path that was marked read in the same session", () => {
      const path = resolve("/test/file");
      markRead(SESSION_A, path);
      expect(wasRead(SESSION_A, path)).toBe(true);
    });
  });

  describe("session isolation", () => {
    it("does not leak read state across sessions", () => {
      const path = resolve("/test/isolation");
      markRead(SESSION_A, path);
      expect(wasRead(SESSION_A, path)).toBe(true);
      expect(wasRead(SESSION_B, path)).toBe(false);
    });

    it("tracks read state per session independently", () => {
      const path = resolve("/test/independent");
      markRead(SESSION_B, path);
      expect(wasRead(SESSION_B, path)).toBe(true);
      expect(wasRead(SESSION_A, path)).toBe(false);
    });

    it("keeps sessions apart when both read the same path", () => {
      const path = resolve("/test/both-read");
      markRead(SESSION_A, path);
      markRead(SESSION_B, path);
      expect(wasRead(SESSION_A, path)).toBe(true);
      expect(wasRead(SESSION_B, path)).toBe(true);
    });
  });

  describe("path normalization", () => {
    it("treats tilde path and absolute path as equivalent", () => {
      const home = homedir();
      const tildePath = resolve(home, "somefile");
      const absolutePath = resolve(tildePath);

      markRead(SESSION_A, tildePath);
      expect(wasRead(SESSION_A, absolutePath)).toBe(true);
    });

    it("treats relative and absolute paths as equivalent after normalization", () => {
      const absPath = resolve("/tmp/normalized/test");
      markRead(SESSION_A, absPath);
      expect(wasRead(SESSION_A, absPath)).toBe(true);
    });

    it("marks different representations of the same path as read", () => {
      const home = homedir();
      markRead(SESSION_A, resolve(home, "project", "file.txt"));
      expect(wasRead(SESSION_A, resolve(home, "project", "file.txt"))).toBe(true);
    });
  });
});
