# feat: Auto-Retry + Timeout für LLM-Provider-Calls

## Problem/Symptom
Der Agent-Loop crasht bei Provider-Fehlern (5xx, Timeouts, Rate-Limits, Netzwerk-Errors). Es gibt kein Timeout für Provider-Calls. Partielle Stream-Errors führen zu unkontrollierten Abbrüchen.

## Befund
- Keine Retry-Logik im Harness-Layer (pi-ai hat maxRetries-Felder, die aber nie gesetzt werden)
- Kein Timeout für Provider-Calls
- Bei Stream-Fehlern wird der Error direkt geworfen — kein geordneter Retry
- User-Abort und Provider-Error sind nicht sauber getrennt

## Was geändert wurde

### Neues Modul: `packages/core/src/core/retryPolicy.ts`
- `RetryPolicy`-Typ: { maxRetries, timeoutMs, backoffBaseMs, backoffMaxMs, retryableClasses }
- `DEFAULT_RETRY_POLICY`: maxRetries=3, timeoutMs=120_000ms, backoffBaseMs=1_000ms, backoffMaxMs=30_000ms
- `classifyError(err, userSignal)`: klassifiziert Errors in transient/rate_limit/permanent/user_abort
  - User-abort wird ZUERST geprüft → NIEMALS retry
  - 5xx, ECONNRESET, Timeout, provider_aborted → transient (retry)
  - 429 → rate_limit (retry, respektiert Retry-After-Header)
  - 400/401/403, context-length → permanent (sofort fail)
  - Generic → transient (Fallback)
- `TimeoutController`: Inactivity-Timeout (Timer resettet bei jedem Chunk), linked to user signal
  - `timedOut`-Flag unterscheidet unseren Timeout von User-Abort
  - `ProviderTimeoutError` als AbortReason für klare Unterscheidung
- `sleepCancellable(ms, signal)`: Backoff-Wait, das bei User-Abort sofort abbricht
- `computeBackoffDelay(attempt, policy)`: exponentieller Backoff mit Jitter
- `extractRetryAfter(err)`: extrahiert Retry-After-Header-Wert in ms

### Geändert: `packages/core/src/core/agent.ts`
- `AgentConfig` hat neues optionales Feld `retryPolicy?: RetryPolicy`
- Stream-Aufruf ist in `retry_loop` gewickelt:
  - Pro Versuch: neuer TimeoutController, Stream-Iteration mit `reset()` auf jedem Chunk
  - Bei User-Abort: sofortiger Abbruch, pushAbortAnnotation (unverändert), kein Retry
  - Bei transient/rate_limit: Retry mit Backoff, partieller Output verworfen
  - Bei permanent: sofort throw
  - Bei User-Abort während Backoff-Wait: sofortiger Abbruch, kein weiterer Versuch
- `context.messages.push(response)` passiert NUR nach erfolgreichem Stream — kein partial Output in History

### Geändert: `packages/core/src/core/metrics.ts`
- `RetryMetric`-Typ hinzugefügt (attempt, maxRetries, errorClass, errorMessage, retryAfterMs, provider, model)
- `recordRetry()`-Methode auf MetricsRecorder-Interface
- Retry-Metriken in `retries-YYYY-MM-DD.jsonl` Dateien

## Dateien
- `packages/core/src/core/retryPolicy.ts` (neu)
- `packages/core/src/core/agent.ts` (geändert)
- `packages/core/src/core/metrics.ts` (geändert)
- `packages/core/src/lib.ts` (Exporte hinzugefügt)
- `packages/core/tests/core/retryPolicy.test.ts` (neu)
- `packages/core/tests/core/retryIntegration.test.ts` (neu)

## Tests
- `retryPolicy.test.ts`: classifyError, extractRetryAfter, computeBackoffDelay, TimeoutController, sleepCancellable
- `retryIntegration.test.ts`: Transient→Success, Permanent→NoRetry, 429+RetryAfter, MaxRetries erschöpft, User-Abort während Retry-Wait, Partial-Output verworfen, Metrics recordRetry
- Alle bestehenden Tests grün, tsc clean
