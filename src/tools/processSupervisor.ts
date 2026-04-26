import { spawn } from "node:child_process";
import type { IPty } from "node-pty";
import { RingBuffer } from "./ringBuffer.js";
import type { ExecToolResult } from "./exec.js";

const KILL_GRACE_MS = 5_000;
const GC_INTERVAL_MS = 5 * 60_000;
const GC_MAX_AGE_MS = 30 * 60_000;

export type Session = {
  handle: string;
  pid: number;
  command: string;
  startedAt: Date;
  exitedAt?: Date;
  exitCode?: number;
  exitSignal?: string;
  cwd: string;
  isPty: boolean;
  isElevated: boolean;
  child: ReturnType<typeof spawn> | IPty;
  stdoutRing: RingBuffer;
  stderrRing: RingBuffer;
  resolvePromise?: (value: ExecToolResult) => void;
};

class ProcessSupervisor {
  private sessions = new Map<string, Session>();
  private gcTimer?: NodeJS.Timeout;

  constructor() {
    this.startGc();
  }

  private startGc(): void {
    this.gcTimer = setInterval(() => {
      this.gc();
    }, GC_INTERVAL_MS);
  }

  register(session: Session): void {
    this.sessions.set(session.handle, session);

    const handler = (code: number | null, signal: string | null) => {
      const s = this.sessions.get(session.handle);
      if (s) {
        s.exitedAt = new Date();
        s.exitCode = code ?? undefined;
        s.exitSignal = signal ?? undefined;
      }

      if (session.resolvePromise) {
        const stdout = session.stdoutRing.getTotalBytes() > 0
          ? this.readTail(session.stdoutRing, 64 * 1024)
          : "";
        const stderr = session.isPty ? "" : (session.stderrRing.getTotalBytes() > 0
          ? this.readTail(session.stderrRing, 64 * 1024)
          : "");
        session.resolvePromise({
          isError: (code ?? 1) !== 0,
          content: `--- stdout ---\n${stdout || "(empty)"}\n--- stderr ---\n${stderr || "(empty)"}\n--- exit ---\ncode: ${code ?? "null"}, signal: ${signal ?? "null"}`,
        });
        session.resolvePromise = undefined;
      }

      setTimeout(() => {
        this.sessions.delete(session.handle);
      }, GC_MAX_AGE_MS);
    };

    if (session.isPty) {
      const pty = session.child as IPty;
      pty.onExit(({ exitCode, signal }) => {
        handler(exitCode, signal ? String(signal) : null);
      });
    } else {
      const child = session.child as ReturnType<typeof spawn>;
      child.on("exit", (code, signal) => {
        handler(code, signal);
      });
    }
  }

  private readTail(ring: RingBuffer, tailBytes: number): string {
    const total = ring.getTotalBytes();
    if (total === 0) return "";
    const offset = Math.max(0, total - tailBytes);
    return ring.read(offset, tailBytes).data;
  }

  get(handle: string): Session | undefined {
    return this.sessions.get(handle);
  }

  list(): { running: Session[]; finished: Session[] } {
    const running: Session[] = [];
    const finished: Session[] = [];

    for (const session of this.sessions.values()) {
      if (session.exitedAt) {
        finished.push(session);
      } else {
        running.push(session);
      }
    }

    return { running, finished };
  }

  async kill(handle: string, signal: string = "SIGTERM"): Promise<{ exitCode: number | null; exitSignal: string | null }> {
    const session = this.sessions.get(handle);
    if (!session) {
      return { exitCode: null, exitSignal: null };
    }

    if (session.exitedAt) {
      return { exitCode: session.exitCode ?? null, exitSignal: session.exitSignal ?? null };
    }

    if (session.isPty) {
      const pty = session.child as IPty;
      pty.kill(signal);
    } else {
      const child = session.child as ReturnType<typeof spawn>;
      if (child.pid) {
        process.kill(-child.pid, signal);
      }
    }

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        if (signal === "SIGTERM") {
          if (session.isPty) {
            (session.child as IPty).kill("SIGKILL");
          } else {
            const child = session.child as ReturnType<typeof spawn>;
            if (child.pid) {
              process.kill(-child.pid, "SIGKILL");
            }
          }
        }
      }, KILL_GRACE_MS);

      const checkExit = () => {
        if (session.exitedAt) {
          clearTimeout(timeoutId);
          resolve({ exitCode: session.exitCode ?? null, exitSignal: session.exitSignal ?? null });
        } else {
          setTimeout(checkExit, 100);
        }
      };
      setTimeout(checkExit, 100);
    });
  }

  pollOutput(handle: string, tailBytes: number = 4096): { stdout: string; stderr: string } {
    const session = this.sessions.get(handle);
    if (!session) {
      return { stdout: "", stderr: "" };
    }

    const stdout = session.stdoutRing.getTotalBytes() > 0
      ? this.readTail(session.stdoutRing, tailBytes)
      : "";
    const stderr = session.isPty ? "" : (session.stderrRing.getTotalBytes() > 0
      ? this.readTail(session.stderrRing, tailBytes)
      : "");

    return { stdout, stderr };
  }

  log(handle: string, offset: number, limit: number): {
    stdout: string;
    stderr: string;
    totalBytes: number;
    truncated: boolean;
  } {
    const session = this.sessions.get(handle);
    if (!session) {
      return { stdout: "", stderr: "", totalBytes: 0, truncated: false };
    }

    const stdoutResult = session.stdoutRing.read(offset, limit);
    const stderrResult = session.isPty
      ? { data: "", totalBytes: 0, truncated: false }
      : session.stderrRing.read(offset, limit);

    return {
      stdout: stdoutResult.data,
      stderr: stderrResult.data,
      totalBytes: stdoutResult.totalBytes,
      truncated: stdoutResult.truncated || stderrResult.truncated,
    };
  }

  async wait(handle: string, timeoutMs: number = 30_000): Promise<Session | null> {
    const session = this.sessions.get(handle);
    if (!session) {
      return null;
    }

    if (session.exitedAt) {
      return session;
    }

    return new Promise((resolve) => {
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, timeoutMs);

      const checkExit = () => {
        if (session.exitedAt) {
          clearTimeout(timeoutId);
          resolve(session);
        } else if (!timedOut) {
          setTimeout(checkExit, 100);
        }
      };
      setTimeout(checkExit, 100);
    });
  }

  private gc(): void {
    const now = Date.now();
    for (const [handle, session] of this.sessions.entries()) {
      if (session.exitedAt) {
        const age = now - session.exitedAt.getTime();
        if (age > GC_MAX_AGE_MS) {
          this.sessions.delete(handle);
        }
      }
    }
  }

  destroy(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
    }

    for (const session of this.sessions.values()) {
      if (!session.exitedAt) {
        if (session.isPty) {
          (session.child as IPty).kill("SIGTERM");
        } else {
          const child = session.child as ReturnType<typeof spawn>;
          if (child.pid) {
            process.kill(-child.pid, "SIGTERM");
          }
        }
      }
    }

    setTimeout(() => {
      for (const session of this.sessions.values()) {
        if (!session.exitedAt) {
          if (session.isPty) {
            (session.child as IPty).kill("SIGKILL");
          } else {
            const child = session.child as ReturnType<typeof spawn>;
            if (child.pid) {
              process.kill(-child.pid, "SIGKILL");
            }
          }
        }
      }
      this.sessions.clear();
    }, 2000);
  }
}

export const processSupervisor = new ProcessSupervisor();
