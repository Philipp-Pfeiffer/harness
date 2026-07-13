# Inline Thinking Stream Transformer

**Datum:** 2026-07-12  
**Typ:** Bugfix / Feature

## Problem

kimi-k2.7-code über Provider neuralwatt liefert Reasoning als Inline-`simd…`-Tags im `content`-Stream, nicht als separates `reasoning_content`-Feld. pi-ai's openai-completions-Provider erkennt nur `reasoning_content`/`reasoning`/`reasoning_text` als separate Felder — Inline-Tags gehen als `text_delta` durch und landen sichtbar in der Assistant-Message.

### Diagnose (Session-Log 4b2087)

Analyse von `~/.harness/sessions/2026-07-12/20260712T160245-4b2087.jsonl`:

- **Befund (a):** Inline-Tags im Content (bestätigt).  
- In 4 von 18 Assistant-Messages finden sich stray `</thinking closing-Tags im `content`-Feld. Der öffnende ` simd`-Tag wird teilweise verarbeitet, aber der schließende Tag leakt als roher Text.
- pi-ai's openai-completions-Provider sucht nach `reasoning_content`/`reasoning`/`reasoning_text` als separate Delta-Felder — nicht nach Inline-Tags im Content.

## Fix

### 1. `ThinkingStreamTransformer` (`packages/core/src/core/thinkingStream.ts`)

Stateful State-Machine, die `text_delta`-Chunks parst:
- Erkennt `simd` / `</think sdk`-Tags auch bei Split über Chunk-Grenzen
- `text`-State → `token`-Events
- `thinking`-State → `thinking`-Events
- Partial-Tag-Buffering an Chunk-Grenzen
- Flush am Stream-Ende (unclosed → als thinking emit)

### 2. Event-Pipeline erweitert

Neuer `thinking`-Event-Typ durch alle Schichten:
- `AgentEvent` (packages/core)  
- `TurnStreamEvent` (packages/agent/src/daemon/types.ts)  
- `BackendEvent` (packages/agent/src/backends/types.ts)  
- Translation in runtime.ts, daemonClientBackend.ts, inProcessBackend.ts

### 3. TUI-Rendering

`ActiveTurn` und `CompletedTurn` haben `thinkingText`-Feld. Thinking wird als abgegrenzter Block in Grau/Italic gerendert (┌ thinking / └), nicht als sichtbarer Assistant-Text.

### 4. Konfiguration

`ConfigModel.inlineThinking: boolean` — per-Model aktivierbar, nicht hartkodiert für neuralwatt. Wird durch `resolveModel.ts` als `ResolvedModel.inlineThinking` durchgereicht und an `createAgent({ inlineThinking })` übergeben.

## Tests

14 Unit-Tests in `packages/core/tests/core/thinkingStream.test.ts`:
- Plain text (kein Tag)
- Simple think block
- Tag am Stream-Anfang
- Mehrere think blocks
- Open-Tag Split über Chunk-Grenze
- Close-Tag Split über Chunk-Grenze
- Beide Tags gesplittet
- Unclosed think block (flush)
- Partial open tag → stellt sich als plain text heraus
- Partial close tag → stellt sich als plain text heraus
- Empty think block
- Tag am Stream-Ende
- Single-character chunks
- Nested open tag (first close ends block)

## Dateien

| Datei | Änderung |
|-------|----------|
| `packages/core/src/core/thinkingStream.ts` | Neu — Transformer |
| `packages/core/src/core/agent.ts` | `AgentEvent` + `AgentConfig` erweitert, Stream-Loop angepasst |
| `packages/core/src/config.ts` | `ConfigModel.inlineThinking` |
| `packages/core/src/core/resolveModel.ts` | `ResolvedModel.inlineThinking`, Durchreichung |
| `packages/core/src/lib.ts` | Export von `ThinkingStreamTransformer` |
| `packages/agent/src/daemon/types.ts` | `TurnStreamEvent` um thinking erweitert |
| `packages/agent/src/backends/types.ts` | `BackendEvent` um thinking erweitert |
| `packages/agent/src/daemon/runtime.ts` | Translation + `inlineThinking` an `createAgent` |
| `packages/agent/src/backends/daemonClientBackend.ts` | Translation |
| `packages/agent/src/backends/inProcessBackend.ts` | Translation |
| `packages/agent/src/cli/App.tsx` | `ActiveTurn`/`CompletedTurn` erweitert, Rendering, Event-Handler, `inlineThinking` an `createAgent` |
| `packages/agent/src/index.tsx` | `inlineThinking` an `createAgent` |
| `packages/core/tests/core/thinkingStream.test.ts` | Neu — 14 Tests |

## Aktivierung

In `config.json` das Model mit `inlineThinking: true` markieren:

```json
{
  "provider": "neuralwatt",
  "model": "kimi-k2.7-code",
  "alias": "Kimi K2.7 Code",
  "reasoning": true,
  "inlineThinking": true,
  ...
}
```
