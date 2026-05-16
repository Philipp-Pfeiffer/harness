import { describe, it, expect, vi, afterEach } from "vitest";
import { Type } from "@sinclair/typebox";
import { createAgent } from "../src/core/agent.js";
import { complete, stream, getModel } from "@mariozechner/pi-ai";
import type { Tool } from "../src/tools/types.js";
import type { AssistantMessageEventStream, Message } from "@mariozechner/pi-ai";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual("@mariozechner/pi-ai");
  return {
    ...actual,
    complete: vi.fn(),
    stream: vi.fn(),
  };
});

const echoArgs = Type.Object({ text: Type.String() });

const model = getModel("minimax", "MiniMax-M2.7");

function makeUserMessage(content: string): Message {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

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

function mockStream(finalMessage: any, tokens?: string[], signal?: AbortSignal): AssistantMessageEventStream {
  const events: any[] = [];
  if (tokens) {
    for (const token of tokens) {
      events.push({
        type: "text_delta",
        contentIndex: 0,
        delta: token,
        partial: makeAssistantMessage([], "stop"),
      });
    }
  }
  events.push({ type: "done", reason: finalMessage.stopReason, message: finalMessage });

  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        yield event;
      }
    },
    async result() {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return finalMessage;
    },
  } as unknown as AssistantMessageEventStream;
}

describe("Agent", () => {
  afterEach(() => {
    vi.mocked(complete).mockReset();
    vi.mocked(stream).mockReset();
  });

  it("returns text directly when stopReason is stop", async () => {
    const mockResponse = makeAssistantMessage([{ type: "text", text: "Hello, human!" }], "stop");
    vi.mocked(stream).mockReturnValueOnce(mockStream(mockResponse));

    const agent = createAgent({ tools: [], model });
    const result = await agent.run([makeUserMessage("Hi")]);

    expect(result).toEqual({ aborted: false, turns: 1, finalMessage: "Hello, human!" });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("executes tools and returns final response after toolUse", async () => {
    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_abc123", name: "echo", arguments: { text: "MiniMax funktioniert!" } }],
      "toolUse"
    );
    const mockFinal = makeAssistantMessage([{ type: "text", text: "Ja, das Echo-Tool funktioniert!" }], "stop");

    vi.mocked(stream)
      .mockReturnValueOnce(mockStream(mockToolCall))
      .mockReturnValueOnce(mockStream(mockFinal));

    const echoTool: Tool<typeof echoArgs> = {
      name: "echo",
      description: "Echo for tests",
      parameters: echoArgs,
      execute(args) { return args.text; },
    };
    const agent = createAgent({ tools: [echoTool], model });

    const result = await agent.run([makeUserMessage("Bitte rufe echo auf")]);

    expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Ja, das Echo-Tool funktioniert!" });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("throws when stopReason is error", async () => {
    const errorResponse = makeAssistantMessage([], "error", "Rate limit exceeded");
    vi.mocked(stream).mockReturnValueOnce(mockStream(errorResponse));

    const agent = createAgent({ tools: [], model });

    await expect(agent.run([makeUserMessage("Hi")])).rejects.toThrow("Rate limit exceeded");
  });

  it("returns message when stopReason is aborted", async () => {
    const abortedResponse = makeAssistantMessage([], "aborted");
    vi.mocked(stream).mockReturnValueOnce(mockStream(abortedResponse));

    const agent = createAgent({ tools: [], model });
    const result = await agent.run([makeUserMessage("Hi")]);

    expect(result).toEqual({ aborted: false, turns: 1, finalMessage: "Anfrage wurde abgebrochen." });
  });

  it("returns error when tool is not found", async () => {
    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_xyz", name: "nonexistent", arguments: {} }],
      "toolUse"
    );
    const mockFinal = makeAssistantMessage([{ type: "text", text: "Weiter gehts" }], "stop");

    vi.mocked(stream)
      .mockReturnValueOnce(mockStream(mockToolCall))
      .mockReturnValueOnce(mockStream(mockFinal));

    const agent = createAgent({ tools: [], model });
    const result = await agent.run([makeUserMessage("Call nonexistent tool")]);

    expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Weiter gehts" });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("returns error when tool arguments are invalid", async () => {
    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_bad", name: "echo", arguments: { notText: 123 } }],
      "toolUse"
    );
    const mockFinal = makeAssistantMessage([{ type: "text", text: "Weiter nach Validation" }], "stop");

    vi.mocked(stream)
      .mockReturnValueOnce(mockStream(mockToolCall))
      .mockReturnValueOnce(mockStream(mockFinal));

    const echoTool: Tool<typeof echoArgs> = {
      name: "echo",
      description: "Echo for tests",
      parameters: echoArgs,
      execute(args) { return args.text; },
    };
    const agent = createAgent({ tools: [echoTool], model });

    const result = await agent.run([makeUserMessage("Call echo with bad args")]);

    expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Weiter nach Validation" });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("returns max turns message when limit is reached", async () => {
    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_loop", name: "echo", arguments: { text: "loop" } }],
      "toolUse"
    );

    vi.mocked(stream).mockReturnValue(mockStream(mockToolCall));

    const echoTool: Tool<typeof echoArgs> = {
      name: "echo",
      description: "Echo for tests",
      parameters: echoArgs,
      execute(args) { return args.text; },
    };
    const agent = createAgent({ tools: [echoTool], model, maxIterations: 2 });

    const result = await agent.run([makeUserMessage("Keep calling tool")]);

    expect(result).toEqual({ aborted: true, completedTurns: 2, reason: "maxTurns" });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  describe("AbortSignal", () => {
    it("aborts before start → no LLM call, result aborted: true", async () => {
      const controller = new AbortController();
      controller.abort();

      const agent = createAgent({ tools: [], model });
      const result = await agent.run([makeUserMessage("Hi")], { signal: controller.signal });

      expect(result).toEqual({ aborted: true, completedTurns: 0, reason: "signal" });
      expect(stream).not.toHaveBeenCalled();
    });

    it("aborts mid-loop after LLM response, before tool exec → no tool executed", async () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } }],
        "toolUse"
      );

      const controller = new AbortController();
      vi.mocked(stream).mockImplementationOnce(() => {
        controller.abort();
        return mockStream(mockToolCall, undefined, controller.signal);
      });

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute() { return "should-not-run"; },
      };
      const agent = createAgent({ tools: [echoTool], model });
      const result = await agent.run([makeUserMessage("Call echo")], { signal: controller.signal });

      expect(result).toEqual({ aborted: true, completedTurns: 0, reason: "signal" });
      expect(stream).toHaveBeenCalledTimes(1);
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

      vi.mocked(stream).mockReturnValueOnce(mockStream(mockToolCall));

      const agent = createAgent({ tools: [slowTool], model });
      const result = await agent.run([makeUserMessage("Call slow")], { signal: controller.signal });

      expect(toolRuns).toBe(1);
      expect(result).toEqual({ aborted: true, completedTurns: 0, reason: "signal" });
      expect(stream).toHaveBeenCalledTimes(1);
    });
  });

  describe("Streaming", () => {
    it("emits token events for streaming text response", async () => {
      const tokens = ["Hello", ", ", "world", "!"];
      const mockResponse = makeAssistantMessage([{ type: "text", text: "Hello, world!" }], "stop");
      vi.mocked(stream).mockReturnValueOnce(mockStream(mockResponse, tokens));

      const events: import("../src/core/agent.js").AgentEvent[] = [];
      const agent = createAgent({ tools: [], model });
      const result = await agent.run([makeUserMessage("Hi")], {
        onEvent: (e) => events.push(e),
      });

      expect(result).toEqual({ aborted: false, turns: 1, finalMessage: "Hello, world!" });
      const tokenEvents = events.filter((e) => e.type === "token");
      expect(tokenEvents.length).toBeGreaterThanOrEqual(2);
      expect(tokenEvents.map((e) => e.text).join("")).toBe("Hello, world!");
    });

    it("emits ≥2 token events for response > 50 chars", async () => {
      const longText =
        "This is a rather long response that definitely exceeds fifty characters in total length.";
      const tokens = ["This is a ", "rather long response ", "that definitely exceeds ", "fifty characters in total length."];
      const mockResponse = makeAssistantMessage([{ type: "text", text: longText }], "stop");
      vi.mocked(stream).mockReturnValueOnce(mockStream(mockResponse, tokens));

      const events: import("../src/core/agent.js").AgentEvent[] = [];
      const agent = createAgent({ tools: [], model });
      await agent.run([makeUserMessage("Hi")], { onEvent: (e) => events.push(e) });

      const tokenEvents = events.filter((e) => e.type === "token");
      expect(tokenEvents.length).toBeGreaterThanOrEqual(2);
    });

    it("tool-call behaviour is unchanged after streaming refactor", async () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_abc123", name: "echo", arguments: { text: "MiniMax funktioniert!" } }],
        "toolUse"
      );
      const mockFinal = makeAssistantMessage([{ type: "text", text: "Ja, das Echo-Tool funktioniert!" }], "stop");

      vi.mocked(stream)
        .mockReturnValueOnce(mockStream(mockToolCall))
        .mockReturnValueOnce(mockStream(mockFinal));

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute(args) { return args.text; },
      };
      const agent = createAgent({ tools: [echoTool], model });

      const result = await agent.run([makeUserMessage("Bitte rufe echo auf")]);

      expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Ja, das Echo-Tool funktioniert!" });
      expect(stream).toHaveBeenCalledTimes(2);
    });

    it("aborts during stream → stream cancelled, no further token events after abort", async () => {
      const controller = new AbortController();
      const events: import("../src/core/agent.js").AgentEvent[] = [];

      vi.mocked(stream).mockImplementationOnce(() => {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "text_delta",
              contentIndex: 0,
              delta: "First",
              partial: makeAssistantMessage([], "stop"),
            };
            controller.abort();
            throw new DOMException("Aborted", "AbortError");
          },
          async result() {
            throw new DOMException("Aborted", "AbortError");
          },
        } as unknown as AssistantMessageEventStream;
      });

      const agent = createAgent({ tools: [], model });
      const result = await agent.run([makeUserMessage("Hi")], {
        signal: controller.signal,
        onEvent: (e) => events.push(e),
      });

      expect(result).toEqual({ aborted: true, completedTurns: 0, reason: "signal" });
      const tokenEvents = events.filter((e) => e.type === "token");
      expect(tokenEvents.length).toBe(1);
      expect(tokenEvents[0].text).toBe("First");
    });

    it("emits tool_call_start, tool_call_done and turn_end events", async () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } }],
        "toolUse"
      );
      const mockFinal = makeAssistantMessage([{ type: "text", text: "Done" }], "stop");

      vi.mocked(stream)
        .mockReturnValueOnce(mockStream(mockToolCall))
        .mockReturnValueOnce(mockStream(mockFinal));

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute(args) { return args.text; },
      };
      const agent = createAgent({ tools: [echoTool], model });

      const events: import("../src/core/agent.js").AgentEvent[] = [];
      await agent.run([makeUserMessage("Call echo")], { onEvent: (e) => events.push(e) });

      expect(events).toContainEqual({ type: "tool_call_start", name: "echo", args: { text: "hi" } });
      expect(events).toContainEqual({ type: "tool_call_done", name: "echo", result: "hi" });
      expect(events).toContainEqual({ type: "turn_end", turn: 1 });
    });

    it("emits tool_call_error event for missing tool", async () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "missing", arguments: {} }],
        "toolUse"
      );
      const mockFinal = makeAssistantMessage([{ type: "text", text: "Done" }], "stop");

      vi.mocked(stream)
        .mockReturnValueOnce(mockStream(mockToolCall))
        .mockReturnValueOnce(mockStream(mockFinal));

      const agent = createAgent({ tools: [], model });
      const events: import("../src/core/agent.js").AgentEvent[] = [];
      await agent.run([makeUserMessage("Call missing")], { onEvent: (e) => events.push(e) });

      expect(events).toContainEqual({
        type: "tool_call_error",
        name: "missing",
        error: 'Tool "missing" nicht gefunden.',
      });
    });
  });

  describe("Conversation History", () => {
    it("preserves messages across multiple turns", async () => {
      const history: Message[] = [];
      const agent = createAgent({ tools: [], model });

      const response1 = makeAssistantMessage([{ type: "text", text: "Hello!" }], "stop");
      vi.mocked(stream).mockReturnValueOnce(mockStream(response1));

      history.push(makeUserMessage("Hi"));
      const result1 = await agent.run(history);

      expect(result1.aborted).toBe(false);
      expect(history.length).toBe(2);
      expect(history[0].role).toBe("user");
      expect(history[1].role).toBe("assistant");

      const response2 = makeAssistantMessage([{ type: "text", text: "Nice to meet you!" }], "stop");
      vi.mocked(stream).mockImplementationOnce((_, context) => {
        expect(context.messages.length).toBe(3);
        expect(context.messages[0].role).toBe("user");
        expect(context.messages[1].role).toBe("assistant");
        expect(context.messages[2].role).toBe("user");
        expect((context.messages[2] as any).content).toBe("What's your name?");
        return mockStream(response2);
      });

      history.push(makeUserMessage("What's your name?"));
      const result2 = await agent.run(history);

      expect(result2.finalMessage).toBe("Nice to meet you!");
      expect(history.length).toBe(4);
      expect(history[3].role).toBe("assistant");
    });

    it("prepends system prompt to context but never stores it in the message array", async () => {
      const history: Message[] = [];
      const response = makeAssistantMessage([{ type: "text", text: "Done" }], "stop");

      vi.mocked(stream).mockImplementationOnce((_, context) => {
        expect(context.systemPrompt).toBe("You are a test agent");
        expect(context.messages).toBe(history);
        expect(context.messages.some((m: any) => m.role === "system")).toBe(false);
        return mockStream(response);
      });

      const agent = createAgent({ tools: [], model, systemPrompt: "You are a test agent" });
      history.push(makeUserMessage("Test"));
      await agent.run(history);
    });

    it("removes dangling assistant message when aborted before tool execution", async () => {
      const history: Message[] = [];
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } }],
        "toolUse"
      );

      const controller = new AbortController();
      vi.mocked(stream).mockImplementationOnce(() => {
        controller.abort();
        return mockStream(mockToolCall);
      });

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute() { return "done"; },
      };

      const agent = createAgent({ tools: [echoTool], model });
      history.push(makeUserMessage("Call echo"));
      const result = await agent.run(history, { signal: controller.signal });

      expect(result.aborted).toBe(true);
      expect(history.length).toBe(1);
      expect(history[0].role).toBe("user");
    });

    it("keeps assistant + tool results in history when aborted after tool results", async () => {
      const history: Message[] = [];
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } }],
        "toolUse"
      );

      const controller = new AbortController();
      let toolExecuted = false;

      vi.mocked(stream).mockReturnValueOnce(mockStream(mockToolCall));

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute() {
          toolExecuted = true;
          controller.abort();
          return "done";
        },
      };

      const agent = createAgent({ tools: [echoTool], model });
      history.push(makeUserMessage("Call echo"));
      const result = await agent.run(history, { signal: controller.signal });

      expect(result.aborted).toBe(true);
      expect(toolExecuted).toBe(true);
      expect(history.length).toBe(3); // user + assistant + toolResult
      expect(history[0].role).toBe("user");
      expect(history[1].role).toBe("assistant");
      expect(history[2].role).toBe("toolResult");
    });
  });
});
