import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  classifyError,
  extractRetryAfter,
  computeBackoffDelay,
  TimeoutController,
  ProviderTimeoutError,
  sleepCancellable,
  DEFAULT_RETRY_POLICY,
  type ErrorClass,
} from "../../src/core/retryPolicy.js";

// ─── classifyError ──────────────────────────────────────────────

describe("classifyError", () => {
  it("returns user_abort when user signal is aborted (checked FIRST)", () => {
    const controller = new AbortController();
    controller.abort();
    const err = new DOMException("Aborted", "AbortError");
    expect(classifyError(err, controller.signal)).toBe("user_abort");
  });

  it("returns user_abort even when error is a 500", () => {
    const controller = new AbortController();
    controller.abort();
    const err = Object.assign(new Error("server error"), { status: 500 });
    expect(classifyError(err, controller.signal)).toBe("user_abort");
  });

  it("returns transient for AbortError without user signal (our timeout)", () => {
    const err = new DOMException("Aborted", "AbortError");
    expect(classifyError(err)).toBe("transient");
  });

  it("returns rate_limit for status 429", () => {
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    expect(classifyError(err)).toBe("rate_limit");
  });

  it("returns transient for 500/502/503/504", () => {
    for (const status of [500, 502, 503, 504]) {
      const err = Object.assign(new Error("Server Error"), { status });
      expect(classifyError(err)).toBe("transient");
    }
  });

  it("returns permanent for 400/401/403", () => {
    for (const status of [400, 401, 403]) {
      const err = Object.assign(new Error("Client Error"), { status });
      expect(classifyError(err)).toBe("permanent");
    }
  });

  it("returns transient for other 5xx errors", () => {
    const err = Object.assign(new Error("Server Error"), { status: 599 });
    expect(classifyError(err)).toBe("transient");
  });

  it("returns permanent for other 4xx errors", () => {
    const err = Object.assign(new Error("Client Error"), { status: 422 });
    expect(classifyError(err)).toBe("permanent");
  });

  it("returns transient for ECONNRESET message", () => {
    const err = new Error("ECONNRESET: connection reset");
    expect(classifyError(err)).toBe("transient");
  });

  it("returns permanent for context length exceeded", () => {
    const err = new Error("context length exceeded");
    expect(classifyError(err)).toBe("permanent");
  });

  it("returns rate_limit for rate limit exceeded message", () => {
    const err = new Error("rate limit exceeded");
    expect(classifyError(err)).toBe("rate_limit");
  });

  it("returns transient for generic Error (fallback)", () => {
    const err = new Error("something went wrong");
    expect(classifyError(err)).toBe("transient");
  });

  it("returns transient for undefined error (fallback)", () => {
    expect(classifyError(undefined)).toBe("transient");
  });

  it("user_abort takes precedence over 429", () => {
    const controller = new AbortController();
    controller.abort();
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    expect(classifyError(err, controller.signal)).toBe("user_abort");
  });
});

// ─── extractRetryAfter ───────────────────────────────────────────

describe("extractRetryAfter", () => {
  it("extracts retryAfter number property (seconds → ms)", () => {
    expect(extractRetryAfter({ retryAfter: 5 })).toBe(5000);
  });

  it("extracts from headers retry-after (lowercase)", () => {
    expect(extractRetryAfter({ headers: { "retry-after": "10" } })).toBe(10000);
  });

  it("extracts from headers Retry-After (capitalized)", () => {
    expect(extractRetryAfter({ headers: { "Retry-After": "10" } })).toBe(10000);
  });

  it("returns undefined when no retry-after info present", () => {
    expect(extractRetryAfter(new Error("nope"))).toBeUndefined();
    expect(extractRetryAfter({})).toBeUndefined();
    expect(extractRetryAfter({ headers: {} })).toBeUndefined();
  });

  it("returns undefined for invalid retry-after value", () => {
    expect(extractRetryAfter({ headers: { "retry-after": "not-a-number" } })).toBeUndefined();
  });

  it("handles numeric header value", () => {
    expect(extractRetryAfter({ headers: { "retry-after": 3 } })).toBe(3000);
  });
});

// ─── computeBackoffDelay ─────────────────────────────────────────

describe("computeBackoffDelay", () => {
  const policy: import("../../src/core/retryPolicy.js").RetryPolicy = {
    maxRetries: 3,
    timeoutMs: 10_000,
    backoffBaseMs: 1000,
    backoffMaxMs: 30_000,
    retryableClasses: ["transient", "rate_limit"],
  };

  it("attempt=1, base=1000 → delay between 1000 and 1499", () => {
    const delay = computeBackoffDelay(1, policy);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(1500);
  });

  it("attempt=2, base=1000 → delay between 2000 and 2999", () => {
    const delay = computeBackoffDelay(2, policy);
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThan(3000);
  });

  it("delay capped at backoffMaxMs", () => {
    const smallMaxPolicy = { ...policy, backoffMaxMs: 500 };
    const delay = computeBackoffDelay(5, smallMaxPolicy);
    // base would be 1000 * 2^4 = 16000, capped to 500
    // jitter = random * 250, so delay is 500..749
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThan(750);
  });

  it("with Math.random=0 → delay = base (no jitter)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(computeBackoffDelay(1, policy)).toBe(1000);
    expect(computeBackoffDelay(2, policy)).toBe(2000);
    vi.restoreAllMocks();
  });

  it("with Math.random=0.5 → delay = base + base/4", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    // attempt=1: base=1000, jitter=0.5*500=250 → 1250
    expect(computeBackoffDelay(1, policy)).toBe(1250);
    vi.restoreAllMocks();
  });

  it("with Math.random=1 → delay = base + base/2 (max jitter)", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    // attempt=1: base=1000, jitter=1*500=500 → 1500
    expect(computeBackoffDelay(1, policy)).toBe(1500);
    vi.restoreAllMocks();
  });
});

// ─── TimeoutController ──────────────────────────────────────────

describe("TimeoutController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("timer fires after timeoutMs → signal aborted, timedOut === true", () => {
    const tc = new TimeoutController(1000);
    expect(tc.signal.aborted).toBe(false);
    expect(tc.timedOut).toBe(false);

    vi.advanceTimersByTime(1000);

    expect(tc.signal.aborted).toBe(true);
    expect(tc.timedOut).toBe(true);
  });

  it("reset() postpones timer → signal NOT aborted after original timeout", () => {
    const tc = new TimeoutController(1000);

    vi.advanceTimersByTime(500);
    tc.reset(); // postpone — starts a fresh 1000ms timer

    // Without reset, 500 more ms (1000 total) would have triggered the timer.
    // With reset, only 500ms of the NEW 1000ms timer have elapsed → NOT aborted.
    vi.advanceTimersByTime(500);
    expect(tc.signal.aborted).toBe(false);

    // Now advance the remaining 500ms → 1000ms since reset → SHOULD be aborted
    vi.advanceTimersByTime(500);
    expect(tc.signal.aborted).toBe(true);
    expect(tc.timedOut).toBe(true);
  });

  it("user signal abort → internal signal also aborts, timedOut === false", () => {
    const userController = new AbortController();
    const tc = new TimeoutController(10_000, userController.signal);

    userController.abort();

    expect(tc.signal.aborted).toBe(true);
    expect(tc.timedOut).toBe(false);
  });

  it("abort() cleans up → signal aborted, timedOut === false", () => {
    const tc = new TimeoutController(10_000);

    tc.abort();

    expect(tc.signal.aborted).toBe(true);
    expect(tc.timedOut).toBe(false);
  });

  it("already-aborted user signal → internal signal aborted immediately in constructor", () => {
    const userController = new AbortController();
    userController.abort();

    const tc = new TimeoutController(10_000, userController.signal);

    expect(tc.signal.aborted).toBe(true);
    expect(tc.timedOut).toBe(false);
  });

  it("when timer fires, abort reason is ProviderTimeoutError", () => {
    const tc = new TimeoutController(500);

    vi.advanceTimersByTime(500);

    expect(tc.signal.reason).toBeInstanceOf(ProviderTimeoutError);
  });

  it("does not fire timer after abort()", () => {
    const tc = new TimeoutController(1000);

    tc.abort();
    expect(tc.timedOut).toBe(false);

    vi.advanceTimersByTime(2000);
    // Still not timed out — abort cleaned up the timer
    expect(tc.timedOut).toBe(false);
  });

  it("does not fire timer after user signal abort", () => {
    const userController = new AbortController();
    const tc = new TimeoutController(1000, userController.signal);

    userController.abort();
    expect(tc.timedOut).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(tc.timedOut).toBe(false);
  });
});

// ─── sleepCancellable ───────────────────────────────────────────

describe("sleepCancellable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after ms", async () => {
    let resolved = false;
    const p = sleepCancellable(1000).then(() => { resolved = true; });

    vi.advanceTimersByTime(999);
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(1);
    await p;
    expect(resolved).toBe(true);
  });

  it("rejects with AbortError when signal aborts during sleep", async () => {
    const controller = new AbortController();
    const p = sleepCancellable(5000, controller.signal);

    vi.advanceTimersByTime(1000);
    controller.abort();

    await expect(p).rejects.toThrow("Aborted");
  });

  it("already-aborted signal → rejects immediately", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sleepCancellable(5000, controller.signal)).rejects.toThrow("Aborted");
  });

  it("cleans up timer on abort", async () => {
    const controller = new AbortController();
    const p = sleepCancellable(5000, controller.signal).catch(() => {});

    controller.abort();
    await p;

    // If timer wasn't cleaned up, advancing time shouldn't cause issues
    vi.advanceTimersByTime(10_000);
    // No unhandled rejection — test passes if we get here
  });
});

// ─── DEFAULT_RETRY_POLICY ───────────────────────────────────────

describe("DEFAULT_RETRY_POLICY", () => {
  it("has expected defaults", () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_POLICY.timeoutMs).toBe(120_000);
    expect(DEFAULT_RETRY_POLICY.backoffBaseMs).toBe(1_000);
    expect(DEFAULT_RETRY_POLICY.backoffMaxMs).toBe(30_000);
    expect(DEFAULT_RETRY_POLICY.retryableClasses).toEqual(["transient", "rate_limit"]);
  });
});
