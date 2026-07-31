/** Structured report returned by the browser sub-agent to the main agent. */
export interface BrowserReport {
  goalAchieved: boolean;
  result: string;
  files: string[];
  visitedUrls: string[];
  blockers?: string;
  notes?: string;
}

export interface SubmitReportArgs {
  goalAchieved: boolean;
  result: string;
  files?: string[];
  visitedUrls?: string[];
  blockers?: string;
}

export interface BrowserToolInput {
  goal: string;
  successCriteria: string;
  resultFormat: "markdown" | "json" | "files";
  startUrl?: string;
  context?: string;
}

export interface BrowserElementRef {
  ref: number;
  tag: string;
  role: string;
  name: string;
  selector: string;
}

export interface SnapshotResult {
  markdown: string;
  refs: Map<number, BrowserElementRef>;
  truncated: boolean;
  url: string;
  title: string;
}

export interface BrowserSessionOptions {
  cdpUrl: string;
  downloadDir: string;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  maxTabs: number;
  snapshotTokenCap: number;
  maxDownloadBytes: number;
}
