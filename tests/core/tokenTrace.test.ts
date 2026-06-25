import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  traceTokenUsage,
  setTokenTraceEnabled,
} from "../../src/core/tokenTrace.js";

describe("tokenTrace", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setTokenTraceEnabled(true);
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.HARNESS_TOKEN_TRACE;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    setTokenTraceEnabled(false);
  });

  it("emits a JSON snapshot to stderr when enabled", () => {
    traceTokenUsage("provider-response", {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 35,
      cacheRead: 5,
      cacheWrite: 0,
    });

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = (stderrSpy.mock.calls[0] as string[])[0];
    expect(line).toMatch(/^\[TOKEN-TRACE\] /);

    const payload = JSON.parse(line.replace(/^\[TOKEN-TRACE\] /, ""));
    expect(payload).toEqual({
      stage: "provider-response",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 35,
      cacheRead: 5,
      cacheWrite: 0,
    });
  });

  it("includes extra fields when provided", () => {
    traceTokenUsage(
      "metrics-jsonl",
      {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        cacheRead: 0,
        cacheWrite: 0,
      },
      { sessionId: "sess-1", status: "ok" },
    );

    const line = (stderrSpy.mock.calls[0] as string[])[0];
    const payload = JSON.parse(line.replace(/^\[TOKEN-TRACE\] /, ""));
    expect(payload.extra).toEqual({ sessionId: "sess-1", status: "ok" });
  });

  it("does not emit when disabled", () => {
    setTokenTraceEnabled(false);

    traceTokenUsage("provider-response", {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cacheRead: 0,
      cacheWrite: 0,
    });

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("is enabled by HARNESS_TOKEN_TRACE=1", () => {
    setTokenTraceEnabled(undefined as unknown as boolean);
    process.env.HARNESS_TOKEN_TRACE = "1";

    traceTokenUsage("status-summary", {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheRead: 0,
      cacheWrite: 0,
    });

    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });
});
