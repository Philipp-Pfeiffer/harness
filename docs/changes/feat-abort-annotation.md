# feat/abort-annotation — Abort-Annotation nach User-Abort in History injizieren

## Motivation

Wenn ein Turn durch ein User-Abort-Kommando (`stop` / `stopp` / `abort` / `Ctrl+C`) unterbrochen wird, erhält der Agent im nächsten Turn keine Information darüber, was passiert ist. Das führt zu verwirrten Folge-Antworten, weil der Agent raten muss, ob der Turn fertig wurde, gecrasht ist oder unterbrochen wurde. Mit diesem Change wird nach jedem Abort eine `role: "user"`-Annotation in `context.messages` gepusht, die das Ereignis explizit benennt.

## Voraussetzungs-Check

| Check | Ergebnis |
|-------|----------|
| `feat/prompts-folder` in `main` gemerged | ✅ Fast-forward-Merge lokal durchgeführt (`41877db`) |
| `prompts/steer-annotation.md` existiert | ✅ |
| `src/prompts.ts` existiert | ✅ |
| `notion-71`-Fix (partial assistant + synthetic tool_result) in `main` | ✅ Smoke-Check bestanden — Abort während Tool-Call crasht nicht |

## Änderungen

| File | Änderung |
|------|----------|
| `prompts/abort-annotation.md` | Neuer Prompt. Beschreibt das Abort-Ereignis, warnt vor nicht-realen synth-Results, und instruiert den Agenten, auf den nächsten User-Input zu warten. |
| `src/core/agent.ts` | `RunOptions` um `abortCommand?: { current: string \| undefined }` erweitert. Neue Helper-Funktion `pushAbortAnnotation()`. An **allen vier Abort-Return-Stellen** wird die Annotation gepusht (vor LLM-Call, nach Stream-Abort, vor Tool-Execution, nach Tool-Results). |
| `src/cli/App.tsx` | `abortCommandRef` hinzugefügt. Bei Stop-Wort-Eingabe oder `Ctrl+C` wird `abortCommandRef.current` auf das Kommando gesetzt (`"stopp"` / `"stop"` / `"abort"` / `"ctrl+c"`) und an `agent.run()` übergeben. |
| `tests/prompts.test.ts` | Snapshot-Test für `prompt("abort-annotation", { command: "stopp", timestamp: "…" })`. |
| `tests/agent.test.ts` | Zwei neue Tests: (1) Abort während Tool-Execution → History enthält `user + assistant + toolResult + abort-annotation`, (2) Abort während Text-Stream → History enthält `user + assistant (partial) + abort-annotation`, kein synth toolResult. |

## History-Sequenz nach Abort

### Mit dangling tool_use (z. B. Abort während/ nach Tool-Execution)

```
user
assistant (enthält tool_calls)
toolResult(s) für tatsächlich ausgeführte Calls
abort-annotation  ← NEU: role:user
```

### Ohne dangling tool_use (z. B. Abort während Text-Stream)

```
user
assistant (partial text, stopReason: aborted)
abort-annotation  ← NEU: role:user
```

## Tests

Neu:
- `tests/prompts.test.ts` — Snapshot-Test für `abort-annotation` Prompt.
- `tests/agent.test.ts` — 2 neue Tests in `describe("Abort annotation")`:
  - Abort während Tool-Execution → 4 Messages in History, letzte enthält Kommando + Timestamp.
  - Abort während Text-Stream → 3 Messages in History, keine synth toolResults.

Unverändert / grün:
- Alle 30 bestehenden Agent-Tests (inkl. Mailbox-Steering und notion-71-Abort-Tests).
- Alle 222 Tests im gesamten Projekt.

## Nachhol-Action

- [ ] Notion-Register-Seite "Prompt- & Injection-Register" im Harness-Hub: Eintrag `abort-annotation` von 🟡 Planned auf 🟢 Active setzen, mit Commit-Hash verlinken.

## Restrisiko

- Wenn das Abort-Kommando in Zukunft um weitere Varianten erweitert wird (z. B. `halt`, `cancel`), müssen sowohl der Detector in `App.tsx` (`stopWords`-Array) als auch das Mapping auf `abortCommandRef.current` konsistent gehalten werden.
- `abortCommand` ist ein Mutable-Ref — das funktioniert, solange `agent.run()` und das CLI im selben Prozess laufen. Bei einer späteren Extraktion des Agents in einen Worker/Subprozess müsste man auf einen Message-Pass-Mechanismus umstellen.
