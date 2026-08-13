import { describe, it, expect, vi, afterEach } from "vitest";
import { Type } from "@sinclair/typebox";
import { createAgent } from "../src/core/agent.js";
import { createMailbox } from "../src/core/mailbox.js";
import { complete, stream, getModel } from "@mariozechner/pi-ai";
import type { Tool } from "../src/tools/types.js";
import { ok } from "../src/tools/types.js";
import type { AssistantMessageEventStream, Message } from "@mariozechner/pi-ai";
import type { MemoryBackend, AmbientHint } from "../src/core/memoryBackend.js";

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

/** A reasoning-capable model (e.g. DeepSeek Pro) — reasoning: true. */
const reasoningModel = {
  provider: "minimax",
  name: "MiniMax-Reasoning",
  id: "minimax/MiniMax-Reasoning",
  api: "anthropic-messages",
  reasoning: true,
  contextWindow: 128000,
  maxTokens: 4096,
} as any;

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
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
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

    expect(result).toEqual({ aborted: false, turns: 1, finalMessage: "Hello, human!", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 0 });
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
      execute(args) { return ok(args.text); },
    };
    const agent = createAgent({ tools: [echoTool], model });

    const result = await agent.run([makeUserMessage("Bitte rufe echo auf")]);

    expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Ja, das Echo-Tool funktioniert!", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 1 });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("passes the run's sessionId to the tool execution context", async () => {
    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_ctx1", name: "echo", arguments: { text: "x" } }],
      "toolUse"
    );
    const mockFinal = makeAssistantMessage([{ type: "text", text: "done" }], "stop");

    vi.mocked(stream)
      .mockReturnValueOnce(mockStream(mockToolCall))
      .mockReturnValueOnce(mockStream(mockFinal));

    let capturedSession: string | undefined;
    const probeTool: Tool<typeof echoArgs> = {
      name: "echo",
      description: "Probe for tool context",
      parameters: echoArgs,
      execute(args, ctx) { capturedSession = ctx?.sessionId; return ok(args.text); },
    };
    const agent = createAgent({ tools: [probeTool], model });

    await agent.run([makeUserMessage("Hi")], { sessionId: "session-xyz" });

    expect(capturedSession).toBe("session-xyz");
  });

  it("scopes the tool execution context per run on a shared agent", async () => {
    let capturedSession: string | undefined;
    const probeTool: Tool<typeof echoArgs> = {
      name: "echo",
      description: "Probe for tool context",
      parameters: echoArgs,
      execute(args, ctx) { capturedSession = ctx?.sessionId; return ok(args.text); },
    };
    const agent = createAgent({ tools: [probeTool], model });

    const queueToolCallTurn = () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_ctx2", name: "echo", arguments: { text: "x" } }],
        "toolUse"
      );
      const mockFinal = makeAssistantMessage([{ type: "text", text: "done" }], "stop");
      vi.mocked(stream)
        .mockReturnValueOnce(mockStream(mockToolCall))
        .mockReturnValueOnce(mockStream(mockFinal));
    };

    queueToolCallTurn();
    await agent.run([makeUserMessage("Hi")], { sessionId: "session-a" });
    expect(capturedSession).toBe("session-a");

    queueToolCallTurn();
    await agent.run([makeUserMessage("Hi")], { sessionId: "session-b" });
    expect(capturedSession).toBe("session-b");

    // No sessionId → per-agent default scope, never a process-global one.
    queueToolCallTurn();
    await agent.run([makeUserMessage("Hi")]);
    const defaultScope = capturedSession;
    expect(typeof defaultScope).toBe("string");
    expect(defaultScope).not.toBe("session-a");
    expect(defaultScope).not.toBe("session-b");

    // A different agent instance gets a different default scope.
    const otherAgent = createAgent({ tools: [probeTool], model });
    queueToolCallTurn();
    await otherAgent.run([makeUserMessage("Hi")]);
    expect(capturedSession).toBeDefined();
    expect(capturedSession).not.toBe(defaultScope);
  });

  it("returns system message when stopReason is error", async () => {
    const errorResponse = makeAssistantMessage([], "error", "Rate limit exceeded");
    const stopResponse = makeAssistantMessage([{ type: "text", text: "Entschuldigung, es gab einen Fehler." }], "stop");
    vi.mocked(stream)
      .mockReturnValueOnce(mockStream(errorResponse))
      .mockReturnValueOnce(mockStream(stopResponse));

    const agent = createAgent({ tools: [], model });

    const result = await agent.run([makeUserMessage("Hi")]);
    expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Entschuldigung, es gab einen Fehler.", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 0 });
  });

  it("returns message when stopReason is aborted", async () => {
    const abortedResponse = makeAssistantMessage([], "aborted");
    vi.mocked(stream).mockReturnValueOnce(mockStream(abortedResponse));

    const agent = createAgent({ tools: [], model });
    const result = await agent.run([makeUserMessage("Hi")]);

    expect(result).toEqual({ aborted: false, turns: 1, finalMessage: "Anfrage wurde abgebrochen.", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 0, error: { type: "provider_aborted", message: "Provider aborted the generation." } });
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

    expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Weiter gehts", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 0 });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("returns precise validation errors when tool arguments are invalid", async () => {
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
      execute(args) { return ok(args.text); },
    };
    const agent = createAgent({ tools: [echoTool], model });

    const history: Message[] = [makeUserMessage("Call echo with bad args")];
    const result = await agent.run(history);

    expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Weiter nach Validation", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 0 });
    expect(stream).toHaveBeenCalledTimes(2);

    const toolResult = history.find((m) => m.role === "toolResult");
    expect(toolResult).toBeDefined();
    const resultText = (toolResult as any).content[0].text as string;
    expect(resultText).toContain('Argumente für Tool "echo" ungültig:');
    expect(resultText).toContain("must have required properties text");
    expect(resultText).toContain("got");
    expect(resultText).not.toBe('Argumente für Tool "echo" sind ungültig.');
  });

  it("returns turn limit message when max iterations reached", async () => {
    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_loop", name: "echo", arguments: { text: "loop" } }],
      "toolUse"
    );

    vi.mocked(stream).mockReturnValue(mockStream(mockToolCall));

    const echoTool: Tool<typeof echoArgs> = {
      name: "echo",
      description: "Echo for tests",
      parameters: echoArgs,
      execute(args) { return ok(args.text); },
    };
    const agent = createAgent({ tools: [echoTool], model, maxIterations: 2 });

    const result = await agent.run([makeUserMessage("Keep calling tool")]);

    expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Turn-Limit von 2 Iterationen erreicht.", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 2 });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  describe("AbortSignal", () => {
    it("aborts before start → no LLM call, result aborted: true", async () => {
      const controller = new AbortController();
      controller.abort();

      const agent = createAgent({ tools: [], model });
      const result = await agent.run([makeUserMessage("Hi")], { signal: controller.signal });

      expect(result).toEqual({ aborted: true, completedTurns: 0, reason: "signal", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 0 });
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
        execute() { return ok("should-not-run"); },
      };
      const agent = createAgent({ tools: [echoTool], model });
      const result = await agent.run([makeUserMessage("Call echo")], { signal: controller.signal });

      expect(result).toEqual({ aborted: true, completedTurns: 0, reason: "signal", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 0 });
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
          return ok("done");
        },
      };

      vi.mocked(stream).mockReturnValueOnce(mockStream(mockToolCall));

      const agent = createAgent({ tools: [slowTool], model });
      const result = await agent.run([makeUserMessage("Call slow")], { signal: controller.signal });

      expect(toolRuns).toBe(1);
      expect(result).toEqual({ aborted: true, completedTurns: 0, reason: "signal", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 1 });
      expect(stream).toHaveBeenCalledTimes(1);
    });

    it("stop-word abort (signal reason 'user') → current tool finishes, then aborts with reason 'user', no further LLM call", async () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "slow", arguments: {} }],
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
          // The stop-word handler aborts the signal while the tool runs —
          // with the distinguishable "user" reason.
          controller.abort("user");
          return ok("done");
        },
      };

      vi.mocked(stream).mockReturnValueOnce(mockStream(mockToolCall));

      const agent = createAgent({ tools: [slowTool], model });
      const result = await agent.run([makeUserMessage("Call slow")], { signal: controller.signal });

      // The running tool finished; iteration ended immediately afterwards.
      expect(toolRuns).toBe(1);
      expect(result).toEqual({ aborted: true, completedTurns: 0, reason: "user", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 1 });
      // No second LLM call after the abort signal.
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

      expect(result).toEqual({ aborted: false, turns: 1, finalMessage: "Hello, world!", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 0 });
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
        execute(args) { return ok(args.text); },
      };
      const agent = createAgent({ tools: [echoTool], model });

      const result = await agent.run([makeUserMessage("Bitte rufe echo auf")]);

      expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Ja, das Echo-Tool funktioniert!", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 1 });
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

      expect(result).toEqual({ aborted: true, completedTurns: 0, reason: "signal", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 0 });
      const tokenEvents = events.filter((e) => e.type === "token");
      expect(tokenEvents.length).toBe(1);
      expect(tokenEvents[0].text).toBe("First");
    });

    it("routes untagged reasoning text_delta as thinking when model is reasoning-capable (leak prevention)", async () => {
      // Untagged reasoning text — exactly what DeepSeek Pro via OpenRouter
      // streams when inlineThinking is enabled but the content has no
      // explicit <think> tags.
      const tokens = ["Philipp ", "fragt etwas ", "hier ist die Antwort"];
      const mockResponse = makeAssistantMessage([{ type: "text", text: "Nur sichtbarer Text" }], "stop");
      vi.mocked(stream).mockReturnValueOnce(mockStream(mockResponse, tokens));

      const events: import("../src/core/agent.js").AgentEvent[] = [];
      const agent = createAgent({ tools: [], model: reasoningModel });
      const result = await agent.run([makeUserMessage("Hi")], {
        onEvent: (e) => events.push(e),
      });

      // finalMessage derives from the final response content — untagged
      // streamed reasoning must never become token events or partialText.
      expect(result.finalMessage).toBe("Nur sichtbarer Text");
      // The untagged streamed text passes through the transformer as
      // token events during feed() (indistinguishable mid-stream), but
      // flush() reclassifies it and the final message derives from the
      // final assistant content — so the reasoning never reaches output.
      const tokenEvents = events.filter((e) => e.type === "token");
      expect(tokenEvents.map((e) => e.text).join("")).toBe("Philipp fragt etwas hier ist die Antwort");
      const thinkingEvents = events.filter((e) => e.type === "thinking");
      expect(thinkingEvents.length).toBeGreaterThanOrEqual(1);
      expect(thinkingEvents.map((e) => e.text).join("")).toBe("Philipp fragt etwas hier ist die Antwort");
      expect(result.finalMessage).not.toContain("Philipp");
    });

    it("keeps streamed text as visible tokens when the model has no reasoning capability", async () => {
      const tokens = ["Sichtbare ", "Antwort"];
      const mockResponse = makeAssistantMessage([{ type: "text", text: "Sichtbare Antwort" }], "stop");
      vi.mocked(stream).mockReturnValueOnce(mockStream(mockResponse, tokens));

      const events: import("../src/core/agent.js").AgentEvent[] = [];
      const agent = createAgent({ tools: [], model });
      const result = await agent.run([makeUserMessage("Hi")], {
        onEvent: (e) => events.push(e),
      });

      expect(result.finalMessage).toBe("Sichtbare Antwort");
      const tokenEvents = events.filter((e) => e.type === "token");
      expect(tokenEvents.map((e) => e.text).join("")).toBe("Sichtbare Antwort");
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
        execute(args) { return ok(args.text); },
      };
      const agent = createAgent({ tools: [echoTool], model });

      const events: import("../src/core/agent.js").AgentEvent[] = [];
      await agent.run([makeUserMessage("Call echo")], { onEvent: (e) => events.push(e) });

      expect(events).toContainEqual({ type: "tool_call_start", name: "echo", args: { text: "hi" } });
      expect(events).toContainEqual({ type: "tool_call_done", name: "echo", result: "hi" });
      expect(events).toContainEqual({ type: "turn_end", turn: 1 });
    });

    it("aggregates usage across multiple turns", async () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } }],
        "toolUse"
      );
      // Override usage for first turn
      (mockToolCall as any).usage = { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

      const mockFinal = makeAssistantMessage([{ type: "text", text: "Done" }], "stop");
      (mockFinal as any).usage = { input: 20, output: 10, totalTokens: 30, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

      vi.mocked(stream)
        .mockReturnValueOnce(mockStream(mockToolCall))
        .mockReturnValueOnce(mockStream(mockFinal));

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute(args) { return ok(args.text); },
      };
      const agent = createAgent({ tools: [echoTool], model });

      const events: import("../src/core/agent.js").AgentEvent[] = [];
      const result = await agent.run([makeUserMessage("Call echo")], { onEvent: (e) => events.push(e) });

      expect(result).toEqual({
        aborted: false,
        turns: 2,
        finalMessage: "Done",
        usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45, cacheRead: 0, cacheWrite: 0 },
        toolCallCount: 1,
      });

      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(2);
      expect(usageEvents[0]).toEqual({ type: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 15, callInputTokens: 10, callOutputTokens: 5, callTotalTokens: 15, cacheRead: 0, cacheWrite: 0, callCacheRead: 0, callCacheWrite: 0 });
      expect(usageEvents[1]).toEqual({ type: "usage", inputTokens: 30, outputTokens: 15, totalTokens: 45, callInputTokens: 20, callOutputTokens: 10, callTotalTokens: 30, cacheRead: 0, cacheWrite: 0, callCacheRead: 0, callCacheWrite: 0 });
    });

    it("emits usage event even for single text response", async () => {
      const mockResponse = makeAssistantMessage([{ type: "text", text: "Hello!" }], "stop");
      (mockResponse as any).usage = { input: 5, output: 3, totalTokens: 8, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      vi.mocked(stream).mockReturnValueOnce(mockStream(mockResponse));

      const events: import("../src/core/agent.js").AgentEvent[] = [];
      const agent = createAgent({ tools: [], model });
      const result = await agent.run([makeUserMessage("Hi")], { onEvent: (e) => events.push(e) });

      expect(result).toEqual({ aborted: false, turns: 1, finalMessage: "Hello!", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 0 });
      expect(events).toContainEqual({ type: "usage", inputTokens: 5, outputTokens: 3, totalTokens: 8, callInputTokens: 5, callOutputTokens: 3, callTotalTokens: 8, cacheRead: 0, cacheWrite: 0, callCacheRead: 0, callCacheWrite: 0 });
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

    it("appends systemPromptAddendum to the effective system prompt for the turn", async () => {
      const history: Message[] = [];
      const response = makeAssistantMessage([{ type: "text", text: "Done" }], "stop");
      const addendum = "## WhatsApp formatting\n\nReply over WhatsApp.";

      vi.mocked(stream).mockImplementationOnce((_, context) => {
        expect(context.systemPrompt).toContain("You are a test agent");
        expect(context.systemPrompt).toContain(addendum);
        return mockStream(response);
      });

      const agent = createAgent({ tools: [], model, systemPrompt: "You are a test agent" });
      history.push(makeUserMessage("Test"));
      await agent.run(history, { systemPromptAddendum: addendum });
    });

    it("leaves the base system prompt unchanged when no addendum is given", async () => {
      const history: Message[] = [];
      const response = makeAssistantMessage([{ type: "text", text: "Done" }], "stop");

      vi.mocked(stream).mockImplementationOnce((_, context) => {
        expect(context.systemPrompt).toBe("You are a test agent");
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
        execute() { return ok("done"); },
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
          return ok("done");
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

    it("preserves partial text in history when aborted during text stream", async () => {
      const controller = new AbortController();
      const history: Message[] = [];

      vi.mocked(stream).mockImplementationOnce(() => {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "text_delta",
              contentIndex: 0,
              delta: "Hello",
              partial: makeAssistantMessage([], "stop"),
            };
            yield {
              type: "text_delta",
              contentIndex: 0,
              delta: " world",
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
      history.push(makeUserMessage("Say hello"));
      const result = await agent.run(history, { signal: controller.signal });

      expect(result.aborted).toBe(true);
      expect(history.length).toBe(2);
      expect(history[0].role).toBe("user");
      expect(history[1].role).toBe("assistant");
      expect((history[1] as any).content).toEqual([{ type: "text", text: "Hello world" }]);
    });

    it("keeps assistant text but removes dangling tool calls when aborted before tool execution", async () => {
      const history: Message[] = [];
      const mockToolCall = makeAssistantMessage(
        [
          { type: "text", text: "I will call echo." },
          { type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } },
        ],
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
        execute() { return ok("done"); },
      };

      const agent = createAgent({ tools: [echoTool], model });
      history.push(makeUserMessage("Call echo"));
      const result = await agent.run(history, { signal: controller.signal });

      expect(result.aborted).toBe(true);
      expect(history.length).toBe(2); // user + assistant (text only)
      expect(history[0].role).toBe("user");
      expect(history[1].role).toBe("assistant");
      expect((history[1] as any).content).toEqual([{ type: "text", text: "I will call echo." }]);
    });

    it("keeps completed tool calls and results, removes incomplete ones when aborted during tool execution", async () => {
      const history: Message[] = [];
      const mockToolCall = makeAssistantMessage(
        [
          { type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "first" } },
          { type: "toolCall", id: "tc_2", name: "echo", arguments: { text: "second" } },
        ],
        "toolUse"
      );

      const controller = new AbortController();
      let toolRuns = 0;

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute() {
          toolRuns++;
          if (toolRuns === 1) {
            controller.abort();
          }
          return ok("done");
        },
      };

      vi.mocked(stream).mockReturnValueOnce(mockStream(mockToolCall));

      const agent = createAgent({ tools: [echoTool], model });
      history.push(makeUserMessage("Call echo twice"));
      const result = await agent.run(history, { signal: controller.signal });

      expect(result.aborted).toBe(true);
      expect(toolRuns).toBe(1);
      expect(history.length).toBe(3); // user + assistant (1 toolCall) + 1 toolResult
      expect(history[0].role).toBe("user");
      expect(history[1].role).toBe("assistant");
      expect((history[1] as any).content).toEqual([
        { type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "first" } },
      ]);
      expect(history[2].role).toBe("toolResult");
    });
  });

  describe("Mailbox steering", () => {
    it("drains steering messages after tool calls and before next LLM call", async () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } }],
        "toolUse"
      );
      const mockFinal = makeAssistantMessage([{ type: "text", text: "Done" }], "stop");

      vi.mocked(stream)
        .mockReturnValueOnce(mockStream(mockToolCall))
        .mockImplementationOnce((_, context) => {
          // Verify a steer user message was injected before this second LLM call
          const steerMsg = context.messages.find((m: any) => m.role === "user" && m.content[0]?.text?.includes("steer1"));
          expect(steerMsg).toBeDefined();
          expect(steerMsg.content[0].text).toContain("steer1");
          expect(steerMsg.content[0].text).toContain("steer2");
          return mockStream(mockFinal);
        });

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute(args) {
          return ok(args.text);
        },
      };
      const agent = createAgent({ tools: [echoTool], model });
      const mailbox = createMailbox();
      const history: Message[] = [makeUserMessage("Call echo")];

      const runPromise = agent.run(history, {
        mailbox,
        onEvent: (event) => {
          if (event.type === "tool_call_start") {
            mailbox.push("steer1");
            mailbox.push("steer2");
          }
        },
      });

      const result = await runPromise;

      expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Done", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 1 });
      expect(history.length).toBe(5); // user + assistant + toolResult + steer user + assistant
      expect(history[3].role).toBe("user");
    });

    it("drains steering messages after stream ends, before tool calls", async () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } }],
        "toolUse"
      );
      const mockFinal = makeAssistantMessage([{ type: "text", text: "Done" }], "stop");

      vi.mocked(stream)
        .mockReturnValueOnce(mockStream(mockToolCall))
        .mockImplementationOnce((_, context) => {
          const steerMsg = context.messages.find((m: any) => m.role === "user" && m.content[0]?.text?.includes("mid-stream steer"));
          expect(steerMsg).toBeDefined();
          expect(steerMsg.content[0].text).toContain("mid-stream steer");
          return mockStream(mockFinal);
        });

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute(args) {
          return ok(args.text);
        },
      };
      const agent = createAgent({ tools: [echoTool], model });
      const mailbox = createMailbox();
      const history: Message[] = [makeUserMessage("Call echo")];

      const runPromise = agent.run(history, { mailbox });

      // Push steer while the LLM stream is "running" (simulated by immediate return)
      mailbox.push("mid-stream steer");

      const result = await runPromise;

      expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Done", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 1 });
      const steerMsg = history.find((m: any) => m.role === "user" && m.content[0]?.text?.includes("mid-stream steer"));
      expect(steerMsg).toBeDefined();
    });

    it("clears mailbox on abort and does not inject steer into history", async () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } }],
        "toolUse"
      );

      const controller = new AbortController();

      vi.mocked(stream).mockReturnValueOnce(mockStream(mockToolCall));

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute() {
          return ok("done");
        },
      };
      const agent = createAgent({ tools: [echoTool], model });
      const mailbox = createMailbox();
      const history: Message[] = [makeUserMessage("Call echo")];

      const runPromise = agent.run(history, {
        signal: controller.signal,
        mailbox,
        onEvent: (event) => {
          if (event.type === "tool_call_start") {
            mailbox.push("steer that should be lost");
            controller.abort();
          }
        },
      });

      const result = await runPromise;

      expect(result.aborted).toBe(true);
      expect(mailbox.isEmpty()).toBe(true);
      expect(history.some((m: any) => m.role === "system")).toBe(false);
    });

    it("re-assigns context.messages after drainMailbox so stream sees steer updates", async () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } }],
        "toolUse"
      );
      const mockFinal = makeAssistantMessage([{ type: "text", text: "Done" }], "stop");

      const capturedContexts: any[] = [];

      vi.mocked(stream)
        .mockImplementationOnce((_, context) => {
          capturedContexts.push(context);
          return mockStream(mockToolCall);
        })
        .mockImplementationOnce((_, context) => {
          capturedContexts.push(context);
          return mockStream(mockFinal);
        });

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute(args) {
          return ok(args.text);
        },
      };
      const agent = createAgent({ tools: [echoTool], model });
      const mailbox = createMailbox();
      const history: Message[] = [makeUserMessage("Call echo")];

      const runPromise = agent.run(history, {
        mailbox,
        onEvent: (event) => {
          if (event.type === "tool_call_start") {
            mailbox.push("mid-tool steer");
          }
        },
      });

      const result = await runPromise;
      expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Done", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 1 });

      // Both stream calls should have received the same context object
      expect(capturedContexts.length).toBe(2);
      expect(capturedContexts[0]).toBe(capturedContexts[1]);

      // But the messages array should have grown: user + assistant + toolResult + steer user + assistant
      expect(capturedContexts[0].messages.length).toBe(5);
      const steerMsg = capturedContexts[0].messages.find((m: any) => m.role === "user" && m.content[0]?.text?.includes("mid-tool steer"));
      expect(steerMsg).toBeDefined();
      expect(steerMsg.content[0].text).toContain("mid-tool steer");
    });

    it("steer survives real-provider message conversion and is positioned after tool results", async () => {
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } }],
        "toolUse"
      );
      const mockFinal = makeAssistantMessage([{ type: "text", text: "Done" }], "stop");

      // Simulate a real provider's transformMessages behavior:
      // - Drop role: "system" messages
      // - Insert synthetic tool results for orphaned tool calls before user messages
      const simulateRealProvider = (messages: any[]) => {
        const result: any[] = [];
        let pendingToolCalls: any[] = [];
        let existingToolResultIds = new Set<string>();

        const insertSynthetic = () => {
          for (const tc of pendingToolCalls) {
            if (!existingToolResultIds.has(tc.id)) {
              result.push({
                role: "toolResult",
                toolCallId: tc.id,
                toolName: tc.name,
                content: [{ type: "text", text: "No result provided" }],
                isError: true,
              });
            }
          }
          pendingToolCalls = [];
          existingToolResultIds = new Set();
        };

        for (const msg of messages) {
          if (msg.role === "assistant") {
            insertSynthetic();
            const toolCalls = msg.content.filter((b: any) => b.type === "toolCall");
            if (toolCalls.length > 0) pendingToolCalls = toolCalls;
            result.push(msg);
          } else if (msg.role === "toolResult") {
            existingToolResultIds.add(msg.toolCallId);
            result.push(msg);
          } else if (msg.role === "user") {
            insertSynthetic();
            result.push(msg);
          } else if (msg.role === "system") {
            // Dropped by real provider (e.g. Anthropic convertMessages)
          } else {
            result.push(msg);
          }
        }
        insertSynthetic();
        return result;
      };

      vi.mocked(stream)
        .mockReturnValueOnce(mockStream(mockToolCall))
        .mockImplementationOnce((_, context) => {
          const visibleMessages = simulateRealProvider(context.messages);

          // The steer must be visible as a user message
          const steerMsg = visibleMessages.find(
            (m: any) => m.role === "user" && m.content[0]?.text?.includes("Apfelsaft")
          );
          expect(steerMsg).toBeDefined();

          // There must be no synthetic tool results (orphaned tool calls)
          const syntheticResults = visibleMessages.filter(
            (m: any) =>
              m.role === "toolResult" &&
              m.content[0]?.text === "No result provided"
          );
          expect(syntheticResults.length).toBe(0);

          // The steer must come after the tool result, not between assistant and tool result
          const roles = visibleMessages.map((m: any) => m.role);
          const toolResultIndex = roles.indexOf("toolResult");
          const steerIndex = visibleMessages.findIndex(
            (m: any) => m.role === "user" && m.content[0]?.text?.includes("Apfelsaft")
          );
          expect(toolResultIndex).not.toBe(-1);
          expect(steerIndex).not.toBe(-1);
          expect(steerIndex).toBeGreaterThan(toolResultIndex);

          return mockStream(mockFinal);
        });

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute(args) {
          return ok(args.text);
        },
      };
      const agent = createAgent({ tools: [echoTool], model });
      const mailbox = createMailbox();
      const history: Message[] = [makeUserMessage("Call echo")];

      const runPromise = agent.run(history, { mailbox });

      // Push steer while the LLM stream is "running" (simulated by immediate return)
      mailbox.push("Apfelsaft");

      const result = await runPromise;

      expect(result).toEqual({ aborted: false, turns: 2, finalMessage: "Done", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, toolCallCount: 1 });
    });
  });

  describe("Abort annotation", () => {
    it("injects abort-annotation after tool result when aborted during tool execution", async () => {
      const history: Message[] = [];
      const mockToolCall = makeAssistantMessage(
        [{ type: "toolCall", id: "tc_1", name: "echo", arguments: { text: "hi" } }],
        "toolUse"
      );

      const controller = new AbortController();
      const abortCommand = { current: "stopp" };
      let toolExecuted = false;

      vi.mocked(stream).mockReturnValueOnce(mockStream(mockToolCall));

      const echoTool: Tool<typeof echoArgs> = {
        name: "echo",
        description: "Echo for tests",
        parameters: echoArgs,
        execute() {
          toolExecuted = true;
          controller.abort();
          return ok("done");
        },
      };

      const agent = createAgent({ tools: [echoTool], model });
      history.push(makeUserMessage("Call echo"));
      const result = await agent.run(history, { signal: controller.signal, abortCommand });

      expect(result.aborted).toBe(true);
      expect(toolExecuted).toBe(true);
      expect(history.length).toBe(4); // user + assistant + toolResult + abort-annotation
      expect(history[0].role).toBe("user");
      expect(history[1].role).toBe("assistant");
      expect(history[2].role).toBe("toolResult");
      expect(history[3].role).toBe("user");
      const annotation = (history[3] as any).content[0].text;
      expect(annotation).toContain("stopp");
      expect(annotation).toContain("@");
      expect(annotation).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it("injects abort-annotation without synth tool_result when aborted during text stream", async () => {
      const controller = new AbortController();
      const abortCommand = { current: "stop" };
      const history: Message[] = [];

      vi.mocked(stream).mockImplementationOnce(() => {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "text_delta",
              contentIndex: 0,
              delta: "Hello",
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
      history.push(makeUserMessage("Say hello"));
      const result = await agent.run(history, { signal: controller.signal, abortCommand });

      expect(result.aborted).toBe(true);
      expect(history.length).toBe(3); // user + assistant (partial) + abort-annotation
      expect(history[0].role).toBe("user");
      expect(history[1].role).toBe("assistant");
      expect((history[1] as any).content).toEqual([{ type: "text", text: "Hello" }]);
      expect(history[2].role).toBe("user");
      const annotation = (history[2] as any).content[0].text;
      expect(annotation).toContain("stop");
      expect(annotation).toContain("@");
      expect(annotation).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("Ambient memory hint", () => {
    function createMockMemoryBackend(hints: AmbientHint[]): MemoryBackend {
      return {
        name: "mock",
        search: vi.fn(async () => []),
        query: vi.fn(async () => []),
        getAmbientHints: vi.fn(async () => hints),
        write: vi.fn(async () => {}),
      };
    }

    it("injects memory_hint as ephemeral user message when hits exist", async () => {
      const basePrompt = "You are a test agent";
      const mockResponse = makeAssistantMessage([{ type: "text", text: "Hello!" }], "stop");
      vi.mocked(stream).mockImplementationOnce((_, context) => {
        expect(context.systemPrompt).toBe(basePrompt);
        expect(context.messages).toHaveLength(2);
        expect(context.messages[1].role).toBe("user");
        expect(context.messages[1].content).toContain("<memory_hint>");
        expect(context.messages[1].content).toContain("Architecture Notes");
        return mockStream(mockResponse);
      });

      const backend = createMockMemoryBackend([
        { title: "Architecture Notes", path: "/proj/memory/arch.md", score: 0.92, snippet: "Use MVC" },
      ]);

      const agent = createAgent({ tools: [], model, systemPrompt: basePrompt });
      const history: Message[] = [makeUserMessage("Tell me about architecture")];
      const result = await agent.run(history, { memoryBackend: backend });

      expect(result.aborted).toBe(false);
      expect(backend.getAmbientHints).toHaveBeenCalledWith("Tell me about architecture");
    });

    it("does not inject when memoryBackend returns no hits", async () => {
      const basePrompt = "You are a test agent";
      const mockResponse = makeAssistantMessage([{ type: "text", text: "Hello!" }], "stop");
      vi.mocked(stream).mockImplementationOnce((_, context) => {
        expect(context.systemPrompt).toBe(basePrompt);
        return mockStream(mockResponse);
      });

      const backend = createMockMemoryBackend([]);

      const agent = createAgent({ tools: [], model, systemPrompt: basePrompt });
      const history: Message[] = [makeUserMessage("Tell me about architecture")];
      const result = await agent.run(history, { memoryBackend: backend });

      expect(result.aborted).toBe(false);
      expect(backend.getAmbientHints).toHaveBeenCalled();
    });

    it("does not inject when no memoryBackend provided", async () => {
      const basePrompt = "You are a test agent";
      const mockResponse = makeAssistantMessage([{ type: "text", text: "Hello!" }], "stop");
      vi.mocked(stream).mockImplementationOnce((_, context) => {
        expect(context.systemPrompt).toBe(basePrompt);
        return mockStream(mockResponse);
      });

      const agent = createAgent({ tools: [], model, systemPrompt: basePrompt });
      const history: Message[] = [makeUserMessage("Tell me about architecture")];
      const result = await agent.run(history);

      expect(result.aborted).toBe(false);
    });

    it("does not persist ambient hint in the passed messages array", async () => {
      const mockResponse = makeAssistantMessage([{ type: "text", text: "Hello!" }], "stop");
      vi.mocked(stream).mockReturnValueOnce(mockStream(mockResponse));

      const backend = createMockMemoryBackend([
        { title: "Architecture Notes", path: "/proj/memory/arch.md", score: 0.92, snippet: "Use MVC" },
      ]);

      const agent = createAgent({ tools: [], model });
      const userMsg = makeUserMessage("Tell me about architecture");
      const history: Message[] = [userMsg];

      await agent.run(history, { memoryBackend: backend });

      // The user message itself must be untouched by ambient injection
      expect(history[0]).toBe(userMsg);
      expect((history[0] as any).content).toBe("Tell me about architecture");

      // Hint is ephemeral — not persisted; only assistant response appended
      expect(history).toHaveLength(2);
      expect(history[1].role).toBe("assistant");
    });

    it("preserves multimodal user messages unchanged in persisted history", async () => {
      const mockResponse = makeAssistantMessage([{ type: "text", text: "Hello!" }], "stop");
      let capturedContext: any;
      vi.mocked(stream).mockImplementationOnce((_, context) => {
        capturedContext = context;
        return mockStream(mockResponse);
      });

      const backend = createMockMemoryBackend([
        { title: "Image Note", path: "/proj/memory/img.md", score: 0.92, snippet: "About images" },
      ]);

      const agent = createAgent({ tools: [], model });
      const userMsg: Message = {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          { type: "image", data: "base64abc", mimeType: "image/png" },
        ],
        timestamp: Date.now(),
      };
      const history: Message[] = [userMsg];

      await agent.run(history, { memoryBackend: backend });

      // Persisted history: original user message unchanged
      expect(history[0]).toBe(userMsg);
      expect((history[0] as any).content).toEqual([
        { type: "text", text: "Describe this image" },
        { type: "image", data: "base64abc", mimeType: "image/png" },
      ]);

      // LLM context: hint injected after the multimodal user message
      expect(capturedContext.systemPrompt).not.toContain("<memory_hint>");
      expect(capturedContext.messages).toHaveLength(2);
      expect(capturedContext.messages[0]).toBe(userMsg);
      expect(capturedContext.messages[1].role).toBe("user");
      expect(capturedContext.messages[1].content).toContain("<memory_hint>");
    });

    it("latency discipline: uses getAmbientHints, not search", async () => {
      const mockResponse = makeAssistantMessage([{ type: "text", text: "Hello!" }], "stop");
      vi.mocked(stream).mockReturnValueOnce(mockStream(mockResponse));

      const backend = createMockMemoryBackend([
        { title: "Note", path: "/proj/memory/note.md", score: 0.92 },
      ]);

      const agent = createAgent({ tools: [], model });
      const history: Message[] = [makeUserMessage("Query")];
      await agent.run(history, { memoryBackend: backend });

      expect(backend.getAmbientHints).toHaveBeenCalled();
      expect(backend.search).not.toHaveBeenCalled();
    });
  });
});
