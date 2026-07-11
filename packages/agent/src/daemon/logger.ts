import { mkdir, appendFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  data?: Record<string, unknown>;
}

/**
 * Structured logger that writes JSON Lines to daily-rotated files.
 *
 * - File naming: daemon-YYYY-MM-DD.log
 * - Rotation is implicit: a new date → a new file, automatically.
 * - Cleanup: on init and on each write boundary, files older than
 *   `retentionDays` are deleted to prevent unbounded growth.
 *
 * Never throws — logging errors are swallowed (best-effort).
 */
export class DaemonLogger {
  private readonly logDir: string;
  private readonly retentionDays: number;
  private readonly minLevel: number;
  private lastCleanupDate: string | null = null;

  constructor(opts: {
    logDir: string;
    retentionDays?: number;
    minLevel?: LogLevel;
  }) {
    this.logDir = opts.logDir;
    this.retentionDays = opts.retentionDays ?? 14;
    this.minLevel = LEVEL_ORDER[opts.minLevel ?? "info"];
  }

  async init(): Promise<void> {
    await mkdir(this.logDir, { recursive: true });
    await this.cleanup();
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.write("debug", "daemon", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.write("info", "daemon", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.write("warn", "daemon", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.write("error", "daemon", msg, data);
  }

  /**
   * Creates a child logger scoped to a specific component name.
   * Shares the same log directory and retention settings.
   */
  child(component: string): ComponentLogger {
    return new ComponentLogger(this, component);
  }

  /** Returns the current daily log file path. */
  currentFilePath(): string {
    return join(this.logDir, `daemon-${dateKey(new Date())}.log`);
  }

  // Internal — called by ComponentLogger
  _write(
    level: LogLevel,
    component: string,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    this.write(level, component, msg, data);
  }

  private writeQueue: Promise<void> = Promise.resolve();

  private write(
    level: LogLevel,
    component: string,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component,
      msg,
      ...(data ? { data } : {}),
    };
    const line = JSON.stringify(entry) + "\n";

    // Serialize writes to maintain entry ordering
    this.writeQueue = this.writeQueue
      .then(() => this.appendLine(line))
      .catch(() => {});
  }

  private async appendLine(line: string): Promise<void> {
    try {
      const today = dateKey(new Date());
      // Check if we crossed a date boundary for cleanup
      if (this.lastCleanupDate !== today) {
        this.lastCleanupDate = today;
        await this.cleanup();
      }
      await appendFile(join(this.logDir, `daemon-${today}.log`), line, "utf-8");
    } catch {
      // Logging must never crash the daemon
    }
  }

  /** Deletes log files older than `retentionDays`. */
  async cleanup(): Promise<void> {
    try {
      const files = await readdir(this.logDir);
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      for (const file of files) {
        if (!file.startsWith("daemon-") || !file.endsWith(".log")) continue;
        // Extract date from filename: daemon-YYYY-MM-DD.log
        const dateStr = file.slice("daemon-".length, -".log".length);
        const fileDate = new Date(dateStr + "T00:00:00Z");
        if (fileDate.getTime() < cutoff) {
          await unlink(join(this.logDir, file));
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Component-scoped logger that delegates to a parent DaemonLogger
 * with a fixed component name.
 */
export class ComponentLogger {
  constructor(
    private readonly parent: DaemonLogger,
    private readonly component: string,
  ) {}

  debug(msg: string, data?: Record<string, unknown>): void {
    this.parent._write("debug", this.component, msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.parent._write("info", this.component, msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.parent._write("warn", this.component, msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.parent._write("error", this.component, msg, data);
  }
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
