/**
 * Retry and timeout primitives for LLM provider calls.
 *
 * Self-contained — no imports. Designed for use by the agent loop but
 * testable in isolation.
 */

// ─── Types ─────────────────────────────────────────────────────

export type ErrorClass = "transient" | "rate_limit" | "permanent" | "user_abort" | "internal_restart";

export interface RetryPolicy {
  maxRetries: number;
  timeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  retryableClasses: ErrorClass[];
}

export interface RetryInfo {
  attempt: number; // 1-based attempt number that failed
  maxRetries: number;
  errorClass: ErrorClass;
  errorMessage: string;
  retryAfterMs?: number; // only for rate_limit with Retry-After header
  provider?: string;
  model?: string;
}

// ─── Default ───────────────────────────────────────────────────

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  timeoutMs: 120_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  retryableClasses: ["transient", "rate_limit"],
};

// ─── Error Class ─────────────────────────────────────────────'

export class ProviderTimeoutError extends Error {
  readonly timedOut: true;

  constructor(timeoutMs: number) {
    super(`Provider call timed out after ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
    this.timedOut = true;
  }
}

// ─── Duck-typing helpers ──────────────────────────────────────

function getErrorName(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "name" in err) {
    const name = (err as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}

function getErrorStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as Record<string, unknown>).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

// ─── classifyError ────────────────────────────────────────────

/*
 * Classification rules (in order — first match wins):
 *
 * 0. internalAbortSignal?.aborted → "internal_restart" (NEVER retryable, check FIRST — NOT a user abort)
 * 1. userSignal?.aborted → "user_abort" (NEVER retryable, check SECOND)
 * 2. AbortError with no user-abort → "transient" (our own timeout)
 * 3. HTTP status code based classification
 * 4. Network error message patterns → "transient"
 * 5. Context-length message patterns → "permanent"
 * 6. Provider-aborted patterns → "transient"
 * 7. Rate-limit message patterns → "rate_limit"
 * 8. Generic fallback → "transient"
 */
export function classifyError(
  err: unknown,
  userSignal?: AbortSignal,
  internalAbortSignal?: AbortSignal,
): ErrorClass {
  // Rule 0: internal restart — MUST be before user abort check
  if (internalAbortSignal?.aborted) {
    return "internal_restart";
  }

  // Rule 1: user abort — ALWAYS first, NEVER retryable
  if (userSignal?.aborted) {
    return "user_abort";
  }

  // Rule 2: AbortError without user signal → our own timeout
  if (getErrorName(err) === "AbortError") {
    return "transient";
  }

  // Rule 3: HTTP status based
  const status = getErrorStatus(err);
  if (status !== undefined) {
    if (status === 429) return "rate_limit";
    if (status === 500 || status === 502 || status === 503 || status === 504) return "transient";
    if (status === 400 || status === 401 || status === 403) return "permanent";
    if (status >= 500 && status < 600) return "transient";
    if (status >= 400 && status < 500) return "permanent";
  }

  // Rules 4-7: message-based
  const msg = getErrorMessage(err).toLowerCase();

  // Rule 4: network error patterns → transient
  const networkPatterns = [
    "econnreset",
    "econnrefused",
    "etimedout",
    "enotfound",
    "fetch failed",
    "network error",
    "socket hang up",
  ];
  for (const pattern of networkPatterns) {
    if (msg.includes(pattern)) return "transient";
  }

  // Rule 5: context-length patterns → permanent
  const contextPatterns = [
    "context length",
    "context_length",
    "maximum context",
    "too long",
    "token limit",
  ];
  for (const pattern of contextPatterns) {
    if (msg.includes(pattern)) return "permanent";
  }

  // Rule 6: provider aborted → transient
  if (msg.includes("provider aborted") || msg.includes("provider_aborted")) {
    return "transient";
  }

  // Rule 7: rate limit patterns → rate_limit
  if (msg.includes("rate limit") || msg.includes("too many requests")) {
    return "rate_limit";
  }

  // Rule 8: generic fallback — provider errors default to transient
  return "transient";
}

// ─── extractRetryAfter ─────────────────────────────────────────

function getHeaders(err: unknown): Record<string, unknown> | undefined {
  if (typeof err === "object" && err !== null && "headers" in err) {
    const headers = (err as Record<string, unknown>).headers;
    if (typeof headers === "object" && headers !== null) {
      return headers as Record<string, unknown>;
    }
  }
  return undefined;
}

function parseRetryAfterHeader(val: unknown): number | undefined {
  if (typeof val === "number") {
    return val * 1000;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    // Numeric string → seconds → ms
    const asNum = Number(trimmed);
    if (!Number.isNaN(asNum) && trimmed.length > 0) {
      return asNum * 1000;
    }
    // Date string → compute ms from now
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return Math.max(0, parsed - Date.now());
    }
  }
  return undefined;
}

export function extractRetryAfter(err: unknown): number | undefined {
  // err.retryAfter (number, assume seconds → * 1000)
  if (typeof err === "object" && err !== null && "retryAfter" in err) {
    const retryAfter = (err as Record<string, unknown>).retryAfter;
    if (typeof retryAfter === "number") {
      return retryAfter * 1000;
    }
  }

  // err.headers?.["retry-after"] or ["Retry-After"]
  const headers = getHeaders(err);
  if (headers) {
    const headerVal = headers["retry-after"] ?? headers["Retry-After"];
    if (headerVal !== undefined) {
      return parseRetryAfterHeader(headerVal);
    }
  }

  return undefined;
}

// ─── computeBackoffDelay ──────────────────────────────────────

/**
 * Exponential backoff with jitter (50% spread).
 *
 * - base = backoffBaseMs * 2^(attempt-1), capped at backoffMaxMs
 * - jitter = Math.random() * (base / 2)
 * - return base + jitter
 *
 * @param attempt  1-based attempt number
 * @param policy   retry policy with backoff parameters
 */
export function computeBackoffDelay(attempt: number, policy: RetryPolicy): number {
  const base = Math.min(
    policy.backoffBaseMs * Math.pow(2, attempt - 1),
    policy.backoffMaxMs
  );
  const jitter = Math.random() * (base / 2);
  return base + jitter;
}

// ─── TimeoutController ─────────────────────────────────────────

/**
 * Inactivity-based timeout controller.
 *
 * Wraps an internal AbortController that fires after `timeoutMs` of
 * inactivity (call `reset()` on every chunk to keep it alive). Links
 * to an optional user signal so that user-abort propagates immediately.
 *
 * The `timedOut` getter distinguishes our timeout from user-abort.
 */
export class TimeoutController {
  readonly signal: AbortSignal;
  private _timedOut = false;
  private _internalAbort = false;
  private readonly controller: AbortController = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly timeoutMs: number;
  private readonly userSignal: AbortSignal | undefined;
  private readonly onUserAbort: (() => void) | undefined = undefined;
  private readonly internalSignal: AbortSignal | undefined;
  private readonly onInternalAbort: (() => void) | undefined = undefined;

  constructor(timeoutMs: number, userSignal?: AbortSignal, internalSignal?: AbortSignal) {
    this.timeoutMs = timeoutMs;
    this.signal = this.controller.signal;
    this.userSignal = userSignal;
    this.internalSignal = internalSignal;

    if (userSignal?.aborted) {
      this.controller.abort(userSignal.reason);
      return;
    }

    if (internalSignal?.aborted) {
      this._internalAbort = true;
      this.controller.abort(internalSignal.reason);
      return;
    }

    if (userSignal) {
      this.onUserAbort = () => {
        this.clearTimer();
        this.controller.abort(userSignal.reason);
      };
      userSignal.addEventListener("abort", this.onUserAbort, { once: true });
    }

    if (internalSignal) {
      this.onInternalAbort = () => {
        this._internalAbort = true;
        this.clearTimer();
        this.controller.abort(internalSignal.reason);
      };
      internalSignal.addEventListener("abort", this.onInternalAbort, { once: true });
    }

    this.startTimer();
  }

  private startTimer(): void {
    this.timer = setTimeout(() => {
      this._timedOut = true;
      this.controller.abort(new ProviderTimeoutError(this.timeoutMs));
    }, this.timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Reset the inactivity timer (call on every chunk). */
  reset(): void {
    this.clearTimer();
    this.startTimer();
  }

  /** Manually abort for cleanup. Removes userSignal/internalSignal listeners if present. */
  abort(): void {
    this.clearTimer();
    if (this.onUserAbort && this.userSignal) {
      this.userSignal.removeEventListener("abort", this.onUserAbort);
    }
    if (this.onInternalAbort && this.internalSignal) {
      this.internalSignal.removeEventListener("abort", this.onInternalAbort);
    }
    this.controller.abort();
  }

  /** True if this controller's timeout fired (NOT user/internal abort). */
  get timedOut(): boolean {
    return this._timedOut;
  }

  /** True if the internal (gateway restart) signal fired. */
  get internalAborted(): boolean {
    return this._internalAbort;
  }
}

// ─── sleepCancellable ──────────────────────────────────────────

/**
 * Returns a promise that resolves after `ms` milliseconds.
 *
 * If `signal` aborts during the wait, rejects immediately with an
 * AbortError (DOMException) and cleans up the timer.
 */
export function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };

    timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
