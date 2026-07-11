import { describe, it, expect, beforeEach } from "vitest";
import { executeProcess } from "../../src/tools/process.ts";
import { executeExec } from "../../src/tools/exec.ts";
import { processSupervisor } from "../../src/tools/processSupervisor.ts";

describe("process tool", () => {
  beforeEach(() => {
    const { running, finished } = processSupervisor.list();
    for (const session of running) {
      processSupervisor.kill(session.handle, "SIGKILL");
    }
    for (const session of finished) {
    }
  });

  describe("list action", () => {
    it("list with no sessions → empty message", async () => {
      const result = await executeProcess({ action: "list" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("No background sessions");
    });
  });

  describe("poll action", () => {
    it("poll without sessionId → validation error", async () => {
      const result = await executeProcess({ action: "poll" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("sessionId required");
    });

    it("poll nonexistent session → not found error", async () => {
      const result = await executeProcess({ action: "poll", sessionId: "bg_deadbeef" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found or expired");
    });
  });

  describe("kill action", () => {
    it("kill without sessionId → validation error", async () => {
      const result = await executeProcess({ action: "kill" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("sessionId required");
    });

    it("kill nonexistent session → not found error", async () => {
      const result = await executeProcess({ action: "kill", sessionId: "bg_deadbeef" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found or expired");
    });
  });

  describe("log action", () => {
    it("log without sessionId → validation error", async () => {
      const result = await executeProcess({ action: "log" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("sessionId required");
    });

    it("log nonexistent session → not found error", async () => {
      const result = await executeProcess({ action: "log", sessionId: "bg_deadbeef" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found or expired");
    });
  });

  describe("wait action", () => {
    it("wait without sessionId → validation error", async () => {
      const result = await executeProcess({ action: "wait" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("sessionId required");
    });

    it("wait nonexistent session → not found error", async () => {
      const result = await executeProcess({ action: "wait", sessionId: "bg_deadbeef" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found or expired");
    });
  });

  describe("full lifecycle", () => {
    it("background + poll + kill → correct state transitions", async () => {
      const execResult = await executeExec({ command: "sleep 30", background: true });
      expect(execResult.content).toContain("handle: bg_");

      const handleMatch = execResult.content.match(/handle: (bg_[a-f0-9]+)/);
      expect(handleMatch).not.toBeNull();
      const handle = handleMatch![1];

      const pollResult = await executeProcess({ action: "poll", sessionId: handle });
      expect(pollResult.isError).toBe(false);
      expect(pollResult.content).toContain("state: running");
      expect(pollResult.content).toContain(`pid:`);

      const killResult = await executeProcess({ action: "kill", sessionId: handle });
      expect(killResult.isError).toBe(false);
      expect(killResult.content).toContain("signal sent: SIGTERM");

      const listResult = await executeProcess({ action: "list" });
      expect(listResult.content).toContain(handle);
    });

    it("background + poll → stdout captured", async () => {
      const execResult = await executeExec({ command: "echo hello world", background: true });
      expect(execResult.content).toContain("handle: bg_");

      const handleMatch = execResult.content.match(/handle: (bg_[a-f0-9]+)/);
      const handle = handleMatch![1];

      await new Promise((resolve) => setTimeout(resolve, 500));

      const pollResult = await executeProcess({ action: "poll", sessionId: handle });
      expect(pollResult.content).toContain("hello world");
    });

    it("background process buffers >100 KB output (200 KB cap)", async () => {
      const execResult = await executeExec({ command: "head -c 80000 /dev/urandom | base64", background: true });
      expect(execResult.content).toContain("handle: bg_");

      const handleMatch = execResult.content.match(/handle: (bg_[a-f0-9]+)/);
      const handle = handleMatch![1];

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const logResult = await executeProcess({ action: "log", sessionId: handle, offset: 0, limit: 64000 });
      expect(logResult.isError).toBe(false);
      const totalBytesMatch = logResult.content.match(/total_bytes: (\d+)/);
      expect(totalBytesMatch).not.toBeNull();
      expect(Number(totalBytesMatch![1])).toBeGreaterThan(64 * 1024);
    });
  });
});
