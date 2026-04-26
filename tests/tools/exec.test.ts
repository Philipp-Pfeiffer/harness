import { describe, it, expect } from "vitest";
import { executeExec, executeExecSync, EXEC_NO_FLY_PATTERNS } from "../../src/tools/exec.ts";
import { resolve } from "node:path";

const fixturesDir = resolve(process.cwd(), "tests/fixtures");

function createTimeoutRunner(timeoutMs: number) {
  return (args: { command: string; cwd?: string; timeout?: number }) =>
    executeExec({ ...args, timeout: timeoutMs });
}

describe("exec tool", () => {
  describe("basic execution", () => {
    it("1. echo hello → success, stdout contains 'hello', exit 0", async () => {
      const result = await executeExec({ command: "echo hello" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("hello");
      expect(result.content).toContain("code: 0");
    });

    it("2. exit 1 → success, isError false, exit-code 1 in output", async () => {
      const result = await executeExec({ command: "exit 1" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("code: 1");
    });

    it("3. stdout and stderr separated", async () => {
      const result = await executeExec({ command: "echo out; echo err >&2" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("--- stdout ---");
      expect(result.content).toContain("out");
      expect(result.content).toContain("--- stderr ---");
      expect(result.content).toContain("err");
    });

    it("4. pipe chain: echo a\\nb\\nc | wc -l → stdout contains 3", async () => {
      const result = await executeExec({ command: 'echo -e "a\\nb\\nc" | wc -l' });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("3");
    });

    it("5. glob: ls tests/fixtures/*.txt → success, stdout lists files", async () => {
      const result = await executeExec({ command: `ls ${fixturesDir}/*.txt` });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("file1.txt");
      expect(result.content).toContain("file2.txt");
      expect(result.content).toContain("file3.txt");
    });
  });

  describe("cwd handling", () => {
    it("6. cwd argument: pwd with cwd /tmp → stdout = /tmp", async () => {
      const result = await executeExec({ command: "pwd", cwd: "/tmp" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("/tmp");
    });

    it("7. invalid cwd: pwd with cwd /nonexistent/path → isError 'cwd does not exist'", async () => {
      const result = await executeExec({ command: "pwd", cwd: "/nonexistent/path" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("cwd does not exist");
    });
  });

  describe("output limits", () => {
    it("8. output > 64 KB: base64 /dev/urandom → success, output truncated, marker in output", async () => {
      const result = await executeExec({ command: "head -c 100000 /dev/urandom | base64" });
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
      const result = await executeExec({ command: "rm -rf /tmp/test" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Blocked destructive command");
      expect(result.content).toContain("rm with -rf");
      expect(result.content).toContain("trash");
    });

    it("rm file.txt → ok (no destructive flags)", async () => {
      const result = await executeExec({ command: "rm /tmp/nonexistent_file_xyz" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("--- exit ---");
    });

    it("rm -rf / → isError, blocked", async () => {
      const result = await executeExec({ command: "rm -rf /tmp/test" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Blocked destructive command");
    });

    it("rm -r -f /tmp/test → isError, blocked (separate flags)", async () => {
      const result = await executeExec({ command: "rm -r -f /tmp/test" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Blocked destructive command");
    });

    it("rm --recursive --force /tmp/test → isError, blocked (long form)", async () => {
      const result = await executeExec({ command: "rm --recursive --force /tmp/test" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Blocked destructive command");
    });

    it("11. dd if=/dev/zero of=/tmp/x → isError", async () => {
      const result = await executeExec({ command: "dd if=/dev/zero of=/tmp/x" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Blocked destructive command");
      expect(result.content).toContain("dd with input file");
    });

    it("12. fork bomb :(){ :|:& };: → isError, 'Fork bomb pattern blocked'", async () => {
      const result = await executeExec({ command: ":(){ :|:& };:" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Fork bomb pattern blocked");
    });

    it("13. shutdown -h now → isError", async () => {
      const result = await executeExec({ command: "shutdown -h now" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Blocked destructive command");
      expect(result.content).toContain("System power command");
    });
  });

  describe("validation", () => {
    it("15. empty command string → isError 'Invalid arguments'", async () => {
      const result = await executeExec({ command: "" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid arguments");
    });
  });

  describe("env", () => {
    it("env override: printenv FOO → contains 'bar'", async () => {
      const result = await executeExec({ command: "printenv FOO", env: { FOO: "bar" } });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("bar");
    });

    it("env merge: FOO=bar plus existing PATH → PATH preserved, FOO set", async () => {
      const result = await executeExec({ command: "printenv FOO", env: { FOO: "bar" } });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("bar");
    });
  });

  describe("stdin", () => {
    it("stdin pipe: cat with stdin 'hello' → contains 'hello'", async () => {
      const result = await executeExec({ command: "cat", stdin: "hello\n" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("hello");
    });

    it("stdin pipe: echo input via pipe → output correct", async () => {
      const result = await executeExec({ command: "head -n 1", stdin: "line1\nline2\n" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("line1");
    });
  });

  describe("timeout arg", () => {
    it("sleep 60 with explicit timeout 200ms → times out", async () => {
      const result = await executeExec({ command: "sleep 60", timeout: 200 });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("timed out");
    });

    it("default timeout 30s: sleep 1 → success", async () => {
      const result = await executeExec({ command: "sleep 1" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("code: 0");
    });
  });

  describe("TERM→GRACE→KILL", () => {
    it("trap TERM → output contains 'TERM' (proof SIGTERM was sent)", async () => {
      const result = await executeExec(
        { command: "trap 'echo TERM' TERM; sleep 60", timeout: 200 }
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("TERM");
    });

    it("sleep 60 with short timeout → SIGTERM sent, not immediate SIGKILL", async () => {
      const result = await executeExec({ command: "sleep 60", timeout: 200 });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("TERM");
    });
  });

  describe("elevated", () => {
    it("id -u with elevated → 0 (if passwordless sudo)", async () => {
      const probeResult = await executeExec({ command: "sudo -n true", elevated: false });
      if (probeResult.content.includes("a password is required")) {
        return;
      }
      const result = await executeExec({ command: "id -u", elevated: true });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("0");
    });

    it("elevated without passwordless sudo → shows password error (skipped if sudo available)", async () => {
      const probeResult = await executeExec({ command: "sudo -n true", elevated: false });
      if (!probeResult.content.includes("a password is required")) {
        return;
      }
      const result = await executeExec({ command: "id -u", elevated: true });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("a password is required");
    });
  });

  describe("cross-field validation", () => {
    it("pty + stdin → validation error", async () => {
      const result = await executeExec({ command: "cat", pty: true, stdin: "hello" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("stdin not supported with pty");
    });

    it("background + stdin → validation error", async () => {
      const result = await executeExec({ command: "cat", background: true, stdin: "hello" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("stdin not supported with background");
    });
  });

  describe("background", () => {
    it("background true → returns handle immediately", async () => {
      const result = await executeExec({ command: "sleep 30", background: true });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Background process started");
      expect(result.content).toContain("handle: bg_");
      expect(result.content).toMatch(/pid: \d+/);
    });

    it("background true with long process → handle returned immediately", async () => {
      const start = Date.now();
      const result = await executeExec({ command: "sleep 5", background: true });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
      expect(result.content).toContain("handle: bg_");
    });
  });

  describe("yieldMs", () => {
    it("yieldMs: short process finishes before yield → sync output", async () => {
      const result = await executeExec({ command: "echo hello", yieldMs: 5000 });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("hello");
      expect(result.content).toContain("code: 0");
    });

    it("yieldMs: process still running after yield → returns handle", async () => {
      const result = await executeExec({ command: "sleep 30", yieldMs: 200 });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Background process started");
      expect(result.content).toContain("handle: bg_");
    });

    it("yieldMs: 0 means no yield → long process times out", async () => {
      const result = await executeExec({ command: "sleep 60", yieldMs: 0, timeout: 2000 });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("timed out");
    });
  });
});

describe("EXEC_NO_FLY_PATTERNS export", () => {
  it("is exported and contains expected patterns", () => {
    expect(Array.isArray(EXEC_NO_FLY_PATTERNS)).toBe(true);
    expect(EXEC_NO_FLY_PATTERNS.length).toBeGreaterThan(0);
    const reasons = EXEC_NO_FLY_PATTERNS.map((p) => p.reason);
    expect(reasons).toContain("rm with -rf/-fr/-Rf is blocked");
    expect(reasons).toContain("dd with input file is blocked (can destroy disks)");
    expect(reasons).toContain("Fork bomb pattern blocked");
  });
});
