import { spawn } from "node:child_process";
import type { IPty } from "node-pty";
import { RingBuffer } from "./ringBuffer.js";

const KILL_GRACE_MS = 5_000;
const KILL_MAX_WAIT_MS = 30_000;
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
};

export type TaskType = "browser";

export type TaskStatus = "running" | "done" | "error" | "stopped";

/**
 * An in-process background task managed alongside child processes.
 * Unlike a child process it has no pid/rings; it exposes a status, a short
 * summary, produced artifact paths and an idempotent `stop()`.
 */
export type Task = {
  id: string;
  type: TaskType;
  status: TaskStatus;
  /** Short human-readable outcome (empty while running). */
  summary: string;
  /** Paths to produced artifacts (reports, traces, downloads). */
  artifactPaths: string[];
  startedAt: Date;
  finishedAt?: Date;
  /** Latest progress label (e.g. last browser action). */
  lastAction?: string;
  /** Latest visited URL, when the task reports one. */
  lastUrl?: string;
  stop: () => void;
};

class ProcessSupervisor {
  private sessions = new Map<string, Session>();
  private tasks = new Map<string, Task>();
  private gcTimer?: NodeJS.Timeout;
  private logger?: (msg: string, level?: "warn" | "debug") => void;

  constructor() {
    this.startGc();
  }

  /** Inject a logger so warnings go to the agent loop instead of console. */
  setLogger(fn: (msg: string, level?: "warn" | "debug") => void): void {
    this.logger = fn;
  }

  private startGc(): void {
    this.gcTimer = setInterval(() => {
      this.gc();
    }, GC_INTERVAL_MS);
    this.gcTimer.unref();
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
    const session = this.sessions.get(handle);
    if (session) {
      return session;
    }
    return undefined;
  }

  /** Registers an in-process background task (e.g. an async browser run). */
  registerTask(task: Task): void {
    this.tasks.set(task.id, task);
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  listTasks(): { running: Task[]; finished: Task[] } {
    const running: Task[] = [];
    const finished: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        running.push(task);
      } else {
        finished.push(task);
      }
    }
    return { running, finished };
  }

  countRunningTasks(type: TaskType): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.type === type && task.status === "running") {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Closes out all in-process tasks at daemon boot. In-memory task state does
   * not survive a restart, so any leftover running task is a leftover from a
   * previous process and is marked "error: daemon restart".
   */
  completeTasksOnRestart(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        task.status = "error";
        task.summary = "daemon restart";
        task.finishedAt = new Date();
        try {
          task.stop();
        } catch {
          // stop() must never break the boot sweep
        }
      }
    }
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

  async kill(handle: string, signal: string = "SIGTERM"): Promise<
    | { exitCode: number | null; exitSignal: string | null }
    | { killed: false; reason: "timeout"; pid: number }
  > {
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
      const startTime = Date.now();

      const graceTimeoutId = setTimeout(() => {
        if (signal === "SIGTERM" && !session.exitedAt) {
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

      const maxTimeoutId = setTimeout(() => {
        clearTimeout(graceTimeoutId);
        const msg = `[processSupervisor] kill timeout after ${KILL_MAX_WAIT_MS}ms for session ${handle} (pid: ${session.pid})`;
        if (this.logger) {
          this.logger(msg, "warn");
        } else {
          console.warn(msg);
        }
        resolve({ killed: false, reason: "timeout", pid: session.pid });
      }, KILL_MAX_WAIT_MS);

      const checkExit = () => {
        if (session.exitedAt) {
          clearTimeout(graceTimeoutId);
          clearTimeout(maxTimeoutId);
          resolve({ exitCode: session.exitCode ?? null, exitSignal: session.exitSignal ?? null });
        } else if (Date.now() - startTime < KILL_MAX_WAIT_MS) {
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

    for (const [id, task] of this.tasks.entries()) {
      if (task.status !== "running" && task.finishedAt) {
        const age = now - task.finishedAt.getTime();
        if (age > GC_MAX_AGE_MS) {
          this.tasks.delete(id);
        }
      }
    }
  }

  destroy(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
    }

    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        try {
          task.stop();
        } catch {
          // best-effort
        }
      }
    }
    this.tasks.clear();

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
