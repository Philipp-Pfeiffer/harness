import { describe, it, expect, vi, afterEach } from "vitest";
import { Type } from "@sinclair/typebox";
import { createAgent } from "../src/core/agent.js";
import { stream, getModel } from "@mariozechner/pi-ai";
import type { Tool } from "../src/tools/types.js";
import { ok, err } from "../src/tools/types.js";
import type { AssistantMessageEventStream, Message } from "@mariozechner/pi-ai";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual("@mariozechner/pi-ai");
  return {
    ...actual,
    stream: vi.fn(),
  };
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
  content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted",
  errorMessage?: string,
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

function mockStream(finalMessage: ReturnType<typeof makeAssistantMessage>, tokens?: string[]): AssistantMessageEventStream {
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
        yield event;
      }
    },
    async result() {
      return finalMessage;
    },
  } as unknown as AssistantMessageEventStream;
}

function makeErrorStream(error: Error, tokens?: string[]): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      throw error;
    },
    async result() {
      throw error;
    },
  } as unknown as AssistantMessageEventStream;
}

function makeErrorThenSuccessStream(
  error: Error,
  successMsg: ReturnType<typeof makeAssistantMessage>,
): () => AssistantMessageEventStream {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      return makeErrorStream(error);
    }
    return mockStream(successMsg);
  };
}

describe("Agent resilience", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Test 1: exec non-zero exit code does NOT abort the turn.
  it("exec non-zero exit code returns as isError tool result, turn continues", async () => {
    const execArgs = Type.Object({ command: Type.String() });
    const execTool: Tool<typeof execArgs> = {
      name: "exec",
      description: "Run a command",
      parameters: execArgs,
      execute(args) {
        return ok(
          `--- stdout ---\n(empty)\n--- stderr ---\ncommand not found: ${args.command}\n--- exit ---\ncode: 1, signal: null`,
        );
      },
    };

    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_1", name: "exec", arguments: { command: "nonexistent" } }],
      "toolUse",
    );
    const mockFinal = makeAssistantMessage(
      [{ type: "text", text: "Der Befehl ist fehlgeschlagen. Soll ich einen anderen Weg versuchen?" }],
      "stop",
    );

    vi.mocked(stream)
      .mockReturnValueOnce(mockStream(mockToolCall))
      .mockReturnValueOnce(mockStream(mockFinal));

    const agent = createAgent({ tools: [execTool], model, maxIterations: 3 });
    const result = await agent.run([makeUserMessage("Run nonexistent")]);

    // Turn continues after exec error — no abort.
    expect(result.aborted).toBe(false);
    expect(result.finalMessage).toBe("Der Befehl ist fehlgeschlagen. Soll ich einen anderen Weg versuchen?");
  });

  // Test 2: API 429 rate limit error is retried, ultimately succeeds.
  it("API rate limit error is retried with backoff, turn continues", async () => {
    const error = Object.assign(new Error("Too Many Requests"), { status: 429, retryAfter: 0.001 });
    const stopMsg = makeAssistantMessage([{ type: "text", text: "ok after retry" }], "stop");

    vi.mocked(stream).mockImplementation(makeErrorThenSuccessStream(error, stopMsg));

    const agent = createAgent({ tools: [], model, maxIterations: 3 });
    const result = await agent.run([makeUserMessage("Hi")]);

    expect(result.aborted).toBe(false);
    expect(result.finalMessage).toBe("ok after retry");
    expect(stream).toHaveBeenCalledTimes(2); // first fails (retried), second succeeds
  });

  // Test 3: Code exception (throw in tool.execute) is caught as isError tool result.
  it("code exception in tool.execute returns as isError, turn continues", async () => {
    const crashArgs = Type.Object({});
    const crashTool: Tool<typeof crashArgs> = {
      name: "crash",
      description: "Always throws",
      parameters: crashArgs,
      execute() {
        throw new Error("something broke internally");
      },
    };

    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_bad", name: "crash", arguments: {} }],
      "toolUse",
    );
    const mockRecovery = makeAssistantMessage(
      [{ type: "text", text: "Ein Tool hat einen internen Fehler produziert. Ich versuche es anders." }],
      "stop",
    );

    vi.mocked(stream)
      .mockReturnValueOnce(mockStream(mockToolCall))
      .mockReturnValueOnce(mockStream(mockRecovery));

    const agent = createAgent({ tools: [crashTool], model, maxIterations: 3 });
    const result = await agent.run([makeUserMessage("Use crash tool")]);

    expect(result.aborted).toBe(false);
    expect(result.finalMessage).toBe("Ein Tool hat einen internen Fehler produziert. Ich versuche es anders.");
    expect(stream).toHaveBeenCalledTimes(2);
  });

  // Test 4: maxIterations exhausted → aborted:false with turn limit message.
  it("maxIterations exhausted returns aborted:false with turn limit message", async () => {
    const toolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_loop", name: "dummy", arguments: {} }],
      "toolUse",
    );
    vi.mocked(stream).mockReturnValue(mockStream(toolCall));

    const dummyArgs = Type.Object({});
    type DummyArgs = typeof dummyArgs.static;
    const dummyTool: Tool<typeof dummyArgs> = {
      name: "dummy",
      description: "dummy",
      parameters: dummyArgs,
      execute() { return ok("ok"); },
    };
    const agent = createAgent({ tools: [dummyTool], model, maxIterations: 2 });
    const result = await agent.run([makeUserMessage("Loop")]);

    expect(result.aborted).toBe(false);
    expect(result.finalMessage).toContain("Turn-Limit");
    expect(stream).toHaveBeenCalledTimes(2);
  });

  // Test 5: Last-turn warning is injected on final iteration.
  it("last turn injects system warning message", async () => {
    // On the last turn (i == maxIterations-1), the agent should get a system
    // message telling it to produce a final answer.

    const mockToolCall = makeAssistantMessage(
      [{ type: "toolCall", id: "tc_echo", name: "echo", arguments: { text: "hi" } }],
      "toolUse",
    );
    // For maxIterations=2: i=0 → toolUse, i=1 (last turn) → system message injected + LLM returns stop
    const mockFinal = makeAssistantMessage([{ type: "text", text: "Zusammenfassung des Erreichten." }], "stop");

    vi.mocked(stream)
      .mockReturnValueOnce(mockStream(mockToolCall))
      .mockReturnValueOnce(mockStream(mockFinal));

    const echoParams = Type.Object({ text: Type.String() });
    type EchoParams = typeof echoParams.static;
    const echoTool: Tool<typeof echoParams> = {
      name: "echo",
      description: "Echo",
      parameters: echoParams,
      execute(args: EchoParams) { return ok(args.text); },
    };
    const agent = createAgent({ tools: [echoTool], model, maxIterations: 2 });
    const result = await agent.run([makeUserMessage("Echo hi")]);

    expect(result.aborted).toBe(false);
    expect(result.finalMessage).toBe("Zusammenfassung des Erreichten.");
    expect(stream).toHaveBeenCalledTimes(2);
  });

  // Test 6: User-aborted turns still return aborted: true as before.
  it("user abort still returns aborted:true (backward compatible)", async () => {
    const controller = new AbortController();
    controller.abort();

    const agent = createAgent({ tools: [], model });
    const result = await agent.run([makeUserMessage("Hi")], { signal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(result.reason).toBe("signal");
    expect(stream).not.toHaveBeenCalled();
  });
});
