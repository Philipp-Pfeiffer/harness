import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeTool, WRITE_NO_FLY_PATTERNS } from "../../src/tools/write_file.ts";
import { executeExecSync } from "../../src/tools/exec.ts";
import { resolve } from "node:path";
import { unlink } from "node:fs/promises";

const fixturesDir = resolve(process.cwd(), "tests/fixtures");
const testDir = resolve(fixturesDir, "write_test");

async function cleanup(path: string) {
  try {
    await unlink(path);
  } catch (_) {}
}

async function cleanupTmp(path: string) {
  try {
    await unlink(`${path}.harness.tmp`);
  } catch (_) {}
}

describe("write tool", () => {
  beforeEach(async () => {
    await executeExecSync({ command: `mkdir -p ${testDir}` });
  });

  afterEach(async () => {
    await executeExecSync({ command: `rm -rf ${testDir}` });
  });

  describe("write_file", () => {
    it("1. happy path: write to new file → ok", async () => {
      const path = resolve(testDir, "new_file.txt");
      const result = await writeTool.execute({ path, content: "hello world" });
      expect(result.content).toBe("ok");
      const bashResult = await executeExecSync({ command: `cat ${path}` });
      expect(bashResult.content).toContain("hello world");
    });

    it("2. happy path: overwrite existing file → ok", async () => {
      const path = resolve(testDir, "existing.txt");
      await executeExecSync({ command: `echo "original" > ${path}` });
      const result = await writeTool.execute({ path, content: "overwritten" });
      expect(result.content).toBe("ok");
      const bashResult = await executeExecSync({ command: `cat ${path}` });
      expect(bashResult.content).toContain("overwritten");
    });

    it("3. sensitive path: /etc/test.txt → SENSITIVE_PATH error", async () => {
      const result = await writeTool.execute({ path: "/etc/test.txt", content: "bad" });
      expect(result.content).toContain("SENSITIVE_PATH");
      expect(result.content).toContain("Writing to /etc/ is blocked");
    });

    it("4. sensitive path: /boot/test.txt → SENSITIVE_PATH error", async () => {
      const result = await writeTool.execute({ path: "/boot/test.txt", content: "bad" });
      expect(result.content).toContain("SENSITIVE_PATH");
      expect(result.content).toContain("Writing to /boot/ is blocked");
    });

    it("5. sensitive path: /usr/lib/systemd/test → SENSITIVE_PATH error", async () => {
      const result = await writeTool.execute({ path: "/usr/lib/systemd/test", content: "bad" });
      expect(result.content).toContain("SENSITIVE_PATH");
      expect(result.content).toContain("Writing to /usr/lib/systemd/ is blocked");
    });

    it("6. sensitive path: /proc/test → SENSITIVE_PATH error", async () => {
      const result = await writeTool.execute({ path: "/proc/test", content: "bad" });
      expect(result.content).toContain("SENSITIVE_PATH");
      expect(result.content).toContain("Writing to /proc/ is blocked");
    });

    it("7. sensitive path: /sys/test → SENSITIVE_PATH error", async () => {
      const result = await writeTool.execute({ path: "/sys/test", content: "bad" });
      expect(result.content).toContain("SENSITIVE_PATH");
      expect(result.content).toContain("Writing to /sys/ is blocked");
    });

    it("8. sensitive path: /dev/urandom → SENSITIVE_PATH error", async () => {
      const result = await writeTool.execute({ path: "/dev/urandom", content: "bad" });
      expect(result.content).toContain("SENSITIVE_PATH");
      expect(result.content).toContain("Writing to /dev/ is blocked");
    });

    it("9. sensitive path: docker.sock → SENSITIVE_PATH error", async () => {
      const result = await writeTool.execute({ path: "/var/run/docker.sock", content: "bad" });
      expect(result.content).toContain("SENSITIVE_PATH");
      expect(result.content).toContain("docker.sock");
    });

    it("10. sensitive path: relative path targeting /etc → SENSITIVE_PATH error", async () => {
      const result = await writeTool.execute({ path: "/etc/passwd", content: "bad" });
      expect(result.content).toContain("SENSITIVE_PATH");
    });

    it("11. atomic rename: writes to tmp then renames to target", async () => {
      const path = resolve(testDir, "atomic.txt");
      await writeTool.execute({ path, content: "atomic test" });
      const tmpExists = await executeExecSync({ command: `test -f ${path}.harness.tmp && echo yes || echo no` });
      expect(tmpExists.content).toContain("no");
      const bashResult = await executeExecSync({ command: `cat ${path}` });
      expect(bashResult.content).toContain("atomic test");
    });

    it("12. tmp cleanup: I/O error leaves no tmp file", async () => {
      const path = resolve(testDir, "nonexistent", "file.txt");
      await writeTool.execute({ path, content: "test" });
      const tmpExists = await executeExecSync({ command: `test -f ${path}.harness.tmp && echo yes || echo no` });
      expect(tmpExists.content).toContain("no");
    });
  });

  describe("WRITE_NO_FLY_PATTERNS export", () => {
    it("is exported and contains expected patterns", () => {
      expect(Array.isArray(WRITE_NO_FLY_PATTERNS)).toBe(true);
      expect(WRITE_NO_FLY_PATTERNS.length).toBeGreaterThan(0);
      const reasons = WRITE_NO_FLY_PATTERNS.map(p => p.reason);
      expect(reasons).toContain("Writing to /etc/ is blocked");
      expect(reasons).toContain("Writing to /proc/ is blocked");
    });
  });
});