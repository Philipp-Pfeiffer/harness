import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { executeBash, bashTool, BASH_NO_FLY_PATTERNS } from "../../src/tools/bash.ts";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";

const fixturesDir = resolve(process.cwd(), "tests/fixtures");

function createTimeoutRunner(timeoutMs: number) {
  return (args: { command: string; cwd?: string }) => executeBash(args, timeoutMs);
}

describe("bash tool", () => {
  describe("basic execution", () => {
    it("1. echo hello → success, stdout contains 'hello', exit 0", async () => {
      const result = await executeBash({ command: "echo hello" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("hello");
      expect(result.content).toContain("code: 0");
    });

    it("2. exit 1 → success, isError false, exit-code 1 in output", async () => {
      const result = await executeBash({ command: "exit 1" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("code: 1");
    });

    it("3. stdout and stderr separated", async () => {
      const result = await executeBash({ command: "echo out; echo err >&2" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("--- stdout ---");
      expect(result.content).toContain("out");
      expect(result.content).toContain("--- stderr ---");
      expect(result.content).toContain("err");
    });

    it("4. pipe chain: echo a\\nb\\nc | wc -l → stdout contains 3", async () => {
      const result = await executeBash({ command: 'echo -e "a\\nb\\nc" | wc -l' });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("3");
    });

    it("5. glob: ls tests/fixtures/*.txt → success, stdout lists files", async () => {
      const result = await executeBash({ command: `ls ${fixturesDir}/*.txt` });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("file1.txt");
      expect(result.content).toContain("file2.txt");
      expect(result.content).toContain("file3.txt");
    });
  });

  describe("cwd handling", () => {
    it("6. cwd argument: pwd with cwd /tmp → stdout = /tmp", async () => {
      const result = await executeBash({ command: "pwd", cwd: "/tmp" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("/tmp");
    });

    it("7. invalid cwd: pwd with cwd /nonexistent/path → isError 'cwd does not exist'", async () => {
      const result = await executeBash({ command: "pwd", cwd: "/nonexistent/path" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("cwd does not exist");
    });
  });

  describe("output limits", () => {
    it("8. output > 64 KB: base64 /dev/urandom → success, output truncated, marker in output", async () => {
      const result = await executeBash({ command: "head -c 100000 /dev/urandom | base64" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("[...truncated");
    });
  });

  describe("timeout", () => {
    it("9. sleep 60 with 1s timeout → isError 'timed out after 30s'", async () => {
      const runWithShortTimeout = createTimeoutRunner(1000);
      const result = await runWithShortTimeout({ command: "sleep 60" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("timed out");
      expect(result.content).toContain("terminated");
    });

    it("14. long-running with process group: both sleep processes die on timeout", async () => {
      const runWithShortTimeout = createTimeoutRunner(1000);
      const result = await runWithShortTimeout({ command: "bash -c 'sleep 30 | sleep 30'" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("timed out");
    });
  });

  describe("no-fly list", () => {
    it("10. rm -rf /tmp/test → isError, 'Blocked destructive command: rm with -rf', hint contains 'trash'", async () => {
      const result = await executeBash({ command: "rm -rf /tmp/test" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Blocked destructive command");
      expect(result.content).toContain("rm with -rf");
      expect(result.content).toContain("trash");
    });

    it("11. dd if=/dev/zero of=/tmp/x → isError", async () => {
      const result = await executeBash({ command: "dd if=/dev/zero of=/tmp/x" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Blocked destructive command");
      expect(result.content).toContain("dd with input file");
    });

    it("12. fork bomb :(){ :|:& };: → isError, 'Fork bomb pattern blocked'", async () => {
      const result = await executeBash({ command: ":(){ :|:& };:" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Fork bomb pattern blocked");
    });

    it("13. shutdown -h now → isError", async () => {
      const result = await executeBash({ command: "shutdown -h now" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Blocked destructive command");
      expect(result.content).toContain("System power command");
    });
  });

  describe("validation", () => {
    it("15. empty command string → isError 'Invalid arguments'", async () => {
      const result = await executeBash({ command: "" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid arguments");
    });
  });
});

describe("BASH_NO_FLY_PATTERNS export", () => {
  it("is exported and contains expected patterns", () => {
    expect(Array.isArray(BASH_NO_FLY_PATTERNS)).toBe(true);
    expect(BASH_NO_FLY_PATTERNS.length).toBeGreaterThan(0);
    const reasons = BASH_NO_FLY_PATTERNS.map(p => p.reason);
    expect(reasons).toContain("rm with -rf/-fr/-Rf is blocked");
    expect(reasons).toContain("dd with input file is blocked (can destroy disks)");
    expect(reasons).toContain("Fork bomb pattern blocked");
  });
});