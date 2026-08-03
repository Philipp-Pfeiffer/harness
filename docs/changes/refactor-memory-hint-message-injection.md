# refactor: Memory-Hint als ephemere Message statt System-Prompt

## Problem

Ambient Memory Hints (`getAmbientHints`) wurden an `effectiveSystemPrompt` angehängt. Das brach den byte-identischen System-Prompt-Prefix zwischen Turns — schlecht für Provider Prompt-Caching, obwohl `setSystemPrompt()` nur einmal pro Session aufgerufen wird.

Zusätzlich war `memory.ambientHints: false` in der Daemon-Config nur geloggt, aber nicht enforced.

## Änderung

1. **`packages/core/src/core/agent.ts`**: Hint wird als ephemere User-Message nach der auslösenden User-Message in `llmContext()` injiziert. `systemPrompt` bleibt stabil. Persistierte History unverändert.
2. **`packages/agent/src/daemon/runtime.ts`**: `ambientMemoryBackend()` respektiert `config.memory.ambientHints` und Zone `"notes"`.
3. **Tests**: `packages/core/tests/agent.test.ts` — Assertions auf Message-Injection umgestellt.
4. **Doku**: `docs/architecture/memory.md` §8 aktualisiert.

## Dateien

| Datei | Änderung |
|-------|----------|
| `packages/core/src/core/agent.ts` | `injectMemoryHintMessage`, `llmContext()` |
| `packages/core/src/core/memoryBackend.ts` | Kommentar |
| `packages/agent/src/daemon/runtime.ts` | `ambientMemoryBackend()` |
| `packages/core/tests/agent.test.ts` | Ambient-Hint-Tests |
| `docs/architecture/memory.md` | Injection-Ziel |

## Tests

```bash
pnpm --filter @harness/core test packages/core/tests/agent.test.ts
pnpm exec tsc --noEmit
```
