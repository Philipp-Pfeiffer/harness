import { describe, it, expect, vi, afterEach } from "vitest";
import { Type } from "@sinclair/typebox";
import { stream, getModel } from "@mariozechner/pi-ai";
import type { AssistantMessageEventStream, Message } from "@mariozechner/pi-ai";
import { createAgent } from "../src/core/agent.js";
import type { Tool } from "../src/tools/types.js";
import { ok } from "../src/tools/types.js";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return { ...actual, stream: vi.fn() };
});

const model = getModel("minimax", "MiniMax-M2.7");

function makeUserMessage(content: string): Message {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

function makeAssistantMessage(
  content: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  >,
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted",
) {
  return {
    role: "assistant" as const,
    content,
    stopReason,
    provider: "minimax" as const,
    api: "anthropic-messages" as const,
    model: "MiniMax-M2.7",
    usage: {
      input: 0,
      output: 0,
      totalTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}

function mockStream(finalMessage: ReturnType<typeof makeAssistantMessage>): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "done",
        reason: finalMessage.stopReason,
        message: finalMessage,
      };
    },
    async result() {
      return finalMessage;
    },
  } as unknown as AssistantMessageEventStream;
}

describe("agent abort tool propagation", () => {
  afterEach(() => {
    vi.mocked(stream).mockReset();
  });

  it("passes abort signal to tool context", async () => {
    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_1", name: "observe", arguments: {} }],
      "toolUse",
    );
    const mockStop = makeAssistantMessage([{ type: "text", text: "done" }], "stop");
    vi.mocked(stream)
      .mockReturnValueOnce(mockStream(mockToolCall))
      .mockReturnValueOnce(mockStream(mockStop));

    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;

    const observeTool: Tool = {
      name: "observe",
      description: "Observes abort signal",
      parameters: Type.Object({}),
      async execute(_args, context) {
        observedSignal = context?.signal;
        return ok("done");
      },
    };

    const agent = createAgent({ tools: [observeTool], model });
    await agent.run([makeUserMessage("run tool")], { signal: controller.signal });

    expect(observedSignal).toBe(controller.signal);
    expect(observedSignal?.aborted).toBe(false);
  });
});
