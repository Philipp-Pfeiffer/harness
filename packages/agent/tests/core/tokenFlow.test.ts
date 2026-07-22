import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModel } from "@mariozechner/pi-ai";
import { stream } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { createAgent, createMetricsRecorder, type Tool } from "@harness/core";
import {
  readTodayMetrics,
  buildStatusSummary,
} from "../../src/core/statusSummary.js";
import type { AssistantMessageEventStream, Message, ToolCall } from "@mariozechner/pi-ai";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual("@mariozechner/pi-ai");
  return {
    ...actual,
    stream: vi.fn(),
  };
});

const model = getModel("minimax", "MiniMax-M2.7");
const TEST_DIR = join(tmpdir(), "harness-token-flow-test-" + process.pid);

interface FixtureTurn {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  text: string;
}

/**
 * Fixture: two-turn session with prompt caching on the first turn.
 *
 * Provider usage per API call:
 *   Turn 1 (toolUse): input=25, output=20, cacheRead=1500, cacheWrite=0, total=1545
 *   Turn 2 (stop):   input=1540, output=50, cacheRead=0, cacheWrite=0, total=1590
 *
 * Expected aggregate (Provider == Agent-Result == JSONL == /status):
 *   inputTokens=1565, outputTokens=70, totalTokens=3135,
 *   cacheRead=1500, cacheWrite=0
 */
const FIXTURE_TURNS: Array<FixtureTurn & { stopReason: "stop" | "toolUse"; text: string }> = [
  {
    input: 25,
    output: 20,
    cacheRead: 1500,
    cacheWrite: 0,
    totalTokens: 1545,
    stopReason: "toolUse",
    text: "Calling noop tool.",
  },
  {
    input: 1540,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1590,
    stopReason: "stop",
    text: "I can help you with code, files, and commands.",
  },
];

const noopArgs = Type.Object({});
const noopTool: Tool<typeof noopArgs> = {
  name: "noop",
  description: "No-op tool for tests",
  parameters: noopArgs,
  execute() {
    return "done";
  },
};

function makeUserMessage(content: string): Message {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

function makeAssistantMessage(
  turn: FixtureTurn & { stopReason: "stop" | "toolUse"; text: string },
): Message {
  const content: Array<{ type: "text"; text: string } | ToolCall> =
    turn.stopReason === "toolUse"
      ? [
          { type: "text", text: turn.text },
          {
            type: "toolCall",
            id: "tc_fixture",
            name: "noop",
            arguments: {},
          },
        ]
      : [{ type: "text", text: turn.text }];

  return {
    role: "assistant",
    content,
    stopReason: turn.stopReason,
    provider: "minimax",
    api: "anthropic-messages",
    model: "MiniMax-M2.7",
    usage: {
      input: turn.input,
      output: turn.output,
      cacheRead: turn.cacheRead,
      cacheWrite: turn.cacheWrite,
      totalTokens: turn.totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}

function mockStream(finalMessage: Message): AssistantMessageEventStream {
  const textContent = (finalMessage as any).content.find(
    (c: any) => c.type === "text",
  );
  return {
    async *[Symbol.asyncIterator]() {
      if (textContent) {
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta: textContent.text,
          partial: finalMessage,
        };
      }
      yield {
        type: "done",
        reason: (finalMessage as any).stopReason,
        message: finalMessage,
      };
    },
    async result() {
      return finalMessage as any;
    },
  } as unknown as AssistantMessageEventStream;
}

describe("token usage pipeline end-to-end", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    vi.mocked(stream).mockReset();
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("propagates the same token values through all four stages", async () => {
    // Arrange: mock provider responses from fixture
    for (const turn of FIXTURE_TURNS) {
      vi.mocked(stream).mockReturnValueOnce(mockStream(makeAssistantMessage(turn)));
    }

    const agent = createAgent({ tools: [noopTool], model });
    const recorder = createMetricsRecorder({ dir: TEST_DIR, sessionId: "sess-fixture" });
    const collectedProviderUsage: Array<{
      input: number;
      output: number;
      totalTokens: number;
      cacheRead: number;
      cacheWrite: number;
    }> = [];

    // Act: run agent across two turns — the agent loop now records turn metrics
    // internally (since the cache-hit-rate feature), so no manual recordTurn() needed.
    const result = await agent.run([makeUserMessage("Hi")], {
      metricsRecorder: recorder,
      onEvent: (event) => {
        if (event.type === "usage") {
          collectedProviderUsage.push({
            input: event.callInputTokens,
            output: event.callOutputTokens,
            totalTokens: event.callTotalTokens,
            cacheRead: event.callCacheRead,
            cacheWrite: event.callCacheWrite,
          });
        }
      },
    });

    // Wait for fire-and-forget JSONL append to complete.
    await new Promise((r) => setTimeout(r, 50));

    // Stage 4: read back metrics and build /status summary
    const metrics = await readTodayMetrics(TEST_DIR);
    const summary = await buildStatusSummary(
      {
        sessionState: "ready",
        toolCalls: 0,
        errors: 0,
        sessionUsage: result.usage,
      },
      metrics,
    );

    // Assert fixture expectations
    expect(result.aborted).toBe(false);
    expect(result.turns).toBe(2);

    // Stage 1: each provider response matches the fixture
    expect(collectedProviderUsage).toHaveLength(2);
    expect(collectedProviderUsage[0]).toEqual({
      input: FIXTURE_TURNS[0].input,
      output: FIXTURE_TURNS[0].output,
      totalTokens: FIXTURE_TURNS[0].totalTokens,
      cacheRead: FIXTURE_TURNS[0].cacheRead,
      cacheWrite: FIXTURE_TURNS[0].cacheWrite,
    });
    expect(collectedProviderUsage[1]).toEqual({
      input: FIXTURE_TURNS[1].input,
      output: FIXTURE_TURNS[1].output,
      totalTokens: FIXTURE_TURNS[1].totalTokens,
      cacheRead: FIXTURE_TURNS[1].cacheRead,
      cacheWrite: FIXTURE_TURNS[1].cacheWrite,
    });

    // Stage 2: agent result aggregates fixture values correctly
    expect(result.usage).toEqual({
      inputTokens: FIXTURE_TURNS[0].input + FIXTURE_TURNS[1].input,
      outputTokens: FIXTURE_TURNS[0].output + FIXTURE_TURNS[1].output,
      totalTokens:
        FIXTURE_TURNS[0].totalTokens + FIXTURE_TURNS[1].totalTokens,
      cacheRead: FIXTURE_TURNS[0].cacheRead + FIXTURE_TURNS[1].cacheRead,
      cacheWrite: FIXTURE_TURNS[0].cacheWrite + FIXTURE_TURNS[1].cacheWrite,
    });

    // Stage 3: JSONL aggregate matches agent result
    expect(metrics).not.toBeNull();
    expect(metrics!.inputTokens).toBe(result.usage.inputTokens);
    expect(metrics!.outputTokens).toBe(result.usage.outputTokens);
    expect(metrics!.totalTokens).toBe(result.usage.totalTokens);
    expect(metrics!.cacheRead).toBe(result.usage.cacheRead);
    expect(metrics!.cacheWrite).toBe(result.usage.cacheWrite);

    // Stage 4: /status summary exposes real token values and in+out+cache==total
    expect(summary.tokensIn).not.toBe("n/a");
    expect(summary.tokensOut).not.toBe("n/a");
    expect(summary.sessionTokens).not.toBe("n/a");
    expect(summary.tokensIn).toBe("3.1k"); // 1565 + 1500 + 0 = 3065
    expect(summary.tokensOut).toBe("70");
    expect(summary.sessionTokens).toBe("3.1k"); // 3135
    expect(summary.cacheHitRate).toBe("48.9%"); // 1500 / (1565+1500+0) = 48.94%
  });

  it("keeps /status values accurate when prompt caching is inactive", async () => {
    const turn = {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      stopReason: "stop" as const,
      text: "No cache here.",
    };

    vi.mocked(stream).mockReturnValueOnce(mockStream(makeAssistantMessage(turn)));

    const agent = createAgent({ tools: [], model });
    const recorder = createMetricsRecorder({ dir: TEST_DIR });
    const result = await agent.run([makeUserMessage("Hello")], {
      metricsRecorder: recorder,
    });

    await new Promise((r) => setTimeout(r, 50));
    const metrics = await readTodayMetrics(TEST_DIR);

    expect(metrics).not.toBeNull();
    expect(metrics!.inputTokens).toBe(100);
    expect(metrics!.outputTokens).toBe(50);
    expect(metrics!.totalTokens).toBe(150);
    expect(metrics!.cacheRead).toBe(0);
    expect(metrics!.cacheWrite).toBe(0);
  });
});
