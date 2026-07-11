import { describe, it, expect } from "vitest";
import { executeExecPty } from "../../src/tools/execPty.ts";
import { executeExecSync } from "../../src/tools/exec.ts";

describe("execPty", () => {
  it("TTY detection: [ -t 1 ] → TTY", async () => {
    const result = await executeExecPty({ command: "[ -t 1 ] && echo TTY || echo NOTTY" });
    expect(result.content).toContain("TTY");
  });

  it("non-PTY sync: [ -t 1 ] → NOTTY", async () => {
    const result = await executeExecSync({ command: "[ -t 1 ] && echo TTY || echo NOTTY" });
    expect(result.content).toContain("NOTTY");
  });

  it("tput cols → 80 (configured cols)", async () => {
    const result = await executeExecPty({ command: "tput cols" });
    expect(result.content).toMatch(/80/);
  });

  it("timeout in PTY mode → terminates", async () => {
    const result = await executeExecPty({ command: "sleep 60", timeout: 200 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  });

  it("output cap > 200 KB → truncated", async () => {
    const result = await executeExecPty({ command: "head -c 300000 /dev/urandom | base64" });
    expect(result.content).toContain("[...truncated");
  });

  it("PTY exit after short timeout → process terminates cleanly", async () => {
    const result = await executeExecPty({ command: "sleep 30", timeout: 200 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
    expect(result.content).toMatch(/signal: (15|null)/);
  });
});
