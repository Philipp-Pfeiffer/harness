import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_DIST = join(__dirname, "..", "..", "dist", "index.js");

function runWithNullStdin(): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise) => {
    const proc = spawn("node", [AGENT_DIST], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (exitCode) => {
      resolvePromise({ stdout, stderr, exitCode });
    });
  });
}

describe("Non-TTY startup", () => {
  it("exits gracefully without Ink warnings when stdin is not a TTY", async () => {
    const { stdout, stderr, exitCode } = await runWithNullStdin();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("harness requires an interactive terminal (TTY)");
    expect(stderr).not.toContain("Encountered two children with the same key");
    expect(stderr).not.toContain("Raw mode is not supported");
    expect(stdout).toBe("");
  });
});
