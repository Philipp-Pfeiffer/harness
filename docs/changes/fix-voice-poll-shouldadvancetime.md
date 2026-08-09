# fix: voice poll test flake — shouldAdvanceTime

## Symptom

`packages/agent/tests/whatsapp/voice.test.ts` flaked under CPU load (~8 saturated cores). The three polling tests (timeout, success, transcription-error) occasionally timed out at 20s despite commit c3c1da7 (injectable pollIntervalMs/pollTimeoutMs).

Failing output pattern:
```
FAIL  returns timeout when polling never completes  20012ms  → Test timed out in 20000ms.
```
Successful runs in the same context took ~5006ms and ~20007ms.

## Root Cause

The test used a `withTimers` helper that calls `vi.advanceTimersByTimeAsync(3000)` in a loop (up to 200 iterations). Under CPU load, each `advanceTimersByTimeAsync` call burns ~3000ms of real wall-clock time because vitest's fake timer implementation processes the timer core synchronously but the async wrapping adds scheduling overhead proportional to system load.

The polling loop uses `sleep(5)` and `pollTimeoutMs: 50`, so nominally the loop resolves after 10-11 iterations. But with real wall-time of ~3s per iteration:
- 1 iteration = ~3000ms wall
- 7 iterations ≈ 21s wall → exceeds 20s test timeout

## Fix

Replace `vi.useFakeTimers()` with `vi.useFakeTimers({ shouldAdvanceTime: true })` in `beforeEach`, and remove the `withTimers` helper + its usage on the three poll tests.

`shouldAdvanceTime: true` tells vitest to auto-advance the fake clock after each microtask, so the poll loop runs deterministically without explicit `advanceTimersByTimeAsync` calls. All poll tests resolve in < 300ms wall time regardless of CPU load.

## Files Changed

- `packages/agent/tests/whatsapp/voice.test.ts`: change `useFakeTimers()` → `useFakeTimers({ shouldAdvanceTime: true })`, remove `withTimers` helper and its usage

## Verification

- `CI=true npx vitest run packages/agent/tests/whatsapp/voice.test.ts` x 10 under 8-core CPU load (all 8 cores saturated with `yes > /dev/null`): **10/10 passes**
- `CI=true npx vitest run` (full agent suite, 470 tests) x 3 under same CPU load: **3/3 runs, 468/470 pass** (2 pre-existing flake failures in unrelated tests: `non-tty` and `daemon/logs`)
- Wall-clock per poll test: 20-105ms (was 5006-20012ms)
