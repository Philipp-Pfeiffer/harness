import { describe, it, expect, vi, afterEach } from "vitest";
import { Type } from "@sinclair/typebox";
import { createAgent } from "../src/core/agent.js";
import { complete, getModel } from "@mariozechner/pi-ai";
import type { Tool } from "../src/tools/types.js";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual("@mariozechner/pi-ai");
  return {
    ...actual,
    complete: vi.fn(),
  };
});

const echoArgs = Type.Object({ text: Type.String() });

const model = getModel("minimax", "MiniMax-M2.7");

function makeAssistantMessage(
  content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted",
  errorMessage?: string
) {
  return {
    role: "assistant" as const,
    content,
    stopReason,
    provider: "minimax" as const,
    api: "anthropic-messages" as const,
    model: "MiniMax-M2.7",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
    errorMessage,
  };
}

describe("Agent", () => {
  afterEach(() => {
    vi.mocked(complete).mockReset();
  });

  it("returns text directly when stopReason is stop", async () => {
    const mockResponse = makeAssistantMessage([{ type: "text", text: "Hello, human!" }], "stop");
    vi.mocked(complete).mockResolvedValueOnce(mockResponse);

    const agent = createAgent({ tools: [], model });
    const result = await agent.run("Hi");

    expect(result).toEqual({ aborted: false, turns: 1, finalMessage: "Hello, human!" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("executes tools and returns final response after toolUse", async () => {
    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_abc123", name: "echo", arguments: { text: "MiniMax funktioniert!" } }],
      "toolUse"
    );
    const mockFinal = makeAssistantMessage([{ type: "text", text: "Ja, das Echo-Tool funktioniert!" }], "stop");

    vi.mocked(complete)
      .mockResolvedValueOnce(mockToolCall)
      .mockResolvedValueOnce(mockFinal);

    const echoTool: Tool<typeof echoArgs> = {
      name: "echo",
      description: "Echo for tests",
      parameters: echoArgs,
      execute(args) { return args.text; },
    };
    const agent = createAgent({ tools: [echoTool], model });

    const result = await agent.run("Bitte rufe echo auf");

    expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Ja, das Echo-Tool funktioniert!" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("throws when stopReason is error", async () => {
    const errorResponse = makeAssistantMessage([], "error", "Rate limit exceeded");
    vi.mocked(complete).mockResolvedValueOnce(errorResponse);

    const agent = createAgent({ tools: [], model });

    await expect(agent.run("Hi")).rejects.toThrow("Rate limit exceeded");
  });

  it("returns message when stopReason is aborted", async () => {
    const abortedResponse = makeAssistantMessage([], "aborted");
    vi.mocked(complete).mockResolvedValueOnce(abortedResponse);

    const agent = createAgent({ tools: [], model });
    const result = await agent.run("Hi");

    expect(result).toEqual({ aborted: false, turns: 1, finalMessage: "Anfrage wurde abgebrochen." });
  });

  it("returns error when tool is not found", async () => {
    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_xyz", name: "nonexistent", arguments: {} }],
      "toolUse"
    );
    const mockFinal = makeAssistantMessage([{ type: "text", text: "Weiter gehts" }], "stop");

    vi.mocked(complete)
      .mockResolvedValueOnce(mockToolCall)
      .mockResolvedValueOnce(mockFinal);

    const agent = createAgent({ tools: [], model });
    const result = await agent.run("Call nonexistent tool");

    expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Weiter gehts" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("returns error when tool arguments are invalid", async () => {
    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_bad", name: "echo", arguments: { notText: 123 } }],
      "toolUse"
    );
    const mockFinal = makeAssistantMessage([{ type: "text", text: "Weiter nach Validation" }], "stop");

    vi.mocked(complete)
      .mockResolvedValueOnce(mockToolCall)
      .mockResolvedValueOnce(mockFinal);

    const echoTool: Tool<typeof echoArgs> = {
      name: "echo",
      description: "Echo for tests",
      parameters: echoArgs,
      execute(args) { return args.text; },
    };
    const agent = createAgent({ tools: [echoTool], model });

    const result = await agent.run("Call echo with bad args");

    expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Weiter nach Validation" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("returns max turns message when limit is reached", async () => {
    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_loop", name: "echo", arguments: { text: "loop" } }],
      "toolUse"
    );

    vi.mocked(complete).mockResolvedValue(mockToolCall);

    const echoTool: Tool<typeof echoArgs> = {
      name: "echo",
      description: "Echo for tests",
      parameters: echoArgs,
      execute(args) { return args.text; },
    };
    const agent = createAgent({ tools: [echoTool], model, maxIterations: 2 });

    const result = await agent.run("Keep calling tool");

    expect(result).toEqual({ aborted: true, completedTurns: 2, reason: "maxTurns" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  describe("AbortSignal", () => {
    it("aborts before start → no LLM call, result aborted: true", async () => {
      const controller = new AbortController();
      controller.abort();

      const agent = createAgent({ tools: [], model });
      const result = await agent.run("Hi", { signal: controller.signal });

      expect(result).toEqual({ aborted: true, completedTurns: 0, reason: "signal" });
      expect(complete).not.toHaveBeenCalled();
    });

    it("aborts mid-loop after LLM response, before tool exec → no tool executed", async () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } }],
        "toolUse"
      );

      const controller = new AbortController();
      vi.mocked(complete).mockImplementationOnce(async () => {
        controller.abort();
        return mockToolCall;
      });

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute() { return "should-not-run"; },
      };
      const agent = createAgent({ tools: [echoTool], model });
      const result = await agent.run("Call echo", { signal: controller.signal });

      expect(result).toEqual({ aborted: true, completedTurns: 0, reason: "signal" });
      expect(complete).toHaveBeenCalledTimes(1);
    });

    it("aborts during tool execution → current tool finishes, no further tool calls or turns", async () => {
      const mockToolCall = makeAssistantMessage(
        [
          { type: "toolCall", id: "tc_1", name: "slow", arguments: {} },
          { type: "toolCall", id: "tc_2", name: "slow", arguments: {} },
        ],
        "toolUse"
    );

      const controller = new AbortController();
      let toolRuns = 0;

      const slowTool: Tool = {
        name: "slow",
        description: "Slow tool for tests",
        parameters: Type.Object({}),
        async execute() {
          toolRuns++;
          if (toolRuns === 1) {
            controller.abort();
          }
          return "done";
        },
      };

      vi.mocked(complete).mockResolvedValueOnce(mockToolCall);

      const agent = createAgent({ tools: [slowTool], model });
      const result = await agent.run("Call slow", { signal: controller.signal });

      expect(toolRuns).toBe(1);
      expect(result).toEqual({ aborted: true, completedTurns: 0, reason: "signal" });
      expect(complete).toHaveBeenCalledTimes(1);
    });
  });
});
