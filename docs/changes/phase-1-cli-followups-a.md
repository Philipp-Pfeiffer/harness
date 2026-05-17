# Phase 1: CLI Follow-ups — Zusammenfassung

Branch: `phase-1/cli-followups-a`  
Baseline: 158 Tests grün  
Final: 173 Tests grün (0 failed)

---

## Commit-Übersicht

| Commit | Hash | Beschreibung |
|--------|------|--------------|
| Slash-Command Autocomplete Picker | `ca035d4` | Picker bei `/`, Live-Filter, Navigation, Completion |
| Token Usage Aggregation (Core) | `0f508f6` | Extraktion & Aggregation pro Session |
| Header Token Counter | `c840d92` | Anzeige `{used} / {max}` mit Color-Coding |
| `/model` Modell-Switch | `a7e0a0e` | Runtime-Modellwechsel via Config |

---

## Feature 1: Slash-Command Autocomplete Picker

**Scope:** Nur `src/cli/`

### Was wurde gebaut
- `src/cli/commands.ts` — Registry aller Slash-Commands (`/clear`, `/help`, `/quit`, `/model`) mit Name + Description
- Autocomplete-Picker in `PromptInput` integriert
  - Öffnet bei `/` als erstem Zeichen
  - Live-Filter pro Keystroke (`/cl` → nur `/clear`)
  - ↑/↓ Navigation im Picker (statt History)
  - Tab/Enter completed den Command-Namen ins Input, führt **nicht** automatisch aus
  - Esc schließt Picker, belässt Input unverändert
  - Schließt automatisch bei Leerzeichen oder Nicht-Command-Pattern

### Tests
- `tests/cli/commands.test.tsx` — 6 Tests für Picker-Verhalten

---

## Feature 2: Token-Counter im Header

### Prerequisite: Token-Logging
- **Spike positiv:** `pi-ai` liefert `usage: Usage` (input, output, totalTokens) auf jeder `AssistantMessage`

### Core-Änderungen (`src/core/agent.ts`)
- Neuer `AgentEvent`-Typ: `{ type: "usage"; inputTokens; outputTokens; totalTokens }`
- Aggregation über alle Turns einer Session
- `RunResult` erweitert um `usage: TokenUsage`

### CLI-Anzeige (`src/cli/App.tsx`)
- `formatTokens(n)` — K-Suffix ab 1000, eine Nachkommastelle (z.B. `17654` → `17.7k`)
- Header zeigt `{used} / {max}` rechts neben Status
- `max` aus `model.contextWindow`, Fallback `?`
- Color-Coding:
  - >80% Auslastung → gelb
  - >95% Auslastung → rot

### Tests
- `tests/agent.test.ts` — 2 neue Tests für Aggregation über mehrere Turns
- `tests/cli/App.test.tsx` — 4 neue Tests für Counter-Display und Formatierung

---

## Feature 3: `/model` Modell-Switch

### Core-Änderungen (`src/core/agent.ts`)
- `Agent` Interface erweitert um `setModel(model)` — mutable Session-State
- Kein Neuerstellen des Agents bei Modellwechsel, History bleibt erhalten

### Config (`harness.config.json`)
- Format: `{ models: [{ provider, model, alias }] }`
- Beispiel-Config: `harness.config.example.json`
- Fallback bei fehlender Config: hartcodierter Default + Warnung im UI

### CLI-Änderungen (`src/cli/App.tsx`)
- `activeModel` als React-State (statt `useMemo`)
- `useEffect` synchronisiert `agent.setModel(activeModel)` bei Änderung
- `/model` öffnet Picker mit verfügbaren Modellen
- ↑/↓/Enter/Esc Navigation im Model-Picker
- Header zeigt aktives Modell und updated sofort nach Wechsel

### Tests
- `tests/cli/App.test.tsx` — 3 neue Tests für Picker, Wechsel und `setModel`-Aufruf

---

## Berührte Dateien (Worktree)

```
src/cli/App.tsx
src/cli/commands.ts
src/core/agent.ts
tests/cli/App.test.tsx
tests/cli/commands.test.tsx
tests/agent.test.ts
harness.config.example.json
harness.config.json
.env
```

---

## Bekannte Einschränkungen / Offene Punkte

- Config-Datei wird zur Laufzeit aus dem CWD gelesen (`harness.config.json`) — kein Path-Scoping
- `getModel` für dynamische Strings erfordert `as unknown as ...` Cast (pi-ai hat strenge Typisierung)
- `.env` und API-Keys müssen manuell gepflegt werden
