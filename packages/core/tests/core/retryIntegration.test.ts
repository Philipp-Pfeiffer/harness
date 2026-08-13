import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Type } from "@sinclair/typebox";
import { createAgent } from "../../src/core/agent.js";
import { complete, stream, getModel } from "@mariozechner/pi-ai";
import type { AssistantMessageEventStream, Message } from "@mariozechner/pi-ai";
import type { MetricsRecorder } from "../../src/core/metrics.js";
import type { ErrorClass, RetryPolicy } from "../../src/core/retryPolicy.js";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual("@mariozechner/pi-ai");
  return { ...actual, complete: vi.fn(), stream: vi.fn() };
});

const model = getModel("minimax", "MiniMax-M2.7");

function makeUserMessage(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}

function makeAssistantMessage(
  content: Array<{ type: "text"; text: string }>,
  stopReason: "stop" | "toolUse" | "error" | "aborted",
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
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        yield event;
      }
    },
    async result() {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return finalMessage;
    },
  } as unknown as AssistantMessageEventStream;
}

/**
 * Returns a factory that creates streams. The first `failCount` calls
 * produce a stream that throws `error` during iteration. Subsequent
 * calls produce a successful stream.
 */
function makeFailingThenSucceedingStream(
  successMessage: any,
  failCount: number,
  error: Error,
  tokens?: string[],
): (signal?: AbortSignal) => AssistantMessageEventStream {
  let callCount = 0;
  return (_signal?: AbortSignal) => {
    callCount++;
    if (callCount <= failCount) {
      return {
        async *[Symbol.asyncIterator]() {
          throw error;
        },
        async result() {
          throw error;
        },
      } as unknown as AssistantMessageEventStream;
    }
    return mockStream(successMessage, tokens, _signal);
  };
}

/**
 * Like makeFailingThenSucceedingStream, but the failing attempts emit
 * some tokens before throwing — simulating a mid-stream failure.
 */
function makePartialStreamThenSucceedingStream(
  successMessage: any,
  failCount: number,
  error: Error,
  partialTokens: string[],
): (signal?: AbortSignal) => AssistantMessageEventStream {
  let callCount = 0;
  return (signal?: AbortSignal) => {
    callCount++;
    if (callCount <= failCount) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const token of partialTokens) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            yield {
              type: "text_delta",
              contentIndex: 0,
              delta: token,
              partial: makeAssistantMessage([], "stop"),
            };
          }
          throw error;
        },
        async result() {
          throw error;
        },
      } as unknown as AssistantMessageEventStream;
    }
    return mockStream(successMessage, undefined, signal);
  };
}

const fastRetryPolicy: RetryPolicy = {
  maxRetries: 3,
  timeoutMs: 10_000,
  backoffBaseMs: 10,
  backoffMaxMs: 100,
  retryableClasses: ["transient", "rate_limit"] as ErrorClass[],
};

function makeMockMetricsRecorder(): MetricsRecorder & { retries: any[]; turns: any[]; errors: any[] } {
  const retries: any[] = [];
  const turns: any[] = [];
  const errors: any[] = [];
  return {
    retries,
    turns,
    errors,
    recordTurn(metric: any) { turns.push(metric); },
    recordToolCall(_metric: any) {},
    recordError(metric: any) { errors.push(metric); },
    recordDaemon(_metric: any) {},
    recordRetry(metric: any) { retries.push(metric); },
  } as any;
}

describe("Agent retry integration", () => {
  afterEach(() => {
    vi.mocked(stream).mockReset();
    vi.useRealTimers();
  });

  // 1. Transient error then success
  it("retries transient errors (503) and succeeds on attempt 3", async () => {
    const successMsg = makeAssistantMessage([{ type: "text", text: "Hello!" }], "stop");
    const error = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const factory = makeFailingThenSucceedingStream(successMsg, 2, error);

    vi.mocked(stream).mockImplementation(() => factory());

    const agent = createAgent({ tools: [], model, retryPolicy: fastRetryPolicy });
    const result = await agent.run([makeUserMessage("Hi")]);

    expect(result.aborted).toBe(false);
    expect(result.finalMessage).toBe("Hello!");
    expect(stream).toHaveBeenCalledTimes(3);
  });

  // 2. Permanent error — no retry
  it("injects permanent errors (401) as system message, does not retry", async () => {
    const error = Object.assign(new Error("Unauthorized"), { status: 401 });
    const stopMsg = makeAssistantMessage([{ type: "text", text: "should not reach" }], "stop");
    const factory = makeFailingThenSucceedingStream(stopMsg, 1, error);

    vi.mocked(stream).mockImplementation(() => factory());

    const agent = createAgent({ tools: [], model, retryPolicy: fastRetryPolicy });
    const result = await agent.run([makeUserMessage("Hi")]);

    // Permanent errors are injected as system message, agent continues.
    // The first call fails (401 → permanent), system message is injected.
    // The second call succeeds (stopMsg). 2 calls total.
    expect(result.aborted).toBe(false);
    expect(stream).toHaveBeenCalledTimes(2);
  });

  // 3. 429 with Retry-After then success
  it("retries 429 with retryAfter and succeeds", async () => {
    const successMsg = makeAssistantMessage([{ type: "text", text: "ok" }], "stop");
    const error = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      retryAfter: 0.001, // → 1ms
    });
    const factory = makeFailingThenSucceedingStream(successMsg, 1, error);

    vi.mocked(stream).mockImplementation(() => factory());

    const agent = createAgent({ tools: [], model, retryPolicy: fastRetryPolicy });
    const result = await agent.run([makeUserMessage("Hi")]);

    expect(result.aborted).toBe(false);
    expect(result.finalMessage).toBe("ok");
    expect(stream).toHaveBeenCalledTimes(2);
  });

  // 4. Max retries exhausted
  it("exhausts retries then injects system message and continues", async () => {
    const error = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const factory = makeFailingThenSucceedingStream(
      makeAssistantMessage([{ type: "text", text: "recovered" }], "stop"),
      3, // 3 failures, then success
      error,
    );

    vi.mocked(stream).mockImplementation(() => factory());

    const exhaustPolicy: RetryPolicy = {
      ...fastRetryPolicy,
      maxRetries: 2,
    };

    const agent = createAgent({ tools: [], model, retryPolicy: exhaustPolicy, maxIterations: 3 });
    const result = await agent.run([makeUserMessage("Hi")]);

    // 3 calls fail (initial + 2 retries) → injected system message → next iteration
    // 4th call succeeds after factory exhausted its failures
    expect(result.aborted).toBe(false);
    expect(stream).toHaveBeenCalledTimes(4);
  });

  // 5. User abort during retry wait
  it("aborts when user signal fires during backoff wait", async () => {
    vi.useFakeTimers();

    const error = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const successMsg = makeAssistantMessage([{ type: "text", text: "ok" }], "stop");
    const factory = makeFailingThenSucceedingStream(successMsg, 1, error);

    vi.mocked(stream).mockImplementation(() => factory());

    const abortPolicy: RetryPolicy = {
      maxRetries: 3,
      timeoutMs: 10_000,
      backoffBaseMs: 10_000, // 10s — long enough that we can abort mid-wait
      backoffMaxMs: 30_000,
      retryableClasses: ["transient"],
    };

    const controller = new AbortController();
    const agent = createAgent({ tools: [], model, retryPolicy: abortPolicy });

    const runPromise = agent.run([makeUserMessage("Hi")], { signal: controller.signal });

    // The first stream call throws 503 → enters sleepCancellable(10000, signal).
    // Abort the user signal — sleepCancellable should reject immediately.
    // Give the runtime a tick to reach the sleep.
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    const result = await runPromise;

    expect(result.aborted).toBe(true);
    expect((result as any).reason).toBe("signal");
    // Only 1 stream call — the retry never happened because we aborted during wait
    expect(stream).toHaveBeenCalledTimes(1);
  });

  // 6. Partial output discarded on retry
  it("discards partial output from failed attempt on retry", async () => {
    const successMsg = makeAssistantMessage([{ type: "text", text: "final answer" }], "stop");
    const error = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const partialTokens = ["partial", " ", "output"];
    const factory = makePartialStreamThenSucceedingStream(successMsg, 1, error, partialTokens);

    vi.mocked(stream).mockImplementation(() => factory());

    const agent = createAgent({ tools: [], model, retryPolicy: fastRetryPolicy });

    const history: Message[] = [makeUserMessage("Hi")];
    const result = await agent.run(history);

    expect(result.aborted).toBe(false);
    expect(result.finalMessage).toBe("final answer");

    // The messages array should contain: user msg + assistant response.
    // No partial output from the failed attempt.
    const assistantMsgs = history.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    const textContent = (assistantMsgs[0] as any).content[0];
    expect(textContent.text).toBe("final answer");
  });

  // 7. Metrics: recordRetry called with correct fields
  it("calls metricsRecorder.recordRetry with correct fields", async () => {
    const successMsg = makeAssistantMessage([{ type: "text", text: "ok" }], "stop");
    const error = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const factory = makeFailingThenSucceedingStream(successMsg, 1, error);

    vi.mocked(stream).mockImplementation(() => factory());

    const mockRecorder = makeMockMetricsRecorder();
    const agent = createAgent({ tools: [], model, retryPolicy: fastRetryPolicy });

    await agent.run([makeUserMessage("Hi")], { metricsRecorder: mockRecorder });

    expect(mockRecorder.retries).toHaveLength(1);
    expect(mockRecorder.retries[0]).toMatchObject({
      attempt: 1,
      maxRetries: 3,
      errorClass: "transient",
      errorMessage: "Service Unavailable",
      provider: "minimax",
      model: "MiniMax-M2.7",
    });
  });

  // 8. Default retry policy used when not specified
  it("works with default retry policy when retryPolicy not specified", async () => {
    const successMsg = makeAssistantMessage([{ type: "text", text: "ok" }], "stop");
    const error = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const factory = makeFailingThenSucceedingStream(successMsg, 1, error);

    vi.mocked(stream).mockImplementation(() => factory());

    // No retryPolicy set — uses DEFAULT_RETRY_POLICY internally
    const agent = createAgent({ tools: [], model });
    const result = await agent.run([makeUserMessage("Hi")]);

    expect(result.aborted).toBe(false);
    expect(result.finalMessage).toBe("ok");
    expect(stream).toHaveBeenCalledTimes(2);
  });

  // 9. reasoningEffort from the model is passed into stream options
  it("passes model reasoningEffort into stream options", async () => {
    const successMsg = makeAssistantMessage([{ type: "text", text: "ok" }], "stop");
    vi.mocked(stream).mockImplementation(() => mockStream(successMsg));

    const reasoningModel: typeof model & { reasoningEffort?: string } = {
      ...model,
      reasoningEffort: "high",
    };
    const agent = createAgent({ tools: [], model: reasoningModel, retryPolicy: fastRetryPolicy });
    await agent.run([makeUserMessage("Hi")]);

    const options = vi.mocked(stream).mock.calls[0]?.[2] as
      | { reasoningEffort?: string }
      | undefined;
    expect(options?.reasoningEffort).toBe("high");
  });
});
