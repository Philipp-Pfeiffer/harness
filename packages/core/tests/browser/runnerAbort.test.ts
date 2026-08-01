import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stream, getModel } from "@mariozechner/pi-ai";
import type { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { runBrowserSubAgent } from "../../src/browser/runner.js";
import type { BrowserEngine } from "../../src/browser/engine.js";
import type { SnapshotResult } from "../../src/browser/types.js";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return { ...actual, stream: vi.fn() };
});

class AbortMockEngine implements BrowserEngine {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async navigate(url: string): Promise<void> { void url; }
  async takeSnapshot(): Promise<SnapshotResult> {
    return {
      markdown: "# test",
      refs: new Map(),
      truncated: false,
      url: "https://example.com",
      title: "Example",
    };
  }
  async clickRef(): Promise<void> {}
  async typeRef(): Promise<void> {}
  async screenshot(): Promise<Buffer> { return Buffer.alloc(8); }
  async listTabs() { return []; }
  async newTab(): Promise<void> {}
  async selectTab(): Promise<void> {}
  async closeTab(): Promise<void> {}
  async downloadByRef(_r: number, p: string): Promise<string> { return p; }
  async downloadByUrl(_u: string, p: string): Promise<string> { return p; }
  getVisitedUrls(): string[] { return ["https://example.com"]; }
}

function mockStream(): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: "stop", message: { role: "assistant", content: [], stopReason: "stop" } };
    },
    async result() {
      return {
        role: "assistant",
        content: [],
        stopReason: "stop",
        provider: "minimax",
        api: "anthropic-messages",
        model: "MiniMax-M2.7",
        usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      };
    },
  } as unknown as AssistantMessageEventStream;
}

describe("runBrowserSubAgent parent abort", () => {
  afterEach(() => {
    vi.mocked(stream).mockReset();
  });

  it("returns synthesized failure report when parent signal is aborted", async () => {
    vi.mocked(stream).mockReturnValue(mockStream());
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "harness-browser-abort-"));
    const parent = new AbortController();
    parent.abort();

    const result = await runBrowserSubAgent(
      "sess-abort",
      {
        goal: "test abort",
        successCriteria: "report",
        resultFormat: "json",
        startUrl: "https://example.com",
      },
      {
        downloadsBaseDir: downloadsDir,
        browserRunsDir: path.join(downloadsDir, "browser-runs"),
        engineFactory: () => new AbortMockEngine(),
        parentSignal: parent.signal,
        browserConfig: { maxTurns: 2, model: "@preset/deepseek-flash" },
        models: [{
          provider: "openrouter",
          model: "@preset/deepseek-flash",
          alias: "DeepSeek Flash",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
        }],
        defaultModel: {
          provider: "openrouter",
          model: "@preset/deepseek-flash",
          alias: "DeepSeek Flash",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(result.report.goalAchieved).toBe(false);
    expect(result.report.result).toContain("aborted by user");
  });
});
