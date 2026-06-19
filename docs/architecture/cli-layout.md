# CLI Layout & Rendering Architecture

**Datum:** 2026-05-16
**Scope:** Phase-1 CLI nach Merge von runtime-steering, cli-statusbar, cli-followups-a

---

## Layout-Zonen

Die CLI verwendet ein **dreizoniges Bottom-Layout** (von Worktree B eingeführt):

```
┌─────────────────────────────────────────────┐
│                                             │
│  Content-Bereich (scrollable)               │
│  ├─ Static Turns (Terminal-Scrollback)      │
│  ├─ Live Turns (letzter abgeschlossener)    │
│  ├─ Active Turn (streaming/thinking/tool)   │
│  ├─ Steer-Blocks (italic gray)              │
│  ├─ Config-Warnungen                        │
│  └─ Model-Picker (bei /model)               │
│                                             │
├─────────────────────────────────────────────┤
│  ❯ Persistent Input                         │
│    (immer sichtbar, auch während Stream)    │
├─────────────────────────────────────────────┤
│  harness · model · status · usage · cwd     │
│  ─── Status Bar (bottom, 1 Zeile) ───       │
└─────────────────────────────────────────────┘
```

---

## `<Static>`-Hybrid-Rendering

### Problem

In vorherigen Layouts verschoben sich abgeschlossene Turns nach oben, der aktive Turn und der Input verschwanden aus dem sichtbaren Bereich.

### Lösung

Ink's `<Static>`-Komponente rendert Items einmalig und entfernt sie aus dem Live-Render-Baum. Das schreibt sie in das Terminal-Scrollback.

```tsx
const staticTurns = pastTurns.slice(0, -1);   // alles außer dem letzten
const liveTurns   = pastTurns.slice(-1);      // nur der letzte

<Static items={staticTurns}>
  {(turn) => <TurnView key={turn.id} turn={turn} />}
</Static>
<Box flexDirection="column" flexGrow={1}>
  {liveTurns.map((turn) => <TurnView key={turn.id} turn={turn} />)}
  {activeTurnRef.current && <ActiveTurnView turn={activeTurnRef.current} />}
</Box>
```

### Tradeoff

- **Vorteil:** Abgeschlossene Turns sind im Scrollback verfügbar, Input bleibt immer unten
- **Kompromiss:** Der letzte abgeschlossene Turn bleibt live, damit **Ctrl+O** (Toggle Tool Card) weiterhin funktioniert. Erst der übernächste Turn wandert in `<Static>`.

---

## Komponenten

### `TurnView`

Rendert einen abgeschlossenen Turn:
- User-Prompt (`❯ <text>`)
- Assistant-Text (mit Markdown-Rendering via `marked`)
- Tool-Cards (collapsed oder expanded), Titel zeigt Args-Summary (z. B. ` exec: $ ls -la`)
- Fehler- oder Abort-Marker
- Help-Card (bei `/help`)

### `ActiveTurnView`

Rendert den aktuell laufenden Turn:
- Gleiche Struktur wie `TurnView`, aber ohne Markdown-Rendering (Live-Text)
- Steer-Blocks (italic gray, wenn Steers vorhanden)
- Status-Marker (`[abgebrochen]`, `[Fehler]`)

### `PromptInput`

State-basierte Eingabe mit folgenden Features:
- Cursor-Blink (530ms Intervall, pausiert im Selection Mode)
- Text-Selection mit Shift+←/→
- Ctrl+A (Select All)
- Ctrl+Backspace / Alt+Backspace (Word-Delete)
- Shift+Enter (Multi-Line)
- History-Navigation (↑/↓)
- **Slash-Command Picker** (↑/↓/Tab/Esc) — nur wenn `commands` Prop übergeben
- `paused` Prop: deaktiviert Blink-Timer + Input-Handler (während Selection Mode)

### `StatusBar`

Zeigt in einer Zeile:
```
harness · MiniMax-M2.7 · ready · 15 / 100.0k · /home/user/project
```

- **Model:** Aktives Modell (aus `activeModel.id`)
- **Status:** `ready` | `thinking` | `streaming` | `tool` | `aborted` | `error` | `complete`
- **Token-Counter:** `{used} / {max}` — nur wenn `usage` definiert
  - Color-Coding: >80% gelb, >95% rot
- **CWD:** Aktuelles Arbeitsverzeichnis

---

## Event-Flow

```
User Input (Keyboard)
  → useInput (Ink)
  → [Ctrl+C] → AbortController.abort() + mailbox.drainAll()
  → [Ctrl+E] → setSelectionMode(true) → setRawMode(false) → terminal handles scroll & select
  → [Ctrl+L] → setPastTurns([])
  → [Ctrl+O] → toggleLastTool()
  → [/...]   → Slash-Picker öffnet/schließt
  → [Enter]  → handleSubmit(value)

handleSubmit(value)
  → [/clear] → clear history
  → [/quit]  → process.exit(0)
  → [/model] → showModelPicker
  → [/help]  → render help turn
  → [steer]  → mailbox.push(value) + render steer
  → [normal] → agent.run(history, { signal, mailbox, onEvent })

onEvent (AgentEvent)
  → token       → append assistantText + status="streaming"
  → tool_call_start  → add ToolItem (pending)
  → tool_call_done   → update ToolItem (done)
  → tool_call_error  → update ToolItem (error, expanded)
  → turn_end    → status="complete"
  → usage       → setSessionUsage(...) → StatusBar updated
```

---

## Resize-Handling

```tsx
const { stdout } = useStdout();
const [termSize, setTermSize] = useState({ columns: stdout.columns, rows: stdout.rows });

useEffect(() => {
  const handleResize = () => setTermSize({ columns: stdout.columns, rows: stdout.rows });
  stdout.on("resize", handleResize);
  return () => stdout.off("resize", handleResize);
}, [stdout]);
```

- Root-Box verwendet `width={termSize.columns}`
- Tool-Cards berechnen Breite dynamisch aus `process.stdout.columns`

---

## State-Management

Die CLI verwendet **keinen globalen State-Manager**. Stattdessen:

- **React State:** `pastTurns`, `inputHistory`, `sessionUsage`, `termSize`, `activeModel`, `configModels`, `showModelPicker`, etc.
- **Refs:** `activeTurnRef`, `historyRef`, `abortControllerRef`, `mailboxRef`, `isRunningRef`, `userAbortedRef`
- **Force Update:** `useForceUpdate()`-Hook für imperative Re-Renders (notwendig für Events aus dem Agent-Loop)

### Warum Refs + ForceUpdate?

Der Agent-Loop läuft asynchron (Promise-Kette). React-State-Updates innerhalb von `.then()`-Ketten würden auf veraltete Closures zugreifen. Refs garantieren immer den aktuellen Wert. `forceUpdate()` triggert ein Re-Render, damit Ink die Ref-Änderungen anzeigt.

---

## File-Struktur

```
src/cli/
├── App.tsx         → Hauptkomponente, Layout, Event-Flow
└── commands.ts     → Slash-Command Registry + Filter-Logik
```

---

## Tests

Alle CLI-Features sind in `tests/cli/App.test.tsx` abgedeckt (32 Tests):

| Describe-Block | Tests |
|----------------|-------|
| Basis-Rendering | 7 |
| PromptInput editing | 7 |
| Persistent input and status bar | 5 |
| Token counter | 4 |
| /model command | 3 |

Zusätzlich: `tests/cli/commands.test.tsx` — 6 Tests für Slash-Command-Registry.
