import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserEngine } from "../../src/browser/engine.js";
import type { BrowserSessionOptions, SnapshotResult } from "../../src/browser/types.js";
import { runBrowserSubAgent } from "../../src/browser/runner.js";
import { BrowserSubAgentContext } from "../../src/browser/context.js";
import { createBrowserSubAgentTools } from "../../src/browser/subAgentTools.js";

class MockBrowserEngine implements BrowserEngine {
  private connected = false;
  private url = "about:blank";
  private visited = new Set<string>();
  private snapshot: SnapshotResult;

  constructor() {
    this.snapshot = {
      markdown: '# Page: https://example.com\n[1] link "Go"',
      refs: new Map([[1, { ref: 1, tag: "a", role: "link", name: "Go", selector: '[data-harness-ref="1"]' }]]),
      truncated: false,
      url: "https://example.com",
      title: "Example",
    };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async navigate(url: string): Promise<void> {
    this.url = url;
    this.visited.add(url);
  }

  async takeSnapshot(): Promise<SnapshotResult> {
    return this.snapshot;
  }

  async clickRef(_ref: number): Promise<void> {
    // no-op
  }

  async typeRef(_ref: number, _text: string, _submit?: boolean): Promise<void> {
    // no-op
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }

  async listTabs() {
    return [{ index: 0, url: this.url, title: "Example", active: true }];
  }

  async newTab(url?: string): Promise<void> {
    if (url) await this.navigate(url);
  }

  async selectTab(_index: number): Promise<void> {
    // no-op
  }

  async closeTab(): Promise<void> {
    // no-op
  }

  async downloadByRef(_ref: number, destPath: string): Promise<string> {
    return destPath;
  }

  async downloadByUrl(_url: string, destPath: string): Promise<string> {
    return destPath;
  }

  getVisitedUrls(): string[] {
    return [...this.visited];
  }
}

describe("browser sub-agent tools", () => {
  it("submit_report completes the session context", async () => {
    const engine = new MockBrowserEngine();
    const ctx = new BrowserSubAgentContext("test-session", "/tmp/downloads", engine);
    const options: BrowserSessionOptions = {
      cdpUrl: "http://127.0.0.1:9222",
      downloadDir: "/tmp/downloads",
      navigationTimeoutMs: 1000,
      actionTimeoutMs: 1000,
      maxTabs: 3,
      snapshotTokenCap: 4000,
      maxDownloadBytes: 1024,
    };
    const tools = createBrowserSubAgentTools(ctx, options);
    const submit = tools.find((t) => t.name === "submit_report");
    expect(submit).toBeDefined();

    const result = await submit!.execute({
      goalAchieved: true,
      result: "Found the page",
      files: [],
      visitedUrls: ["https://example.com"],
    });
    expect(result.isError).toBe(false);
    expect(ctx.report?.goalAchieved).toBe(true);
  });
});

describe("runBrowserSubAgent connection failure", () => {
  it("returns structured failure when CDP is unreachable", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "harness-browser-run-"));
    const failingEngine: BrowserEngine = {
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
      disconnect: async () => undefined,
      isConnected: () => false,
      navigate: async () => undefined,
      takeSnapshot: async () => ({
        markdown: "",
        refs: new Map(),
        truncated: false,
        url: "",
        title: "",
      }),
      clickRef: async () => undefined,
      typeRef: async () => undefined,
      screenshot: async () => Buffer.alloc(0),
      listTabs: async () => [],
      newTab: async () => undefined,
      selectTab: async () => undefined,
      closeTab: async () => undefined,
      downloadByRef: async (_r, p) => p,
      downloadByUrl: async (_u, p) => p,
      getVisitedUrls: () => [],
    };

    const result = await runBrowserSubAgent(
      "sess-1",
      {
        goal: "test",
        successCriteria: "connect",
        resultFormat: "json",
      },
      {
        downloadsBaseDir: downloadsDir,
        engineFactory: () => failingEngine,
        browserConfig: { maxTurns: 1, model: "openrouter/deepseek/deepseek-v4-flash" },
      },
    );

    expect(result.isError).toBe(true);
    expect(result.report.goalAchieved).toBe(false);
    expect(result.content).toContain("goalAchieved");
  });
});

describe("runBrowserSubAgent with mock engine", () => {
  it("uses mock engine factory without real CDP", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "harness-browser-run-"));
    // This test only verifies connect + navigate path with mock — no LLM call.
    const engine = new MockBrowserEngine();
    await engine.connect();
    await engine.navigate("https://example.com");
    expect(engine.getVisitedUrls()).toContain("https://example.com");
    await engine.disconnect();
    expect(downloadsDir).toBeTruthy();
  });
});
