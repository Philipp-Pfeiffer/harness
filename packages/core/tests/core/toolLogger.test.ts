import { describe, it, expect, vi, afterEach } from "vitest";
import { Type } from "@sinclair/typebox";
import { createAgent } from "../../src/core/agent.js";
import { stream, getModel } from "@mariozechner/pi-ai";
import type { Tool, ToolResult, ToolCallContext } from "../../src/tools/types.js";
import { ok } from "../../src/tools/types.js";
import type { AssistantMessageEventStream, Message } from "@mariozechner/pi-ai";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual("@mariozechner/pi-ai");
  return { ...actual, stream: vi.fn() };
});

const model = getModel("minimax", "MiniMax-M2.7");

function makeAssistantMessage(content: any[], stopReason: string) {
  return {
    role: "assistant" as const,
    content,
    stopReason,
    provider: "minimax" as const,
    api: "anthropic-messages" as const,
    model: "MiniMax-M2.7",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

function makeUserMessage(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}

function mockStream(finalMessage: any): AssistantMessageEventStream {
  const events: any[] = [
    { type: "message_stop", partial: finalMessage },
    { type: "finish", result: async () => finalMessage },
  ];
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    async result() { return finalMessage as any; },
  } as unknown as AssistantMessageEventStream;
}

afterEach(() => vi.mocked(stream).mockReset());

describe("agent loop logger injection", () => {
  it("injects the provided logger into ToolCallContext", async () => {
    // Tool that captures the context and verifies logger is present
    let capturedContext: ToolCallContext | undefined;
    const probeTool: Tool = {
      name: "probe",
      description: "captures context",
      parameters: Type.Object({}),
      async execute(_args, context): Promise<ToolResult> {
        capturedContext = context;
        return ok("probe done");
      },
    };

    const loggedMessages: string[] = [];
    const logger = (msg: string) => { loggedMessages.push(msg); };

    vi.mocked(stream).mockReturnValueOnce(mockStream(
      makeAssistantMessage(
        [{ type: "toolCall", id: "1", name: "probe", arguments: {} }],
        "toolUse",
      ),
    ));
    vi.mocked(stream).mockReturnValueOnce(mockStream(
      makeAssistantMessage([{ type: "text", text: "done" }], "stop"),
    ));

    const agent = createAgent({ tools: [probeTool], model, logger });
    await agent.run([makeUserMessage("run probe")]);

    // The tool should have received a context with a logger
    expect(capturedContext).toBeDefined();
    expect(capturedContext!.logger).toBeDefined();
    expect(typeof capturedContext!.logger).toBe("function");

    // The agent loop should have logged the tool call
    expect(loggedMessages.some((m) => m.includes("[TOOL CALL]"))).toBe(true);
  });

  it("leaves context.logger undefined when no logger is provided", async () => {
    let capturedContext: ToolCallContext | undefined;
    const probeTool: Tool = {
      name: "probe",
      description: "captures context",
      parameters: Type.Object({}),
      async execute(_args, context): Promise<ToolResult> {
        capturedContext = context;
        return ok("probe done");
      },
    };

    vi.mocked(stream).mockReturnValueOnce(mockStream(
      makeAssistantMessage(
        [{ type: "toolCall", id: "1", name: "probe", arguments: {} }],
        "toolUse",
      ),
    ));
    vi.mocked(stream).mockReturnValueOnce(mockStream(
      makeAssistantMessage([{ type: "text", text: "done" }], "stop"),
    ));

    const agent = createAgent({ tools: [probeTool], model });
    await agent.run([makeUserMessage("run probe")]);

    expect(capturedContext).toBeDefined();
    expect(capturedContext!.logger).toBeUndefined();
  });
});
