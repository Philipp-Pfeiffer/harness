# Phase 1: Mailbox-basiertes Runtime-Steering

**Branch:** `phase-1/runtime-steering`  
**Commit:** `60defd0` — feat(core): mailbox-based message steering  
**Baseline:** 158 Tests grün  
**Final:** 166 Tests grün (8 neue)

---

## Ziel

ADR-Feature-Set v1 #8: User-Message während laufender Tool-Chain landet in einer Session-Mailbox; zwischen Tool-Calls pollt der Agent-Loop die Mailbox und injiziert wartende Messages als System-Hinweis. OpenClaw-Style — kein `/queue`.

---

## Neue Dateien

### `src/core/mailbox.ts`

Einfacher Closure-State mit drei Operationen:

| Methode | Verhalten |
|---------|-----------|
| `push(message)` | Hängt String an internes Array an |
| `drainAll()` | Gibt Kopie aller Messages zurück, leert Array |
| `isEmpty()` | `true` wenn Array-Length === 0 |

Thread-safety: Nicht erforderlich (JS single-threaded, Agent-Loop ist der einzige Consumer).

### `tests/core/mailbox.test.ts`

5 Unit-Tests:
1. `push` + `isEmpty` toggled
2. `drainAll` gibt alle Messages zurück
3. `drainAll` auf leerer Mailbox → `[]`
4. `isEmpty` nach `drainAll` → `true`
5. Mehrere Push/Drain-Zyklen unabhängig

---

## Modifikationen

### `src/core/agent.ts`

**Mailbox-Poll-Punkte (2 Stellen):**

1. **Nach Stream-Ende, vor `stopReason`-Verarbeitung**  
   `drainMailbox()` wird aufgerufen, sobald `eventStream.result()` resolved.  
   → Fängt Steers während LLM-Stream ab. System-Message landet **vor** potenziellem Tool-Call.

2. **Am Anfang jeder Iteration, vor nächstem LLM-Call**  
   `drainMailbox()` wird nach dem Abort-Check aufgerufen.  
   → Fängt Steers während Tool-Ausführung ab. System-Message landet **nach** Tool-Results.

**System-Message-Format:**

```
⚠ Steer während Tool-Call. Behandle als Korrektur/Ergänzung der ursprünglichen Aufgabe:
"<user message 1>"
"<user message 2>"
```

**Steer+Abort-Entscheidung:**

- Abort gewinnt, Mailbox wird geleert (`discardMailbox` = `drainAll` ohne Injection).
- Implementiert an allen 5 Abort-Return-Punkten in `run()`:
  1. Vor LLM-Call (Turn-Start)
  2. Nach Stream-Exception (AbortError)
  3. Vor Tool-Execution (Assistant-Message wird gepoppt)
  4. Nach Tool-Results (Between-Iterations)
  5. Am Ende bei `maxIterations`

**Begründung:** Der nächste `run()` bekommt sowieso frischen Input. Steers aus einem abgebrochenen Durchlauf sind kontextlos und werden verworfen.

**Type-Handling:** `pi-ai` liefert keinen `SystemMessage`-Typ. Lokal definierter `SteerMessage`-Typ + `as`-Cast auf die `messages`-Array, um TypeScript-Strictness zu wahren.

### `src/cli/App.tsx`

**Mailbox-Instanz:**
- `mailboxRef = useRef<Mailbox>(createMailbox())` — lebt über die Session

**Enter-Routing:**
- `isRunningRef.current === true` → `mailbox.push(trimmed)` statt neuer `run()`
- `activeTurnRef.current.steers` wird um den Steer erweitert
- `forceUpdate()` rendert Steer sofort im UI

**Steer-Rendering:**
- `ActiveTurnView` zeigt Steers als italic gray Block mit Marker `[steer]`
- Position: unter dem Turn-Content (direkt nach Tool-Cards)

**Abort-Hook:**
- `Ctrl+C` während laufendem `run()` ruft `mailboxRef.current.drainAll()` auf, bevor `controller.abort()`

---

## Integrationstests (`tests/agent.test.ts`)

3 neue Tests im `describe("Mailbox steering")`:

1. **Drains after tool calls, before next LLM**  
   Steers werden während `tool_call_start` gepusht. Nach Tool-Completion landet 1 System-Message mit beiden Steers in der History **vor** dem nächsten `stream()`-Aufruf.

2. **Drains after stream ends, not mid-stream**  
   Steer wird direkt nach `agent.run()` gepusht (simuliert Stream-Laufzeit). `drainMailbox` nach `eventStream.result()` injiziert System-Message vor Tool-Execution.

3. **Steer + Abort → Abort wins, mailbox cleared**  
   Steer wird bei `tool_call_start` gepusht, gleichzeitig `controller.abort()`. Mailbox ist leer, History enthält keine `role: "system"`-Message.

---

## Berührte Dateien (Worktree)

```
src/core/mailbox.ts
src/core/agent.ts
src/cli/App.tsx
tests/core/mailbox.test.ts
tests/agent.test.ts
.env
```

---

## Bekannte Einschränkungen / Offene Punkte

- Kein Path-Scoping / Workspace-Root Isolation (wie alle anderen Tools)
- Kein Logger für Mailbox-Events
- Steer-Rendering ist rein informativ; der Agent entscheidet selbst, ob/wie er der Korrektur folgt
- `.env` wurde manuell aus main-Worktree kopiert (war in `.gitignore`)
