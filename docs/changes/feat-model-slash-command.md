# feat: `/model` Slash-Command mit Keyword-Matching

## Problem

`/model <ref>` verlangte bisher exakte Treffer auf `alias`, `model` oder
`provider/model`. Kurze, stabile Bezeichner wie `flash` oder `pro` waren nicht
eindeutig auflösbar (der `alias` dient als Anzeigename, z.B. "DeepSeek Flash"),
und es gab keine Möglichkeit, auf das Default-Modell zurückzusetzen.

## Befund

- `ConfigModel` hatte kein Keyword-Feld; `/model` matchte nur exakt auf
  `alias`/`model`/`provider/model` (case-sensitive, kein Substring-Fallback).
- `resolveModelRef` teilte die Match-Logik mit dem Handler, aber nicht identisch.
- `setSessionModelRef` persistierte einen leeren String als `modelRef` statt
  "kein Ref" — ein Reset auf Default war so nicht sauber modellierbar.
- `/model` ohne Argument listete alle Modelle; gewünscht war die Anzeige des
  aktuellen Modells.

## Was geändert wurde

### Config-Schema (`packages/core/src/config.ts`)

- `ConfigModel` bekommt ein optionales Feld `keyword?: string` — ein kurzer,
  eindeutiger Bezeichner für `/model <keyword>` (z.B. `"flash"`). Der bestehende
  `alias` bleibt der Anzeigename und ist unverändert.

### Match-Logik (`packages/agent/src/daemon/runtime.ts`)

- Neuer privater Helper `findConfigModel(ref)`: matcht case-insensitiv in
  Prioritätsreihenfolge (erstes Treffer gewinnt):
  1. exaktes `keyword`
  2. exakte `model`-ID
  3. exakter `alias`
  4. exaktes `provider/model`
  5. Substring-Match auf keyword/model/alias/provider (nur nicht-leere Felder)
- `resolveModelRef` nutzt `findConfigModel` — Handler und Turn-Auflösung sind
  konsistent.
- `inferModelRefFromSessionLabel` kennt zusätzlich `keyword`.

### `/model`-Handler

- `/model` (ohne Argument) → zeigt das aktive Modell der Session:
  `Modell: DeepSeek Flash (128k)` (Modellname + Kontextfenster in k).
- `/model <keyword>` → wechselt das Modell session-gebunden und persistiert den
  Ref (wie bisher via `entry.modelRef` + `setSessionModelRef`).
- `/model default` → setzt die Session auf das Default-Modell zurück
  (`modelRef` wird entfernt).
- Kein Match → `Unbekanntes Modell: "x". Verfügbar: flash, pro, ...` (Keyword
  bevorzugt, sonst alias/provider-model).
- Antwortformat einzeilig und WhatsApp-tauglich:
  `Modell: DeepSeek Flash (128k)` — kein Menü, keine Liste.
- `formatContextWindow(n)` — neuer Top-Level-Helper (131072 → `128k`).

### Session-Reset (`packages/agent/src/core/session.ts`)

- `setSessionModelRef(session, "", paths)` → `modelRef` wird auf `undefined`
  normalisiert statt `""` zu persistieren.
- `readTranscript` ignoriert leere `modelRef`-Werte beim Laden (kein `""` mehr
  nach einem Reset nach Restart).

### Keywords in `~/harness/config.json`

- `keyword` vergeben für: `flash` → `@preset/deepseek-flash`,
  `pro` → `@preset/deepseek-pro`, `vision` → `@preset/vision`,
  `kimi` → `kimi-for-coding`, `k3` → `k3`.
- `harness.config.example.json` dokumentiert das Feld.

## Dateien

| Datei | Änderung |
|-------|----------|
| `packages/core/src/config.ts` | `keyword?: string` auf `ConfigModel` |
| `packages/agent/src/daemon/runtime.ts` | `findConfigModel`, `/model default`, Anzeige `/model`, Feedback-Format, `currentSessionModel`, `formatContextWindow` |
| `packages/agent/src/core/session.ts` | `setSessionModelRef`-Reset + `readTranscript` ignoriert leere Ref |
| `~/harness/config.json` | `keyword`-Felder für 5 Modelle |
| `harness.config.example.json` | Beispiel `keyword` |
| `packages/agent/tests/daemon/modelRef.test.ts` | +6 Tests für Keyword-Matching |

## Tests

- `tests/daemon/modelRef.test.ts` (neu, 6 Tests):
  - `/model FLASH` (case-insensitive) → richtiges Modell + Ref persistiert.
  - exakte Model-ID ohne Keyword.
  - Substring-Fallback + mehrere Keywords.
  - Unbekanntes Modell → verfügbare Keywords im Fehler.
  - `/model default` → `modelRef` entfernt, Daemon-Modell gemeldet.
  - `/model` ohne Argument → zeigt aktives Modell.
- `pnpm build` + `pnpm typecheck` grün.
- `pnpm --filter @harness/agent test` (503 Tests) grün.
- `pnpm --filter @harness/core test` grün bis auf einen umgebungsbedingten
  sudo-Test (`exec elevated`, kein passwordless sudo — auch auf `main` rot).

## Non-Goals

- Kein Ambiguity-Dialog — `keyword` ist eindeutig, erstes Match gewinnt.
- Kein neues Config-Feld `aliases` (Array) — `keyword` (String) reicht.
- Der TUI-Modell-Picker (lokaler `/model`-Fluss ohne Argument) bleibt unverändert;
  `/model <arg>` in der TUI geht wie bisher an den Daemon.
- Kein Push, kein Deploy.
