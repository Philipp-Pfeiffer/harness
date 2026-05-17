# Agent Loop

**Letzte Aktualisierung:** 2026-05-16

---

## Überblick

Der Agent-Loop ist das Herzstück von Harness. Er orchestriert die Interaktion zwischen User, LLM und Tools in einer iterativen Schleife.

```
User Input
  → Agent.run(messages, options)
  → stream(model, context) [pi-ai]
  → AssistantMessage (stop / toolUse / length / error / aborted)
  → [bei toolUse] Tool-Execution (parallel + conflict-buckets)
  → [bei toolUse] ToolResultMessages → context.messages
  → Next Iteration
  → [bei stop] Final Response
```

---

## Token-Usage Aggregation (Phase 1)

Jeder `stream()`-Aufruf liefert `usage: { input, output, totalTokens }` auf der `AssistantMessage`. Der Agent aggregiert diese über die Session:

```ts
let totalInput = 0;
let totalOutput = 0;
let totalTokens = 0;

// Nach jeder Response:
totalInput += response.usage.input;
totalOutput += response.usage.output;
totalTokens += response.usage.totalTokens;
onEvent?.({ type: "usage", inputTokens: totalInput, outputTokens: totalOutput, totalTokens });
```

**RunResult** enthält immer `usage`:
```ts
{ aborted: false, turns: number, finalMessage: string, usage: TokenUsage }
| { aborted: true, completedTurns: number, reason: "signal" | "maxTurns", usage: TokenUsage }
```

---

## Mailbox-basiertes Runtime-Steering (Phase 1)

Während der Agent läuft (LLM-Stream oder Tool-Ausführung), kann der User Nachrichten senden, die nicht als neue Turns starten, sondern als **Steers** in eine Mailbox geschrieben werden.

### Mailbox-API (`src/core/mailbox.ts`)

| Methode | Verhalten |
|---------|-----------|
| `push(message)` | Hängt String an internes Array |
| `drainAll()` | Gibt Kopie aller Messages zurück, leert Array |
| `isEmpty()` | `true` wenn leer |

### Poll-Punkte in `Agent.run()`

1. **Vor dem LLM-Call** (zu Beginn jeder Iteration)
   - Fängt Steers auf, die während der vorherigen Tool-Ausführung gesendet wurden
   - Injiziert System-Message **vor** dem nächsten `stream()`

2. **Nach Stream-Ende, vor `stopReason`-Verarbeitung**
   - Fängt Steers auf, die während des LLM-Streams gesendet wurden
   - Injiziert System-Message **vor** potenziellem Tool-Call

### System-Message-Format

```
⚠ Steer während Tool-Call. Behandle als Korrektur/Ergänzung der ursprünglichen Aufgabe:
"<user message 1>"
"<user message 2>"
```

### Abort + Mailbox

Bei Abort gewinnt Abort. Die Mailbox wird geleert (`discardMailbox = drainAll ohne Injection`). Alle Steers aus einem abgebrochenen Durchlauf werden verworfen.

### Steer-Rendering in der CLI

Steers werden im `ActiveTurnView` als italic gray Block angezeigt:
```
[steer]
  <user message>
```

---

## Tool-Call Logging

Tool-Ergebnisse werden geloggt, aber für lange Outputs gekürzt:

```
[TOOL CALL] readFile({"path":"doc.pdf"}) → --- PDF, 3 pages ---
Hello World! Lorem ipsum dolor sit amet...
...
```

- **Logger-Truncation:** Erstes 200-Zeichen + `...`
- **Voller Result:** Geht trotzdem an das Model (für Reasoning)

Das ist relevant für `readFile` bei großen PDFs — das Model bekommt den vollen Text, nur die CLI-Ausgabe ist truncated.

---

## Tool-Result Flow

```
Agent.run(input)
  → complete(model, context) [pi-ai]
  → response.stopReason === "toolUse"
  → tool.execute(args)
  → logger (truncated)
  → createToolResultMessage(..., result, isError)
  → context.messages.push(resultMessage)
  → continue
```

---

## Modell-Wechsel zur Laufzeit (Phase 1)

Der Agent unterstützt `setModel(model)`:

```ts
export interface Agent {
  run(messages: Message[], options?: RunOptions): Promise<RunResult>;
  setModel(model: Model<Api>): void;
}
```

- Mutable Session-State — kein Neuerstellen des Agents nötig
- History bleibt vollständig erhalten
- Nächster `stream()`-Aufruf verwendet sofort das neue Modell

---

## Konfiguration

### `harness.config.json`

```json
{
  "models": [
    { "provider": "minimax", "model": "MiniMax-M2.7", "alias": "MiniMax M2.7" },
    { "provider": "openai", "model": "gpt-5.2", "alias": "GPT 5.2" }
  ]
}
```

- Wird zur Laufzeit aus dem CWD gelesen
- Fallback bei Fehlen: hartcodierter Default + Warnung im UI
