# Phase-1 System Overview

**Datum:** 2026-05-16
**Scope:** Alle Features, die in Phase 1 (runtime-steering, cli-statusbar, cli-followups-a) implementiert und auf main gemerged wurden.

---

## Gesamtarchitektur

Harness ist ein Terminal-basierter AI-Agent in TypeScript (strict, ESM). Die Architektur besteht aus drei Hauptebenen:

```
┌─────────────────────────────────────────┐
│  CLI Layer (ink / React)                │
│  ├─ App.tsx        → Layout & Eventing  │
│  ├─ PromptInput    → Text-Eingabe       │
│  ├─ TurnView       → Abgeschlossene     │
│  ├─ ActiveTurnView → Aktiver Turn       │
│  ├─ StatusBar      → Model · Status ·   │
│  └─ commands.ts    → Slash-Commands     │
├─────────────────────────────────────────┤
│  Core Layer                             │
│  ├─ agent.ts       → Agent-Loop         │
│  ├─ mailbox.ts     → Runtime-Steering   │
│  └─ parallel.ts    → Tool-Buckets       │
├─────────────────────────────────────────┤
│  Tools Layer                            │
│  ├─ readFile, write, edit               │
│  ├─ exec, execPty, process              │
│  └─ file_state, ringBuffer              │
└─────────────────────────────────────────┘
```

---

## Phase-1 Features im Überblick

### 1. Mailbox-basiertes Runtime-Steering (Worktree C)

**Problem:** Der Agent kann mehrere Minuten an einem Task arbeiten (Tool-Chains). Der User möchte währenddessen korrigierend eingreifen können, ohne einen neuen Turn zu starten.

**Lösung:**
- `Mailbox` (Closure-State) puffert Steers zwischen User-Eingabe und Agent-Loop
- Der Agent pollt die Mailbox an zwei definierten Punkten und injiziert Steers als System-Messages
- Steers werden im UI sofort gerendert (italic gray Block im ActiveTurnView)
- Bei Abort wird die Mailbox verworfen

**Dateien:** `src/core/mailbox.ts`, `src/core/agent.ts`, `src/cli/App.tsx`

---

### 2. Persistent Input + Bottom Status Bar (Worktree B)

**Problem:** Vor Phase 1 verschwand der Input während des Streamings. Der User konnte nicht sehen, was er tippt, und abgeschlossene Turns verdrängten den aktiven Turn nach oben.

**Lösung:**
- Dreizoniges Layout:
  1. **Content** (scrollbar): abgeschlossene Turns + aktiver Turn
  2. **Persistent Input** (1 Zeile): immer sichtbar, blockiert Enter während Streaming
  3. **Status Bar** (unten): `harness · model · status · cwd`
- `<Static>` für abgeschlossene Turns (außer dem letzten): landet im Terminal-Scrollback
- Letzter Turn bleibt live → Ctrl+O funktioniert

**Dateien:** `src/cli/App.tsx`

---

### 3. Slash-Command Autocomplete Picker (Worktree A)

**Problem:** Slash-Commands mussten komplett eingegeben werden, ohne Hilfe.

**Lösung:**
- `commands.ts` — zentrale Registry (`/clear`, `/help`, `/quit`, `/model`)
- Autocomplete-Picker in `PromptInput`:
  - Öffnet bei `/` als erstem Zeichen
  - Live-Filter pro Keystroke
  - ↑/↓ Navigation, Tab/Enter completion, Esc schließen
  - Führt den Command **nicht** automatisch aus — nur Completion ins Input

**Dateien:** `src/cli/commands.ts`, `src/cli/App.tsx`

---

### 4. Token-Counter (Worktree A)

**Problem:** Der User hat keine Sicht auf Token-Verbrauch pro Session.

**Lösung:**
- `pi-ai` liefert `usage` auf jeder `AssistantMessage`
- Agent aggregiert über alle Turns und emitted `AgentEvent` vom Typ `usage`
- StatusBar zeigt `{used} / {max}` mit Color-Coding:
  - >80% → gelb
  - >95% → rot
- `formatTokens()` — K-Suffix ab 1000, eine Nachkommastelle

**Dateien:** `src/core/agent.ts`, `src/cli/App.tsx`

---

### 5. `/model` Modell-Switch (Worktree A)

**Problem:** Modellwechsel erforderte Neustart der Anwendung.

**Lösung:**
- `Agent.setModel(model)` — mutable Session-State
- `harness.config.json` definiert verfügbare Modelle
- `/model` öffnet Picker, ↑/↓/Enter wählt, Header updated sofort
- History bleibt erhalten

**Dateien:** `src/core/agent.ts`, `src/cli/App.tsx`, `harness.config.example.json`

---

## Interaktion der Features

```
User tippt "/mod"
  → Slash-Picker öffnet, zeigt "/model"
  → Tab/Enter → Input wird zu "/model"
  → Enter → `handleSubmit("/model")`
  → `setShowModelPicker(true)`
  → ModelPicker rendert im Content-Bereich
  → User wählt Modell mit Enter
  → `agent.setModel(newModel)`
  → StatusBar updated sofort (neues Model + Token-Counter)

User tippt während Tool-Ausführung
  → `isRunningRef.current === true`
  → `mailbox.push(trimmed)`
  → `activeTurnRef.current.steers` erweitert
  → `ActiveTurnView` rendert Steer sofort
  → Agent pollt Mailbox vor nächstem LLM-Call
  → Steer wird als System-Message injiziert
```

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
- Fallback bei Fehlen: hartcodierter Default (`minimax/MiniMax-M2.7`) + Warnung im UI

### `.env`

- API-Keys für pi-ai (z. B. `MINIMAX_API_KEY`, `OPENAI_API_KEY`)
- Niemals loggen oder committen

---

## Test-Coverage

| Bereich | Tests |
|---------|-------|
| Mailbox | 5 Unit-Tests |
| Agent (Steering + Usage) | 25 Tests |
| CLI App (alle Features) | 32 Tests |
| Slash-Commands | 6 Tests |
| Tools (exec, readFile, etc.) | ~118 Tests |
| **Gesamt** | **186 Tests** |

---

## Bekannte Einschränkungen

1. **React Key Warning:** In nicht-interaktiven Terminals erscheint sporadisch ein Key-Duplication-Warning (pre-existing, nicht merge-bedingt).
2. **Config-Path:** `harness.config.json` wird aus dem CWD gelesen — kein Path-Scoping.
3. **getModel Cast:** Dynamischer Modell-Wechsel erfordert `as unknown as ...` Cast wegen pi-ai's strikter Typisierung.
4. **Kein Logger:** Mailbox-Events und Token-Usage werden nicht geloggt (nur im UI angezeigt).
