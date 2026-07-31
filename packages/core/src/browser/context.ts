import type { BrowserReport } from "./types.js";
import type { BrowserEngine } from "./engine.js";

/** Mutable state shared across browser sub-agent tools within one session. */
export class BrowserSubAgentContext {
  readonly notes: string[] = [];
  readonly downloadedFiles: string[] = [];
  report: BrowserReport | null = null;
  private abort: (() => void) | null = null;

  constructor(
    readonly sessionId: string,
    readonly downloadDir: string,
    readonly engine: BrowserEngine,
  ) {}

  addNote(text: string): void {
    this.notes.push(text);
  }

  setAbortHandler(handler: () => void): void {
    this.abort = handler;
  }

  complete(report: BrowserReport): void {
    this.report = report;
    this.abort?.();
  }

  isComplete(): boolean {
    return this.report !== null;
  }
}
