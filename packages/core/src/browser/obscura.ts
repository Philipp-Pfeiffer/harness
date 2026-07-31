import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { BrowserConnectionError } from "./errors.js";

export interface ObscuraSession {
  proc: ChildProcess;
  cdpUrl: string;
  port: number;
  stop: () => Promise<void>;
}

export interface StartObscuraOptions {
  executable?: string;
  port?: number;
  startupTimeoutMs?: number;
}

const DEFAULT_OBSCURA_EXECUTABLE = "obscura";
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 5_000;

export function cdpUrlForPort(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function parseCdpPort(cdpUrl: string): number {
  const url = new URL(cdpUrl);
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

export async function findFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free TCP port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

export async function waitForCdp(
  cdpUrl: string,
  timeoutMs: number,
  pollIntervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const versionUrl = `${cdpUrl.replace(/\/$/, "")}/json/version`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(versionUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Obscura still starting
    }
    await sleep(pollIntervalMs);
  }

  throw new BrowserConnectionError(
    `Timed out after ${timeoutMs}ms waiting for Obscura CDP at ${cdpUrl}`,
  );
}

export async function stopObscuraProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.killed) {
    return;
  }

  proc.kill("SIGTERM");
  try {
    await waitForProcessExit(proc, STOP_GRACE_MS);
    return;
  } catch {
    proc.kill("SIGKILL");
    await waitForProcessExit(proc, STOP_GRACE_MS);
  }
}

export async function startObscura(opts: StartObscuraOptions = {}): Promise<ObscuraSession> {
  const executable = opts.executable ?? process.env.OBSCURA_PATH ?? DEFAULT_OBSCURA_EXECUTABLE;
  const port = opts.port ?? await findFreePort();
  const cdpUrl = cdpUrlForPort(port);
  const startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const succeed = (session: ObscuraSession) => {
      if (settled) return;
      settled = true;
      resolve(session);
    };

    const proc = spawn(executable, ["serve", "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      fail(new BrowserConnectionError(
        `Failed to spawn Obscura (${executable}): ${err.message}. ` +
        "Install with: yay -S obscura-browser (or set browser.obscuraPath / OBSCURA_PATH).",
      ));
    });

    proc.on("exit", (code, signal) => {
      if (settled || code === 0) {
        return;
      }
      const detail = stderr.trim() || `signal ${signal ?? "unknown"}`;
      fail(new BrowserConnectionError(
        `Obscura exited before CDP was ready (code ${code ?? "null"}): ${detail}`,
      ));
    });

    void waitForCdp(cdpUrl, startupTimeoutMs)
      .then(() => {
        succeed({
          proc,
          cdpUrl,
          port,
          stop: () => stopObscuraProcess(proc),
        });
      })
      .catch((err) => {
        void stopObscuraProcess(proc);
        fail(err instanceof Error ? err : new BrowserConnectionError(String(err)));
      });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.killed) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      reject(new Error("Process did not exit in time"));
    }, timeoutMs);

    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };

    proc.once("exit", onExit);
  });
}
