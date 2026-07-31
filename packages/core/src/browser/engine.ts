import type { Page, Browser, BrowserContext } from "playwright-core";
import type { BrowserLaunchMode } from "../config.js";
import { BrowserConnectionError, BrowserSessionError } from "./errors.js";
import type { ObscuraSession } from "./obscura.js";
import { parseCdpPort, startObscura } from "./obscura.js";
import type { BrowserReport, BrowserSessionOptions, SnapshotResult } from "./types.js";
import { validateBrowserUrl } from "./urlSecurity.js";
import {
  buildSnapshotMarkdown,
  SNAPSHOT_COLLECTOR_SCRIPT,
  wrapUntrusted,
  type SnapshotCollectorResult,
} from "./snapshot.js";

export { BrowserConnectionError, BrowserSessionError } from "./errors.js";

export interface BrowserEngine {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  navigate(url: string): Promise<void>;
  takeSnapshot(): Promise<SnapshotResult>;
  clickRef(ref: number): Promise<void>;
  typeRef(ref: number, text: string, submit?: boolean): Promise<void>;
  screenshot(fullPage?: boolean): Promise<Buffer>;
  listTabs(): Promise<{ index: number; url: string; title: string; active: boolean }[]>;
  newTab(url?: string): Promise<void>;
  selectTab(index: number): Promise<void>;
  closeTab(index?: number): Promise<void>;
  downloadByRef(ref: number, destPath: string): Promise<string>;
  downloadByUrl(url: string, destPath: string): Promise<string>;
  getVisitedUrls(): string[];
}

export interface BrowserLaunchOptions {
  mode: BrowserLaunchMode;
  cdpUrl: string;
  obscuraPath: string;
  obscuraStartupTimeoutMs: number;
}

export interface BrowserEngineDeps {
  startObscura?: typeof startObscura;
}

const CDP_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Playwright CDP-backed browser engine using Obscura.
 * In obscura mode, spawns a managed Obscura process per session and tears it down on disconnect.
 */
export class PlaywrightBrowserEngine implements BrowserEngine {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Page[] = [];
  private activeIndex = 0;
  private refs = new Map<number, { selector: string }>();
  private visited = new Set<string>();
  private connecting: Promise<void> | null = null;
  private obscuraSession: ObscuraSession | null = null;

  constructor(
    private readonly launchOptions: BrowserLaunchOptions,
    private readonly options: BrowserSessionOptions,
    private readonly deps: BrowserEngineDeps = {},
  ) {}

  isConnected(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = this.doConnect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async doConnect(): Promise<void> {
    const { chromium } = await import("playwright-core");
    const cdpUrl = await this.resolveCdpUrl();

    try {
      this.browser = await chromium.connectOverCDP(cdpUrl, {
        timeout: CDP_CONNECT_TIMEOUT_MS,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new BrowserConnectionError(
        `Cannot connect to Obscura CDP at ${cdpUrl}: ${detail}`,
      );
    }

    await this.initFromBrowser();
  }

  private async resolveCdpUrl(): Promise<string> {
    if (this.launchOptions.mode === "cdp") {
      return this.launchOptions.cdpUrl;
    }

    const start = this.deps.startObscura ?? startObscura;
    this.obscuraSession = await start({
      executable: this.launchOptions.obscuraPath,
      startupTimeoutMs: this.launchOptions.obscuraStartupTimeoutMs,
    });
    return this.obscuraSession.cdpUrl;
  }

  private async initFromBrowser(): Promise<void> {
    if (!this.browser) {
      throw new BrowserConnectionError("Browser connection missing after connect");
    }

    const contexts = this.browser.contexts();
    this.context = contexts[0] ?? await this.browser.newContext({ acceptDownloads: true });
    const existing = this.context.pages();
    this.pages = existing.length > 0 ? [...existing] : [await this.context.newPage()];
    this.activeIndex = 0;
    this.wirePage(this.activePage());
  }

  private wirePage(page: Page): void {
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        const url = frame.url();
        if (url && !url.startsWith("about:")) {
          this.visited.add(url);
        }
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Best-effort teardown
      }
    }

    if (this.obscuraSession) {
      try {
        await this.obscuraSession.stop();
      } catch {
        // Best-effort teardown
      }
      this.obscuraSession = null;
    }

    this.browser = null;
    this.context = null;
    this.pages = [];
    this.activeIndex = 0;
    this.refs.clear();
  }

  private activePage(): Page {
    const page = this.pages[this.activeIndex];
    if (!page) {
      throw new BrowserConnectionError("No active browser page");
    }
    return page;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }
  }

  async navigate(url: string): Promise<void> {
    await this.ensureConnected();
    const { normalizedUrl } = await validateBrowserUrl(url);
    const page = this.activePage();
    await page.goto(normalizedUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.options.navigationTimeoutMs,
    });
    this.visited.add(page.url());
  }

  async takeSnapshot(): Promise<SnapshotResult> {
    await this.ensureConnected();
    const page = this.activePage();
    const url = page.url();
    const title = await page.title();
    const nodes = await page.evaluate(SNAPSHOT_COLLECTOR_SCRIPT) as SnapshotCollectorResult;
    const result = buildSnapshotMarkdown(url, title, nodes, this.options.snapshotTokenCap);
    this.refs.clear();
    for (const [ref, el] of result.refs) {
      this.refs.set(ref, { selector: el.selector });
    }
    return result;
  }

  async clickRef(ref: number): Promise<void> {
    await this.ensureConnected();
    const entry = this.refs.get(ref);
    if (!entry) {
      throw new BrowserSessionError(`Unknown element ref [${ref}]. Take a fresh browser_snapshot first.`);
    }
    const page = this.activePage();
    await page.locator(entry.selector).click({ timeout: this.options.actionTimeoutMs });
  }

  async typeRef(ref: number, text: string, submit?: boolean): Promise<void> {
    await this.ensureConnected();
    const entry = this.refs.get(ref);
    if (!entry) {
      throw new BrowserSessionError(`Unknown element ref [${ref}]. Take a fresh browser_snapshot first.`);
    }
    const page = this.activePage();
    const locator = page.locator(entry.selector);
    await locator.fill(text, { timeout: this.options.actionTimeoutMs });
    if (submit) {
      await locator.press("Enter", { timeout: this.options.actionTimeoutMs });
    }
  }

  async screenshot(fullPage = false): Promise<Buffer> {
    await this.ensureConnected();
    const page = this.activePage();
    return page.screenshot({ fullPage, type: "png", timeout: this.options.actionTimeoutMs });
  }

  async listTabs(): Promise<{ index: number; url: string; title: string; active: boolean }[]> {
    await this.ensureConnected();
    const results = [];
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i]!;
      results.push({
        index: i,
        url: page.url(),
        title: await page.title(),
        active: i === this.activeIndex,
      });
    }
    return results;
  }

  async newTab(url?: string): Promise<void> {
    await this.ensureConnected();
    if (this.pages.length >= this.options.maxTabs) {
      throw new BrowserSessionError(`Maximum tab limit (${this.options.maxTabs}) reached`);
    }
    const page = await this.context!.newPage();
    this.wirePage(page);
    this.pages.push(page);
    this.activeIndex = this.pages.length - 1;
    if (url) {
      await this.navigate(url);
    }
  }

  async selectTab(index: number): Promise<void> {
    await this.ensureConnected();
    if (index < 0 || index >= this.pages.length) {
      throw new BrowserSessionError(`Tab index ${index} out of range (0-${this.pages.length - 1})`);
    }
    this.activeIndex = index;
    await this.activePage().bringToFront();
  }

  async closeTab(index?: number): Promise<void> {
    await this.ensureConnected();
    const idx = index ?? this.activeIndex;
    if (idx < 0 || idx >= this.pages.length) {
      throw new BrowserSessionError(`Tab index ${idx} out of range`);
    }
    const page = this.pages[idx]!;
    await page.close();
    this.pages.splice(idx, 1);
    if (this.pages.length === 0) {
      const page = await this.context!.newPage();
      this.wirePage(page);
      this.pages.push(page);
    }
    this.activeIndex = Math.min(this.activeIndex, this.pages.length - 1);
  }

  async downloadByRef(ref: number, destPath: string): Promise<string> {
    await this.ensureConnected();
    const entry = this.refs.get(ref);
    if (!entry) {
      throw new BrowserSessionError(`Unknown element ref [${ref}]. Take a fresh browser_snapshot first.`);
    }
    const page = this.activePage();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: this.options.actionTimeoutMs }),
      page.locator(entry.selector).click({ timeout: this.options.actionTimeoutMs }),
    ]);
    await download.saveAs(destPath);
    return destPath;
  }

  async downloadByUrl(url: string, destPath: string): Promise<string> {
    await this.ensureConnected();
    const { normalizedUrl } = await validateBrowserUrl(url);
    const page = this.activePage();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: this.options.navigationTimeoutMs }),
      page.evaluate((target) => {
        const a = document.createElement("a");
        a.href = target;
        a.download = "";
        a.click();
      }, normalizedUrl),
    ]);
    await download.saveAs(destPath);
    return destPath;
  }

  getVisitedUrls(): string[] {
    return [...this.visited];
  }
}

export function formatSnapshotToolResult(snapshot: SnapshotResult): string {
  const parts = [wrapUntrusted(snapshot.markdown)];
  if (snapshot.truncated) {
    parts.push("\nNote: snapshot was truncated to fit token budget. Use browser_click/browser_type on visible refs.");
  }
  return parts.join("\n");
}

export function synthesizeFailureReport(
  reason: string,
  visitedUrls: string[],
  notes: string[],
): BrowserReport {
  return {
    goalAchieved: false,
    result: reason,
    files: [],
    visitedUrls,
    blockers: reason,
    notes: notes.length > 0 ? notes.join("\n") : undefined,
  };
}

export { parseCdpPort };
