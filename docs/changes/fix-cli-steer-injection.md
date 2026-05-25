# Fix: CLI Steer-Injection-Bug

## 1. Diagnose

### 1a. Iteration-Counter

Temporäres Logging in `src/core/agent.ts` (wieder entfernt):

```ts
console.error(`[harness-loop] iter=${i} historyLen=${context.messages.length} mailboxLen=${mailbox?.size() ?? 0}`);
```

Beobachtung bei einem 2-Turn-Tool-Chain-Test (Echo-Tool):

```
[harness-loop] iter=0 historyLen=1 mailboxLen=0
[harness-loop] iter=1 historyLen=3 mailboxLen=1
```

- **Pro User-Turn**: 2 `[harness-loop]`-Zeilen (Iteration 0 = LLM-Stream + Tool-Call, Iteration 1 = Folge-LLM-Call).
- **`mailboxLen > 0`**: Bei `iter=1` (Mailbox enthält "Apfelsaft", gepusht während Tool-Ausführung).
- **LLM-Reaktion im Mock**: Ja — der Mock in Iteration 1 sieht die Steer-Nachricht in `context.messages`.
- **Aber**: Der reale Provider (Anthropic über MiniMax) filtert/droppt bestimmte Rollen und insertiert synthetische Tool-Results, wenn User-Messages zwischen Assistant (mit pending Tool-Calls) und Tool-Results stehen.

### 1b. pi-ai `stream()` Verhalten

Source aus `node_modules/@mariozechner/pi-ai/dist/stream.js`:

```js
export function stream(model, context, options) {
    const provider = resolveApiProvider(model.api);
    return provider.stream(model, context, options);
}
```

- **`stream()` ist single-shot**: Es delegiert an den Provider, der einen HTTP-Request macht und Events streamed. Es gibt **keine** interne LLM→Tool→LLM-Schleife.
- **Hooks/Callbacks**: Auf `stream()`-Ebene gibt es keine `onIteration`/`onToolResult`. `ProviderStreamOptions` bietet `onPayload` und `onResponse`.
- **SingleShot-Alternative**: `complete(model, context, options)` existiert als `stream(...).result()` Wrapper.
- **Context-Leseverhalten**: Der Provider startet eine async IIFE (`queueMicrotask`). `buildParams` liest `context.messages` beim Start der IIFE. Da der Harness-Loop synchron `drainMailbox` aufruft **bevor** `stream()` aufgerufen wird, sind Mutationen sichtbar.

Relevant: `node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js` (verwendet von MiniMax):

```js
function convertMessages(messages, model, isOAuthToken, cacheControl) {
    // ...
    for (let i = 0; i < transformedMessages.length; i++) {
        const msg = transformedMessages[i];
        if (msg.role === "user") { /* ... */ }
        else if (msg.role === "assistant") { /* ... */ }
        else if (msg.role === "toolResult") { /* ... */ }
        // Kein `else if (msg.role === "system")`!
        // System-Messages aus `context.messages` werden still verworfen.
    }
}
```

Und `node_modules/@mariozechner/pi-ai/dist/providers/transform-messages.js`:

```js
else if (msg.role === "user") {
    insertSyntheticToolResults(); // User-Message unterbricht Tool-Flow
    result.push(msg);
}
```

### 1c. Mock-vs-Real Diff

Der Test-Mock in `tests/agent.test.ts` returnt single-shot (eine Antwort pro Aufruf) — das spiegelt das echte pi-ai 0.70.2 korrekt wider.

**Aber**: Der Mock simuliert **nicht** das Verhalten von `convertMessages`/`transformMessages`:

- Er droppt keine `role: "system"` Messages.
- Er insertiert keine synthetischen Tool-Results, wenn eine User-Message zwischen Assistant (mit Tool-Calls) und Tool-Results steht.

→ Die bestehenden Tests prüfen, dass `context.messages` die Steer-Nachricht enthält, aber sie prüfen **nicht**, ob der reale Provider diese Nachricht an das LLM durchreicht.

## 2. Entscheidung

**Gewählter Pfad:** Harness-Loop beibehalten, Steer-Injection fixen.

**Begründung:**
- pi-ai ist single-shot, es looped nicht intern.
- Es gibt keinen passenden Hook, um `drainMailbox` einzuhängen.
- Die Harness-Loop (`for (let i = 0; i < maxIterations; i++)`) ist der korrekte Ort für Multi-Turn-Tool-Chains.
- Der Bug liegt **nicht** in pi-ai, sondern in der Art, wie der Harness Steer-Nachrichten in den Kontext injiziert.

**Verworfene Optionen:**
- `complete()` statt `stream()` verwenden: Unnötig, da `stream()` single-shot ist.
- pi-ai auf eine andere Version pinnen: Nicht nötig, da das Verhalten in 0.70.2 korrekt ist.
- Neues Context-Objekt pro Iteration: Nicht nötig, da `context.messages` zur Laufzeit gelesen wird.

## 3. Änderungen

### `src/core/agent.ts`

**Zwei Änderungen:**

1. **Steer-Message als `role: "user"` statt `"system"`** (bereits in Commit `9731c91`):
   - `Message` in pi-ai umfasst nur `UserMessage | AssistantMessage | ToolResultMessage`. `role: "system"` wird vom Anthropic-Provider (`convertMessages`) still verworfen.
   - Die Steer-Nachricht wird jetzt als `UserMessage` mit `content: [{ type: "text", text: ... }]` injiziert.

2. **Drain-Position für `toolUse` verschoben** (neuer Fix in diesem Commit):
   - **Vorher**: `drainMailbox` lief direkt nach dem Stream, **vor** Tool-Ausführung. Das platzierte die Steer-Nachricht zwischen Assistant (mit pending Tool-Calls) und den Tool-Results.
   - **Nachher**: `drainMailbox` läuft **nach** Tool-Ausführung und nachdem Tool-Results in `context.messages` gepusht wurden. Die Steer-Nachricht steht damit nach allen Tool-Results.
   - Für non-`toolUse` (`stop`, `length`, `aborted`) bleibt das Drain nach dem Stream erhalten (die Nachricht landet zwar im History-Array, wird aber nicht mehr an das LLM geschickt, da der Turn endet).

### `tests/agent.test.ts`

- Bestehende Tests aktualisiert: Erwarten jetzt `role === "user"` statt `"system"`.
- **Neuer Test**: `steer survives real-provider message conversion and is positioned after tool results` — simuliert `convertMessages`/`transformMessages` des Anthropic-Providers (droppt System-Messages, insertiert synthetische Tool-Results bei orphaned Calls). Verifiziert, dass die Steer-Nachricht sichtbar ist **und** nach den Tool-Results positioniert ist.

## 4. Tests

| Test | Status | Anmerkung |
|------|--------|-----------|
| Alle bestehenden Agent-Tests (29) | ✅ unverändert grün | Abort, Streaming, History, Mailbox |
| `steer survives real-provider message conversion...` | 🆕 neu | Fails ohne Fix (synthetic tool results), grün mit Fix |
| Abort-Signal-Tests | ✅ unverändert grün | `discardMailbox` vor Drain sichert korrektes Abort-Verhalten |

## 5. Restrisiko / Follow-ups

- **Mid-stream Steer bei non-`toolUse`**: Wenn ein User während eines Text-Streams steert und der Stream mit `stop` endet, wird die Steer-Nachricht in die History aufgenommen, aber nicht mehr an das LLM geschickt (Turn ist zu Ende). Für den nächsten Turn bleibt sie im History-Array. Das ist akzeptabel, aber könnte in Zukunft explizit gehandhabt werden (z. B. Steer als neuer User-Turn starten).
- **pi-ai Version-Lock**: Kein Lock nötig; das Verhalten ist in 0.70.2 konsistent.
- **Partial Assistant-Output bei Abort**: Existierendes Ticket (siehe `aborted` Stream-Handling in `agent.ts`). Dieser Fix berührt diesen Pfad nicht.
- **Andere Provider**: Der Fix ist provider-agnostisch, aber die Test-Simulation modelliert explizit den Anthropic-Provider (verwendet von MiniMax). Falls zukünftig andere Provider mit anderem `convertMessages`-Verhalten genutzt werden, sollte der Test erweitert werden.
