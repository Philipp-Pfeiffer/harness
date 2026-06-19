# Fix: CLI Selection Mode (Scroll & Copy)

**Date:** 2026-06-19
**File:** `src/cli/App.tsx`

## Problem

Ink aktiviert `stdin.setRawMode(true)` beim `render()`-Aufruf. In Raw Mode fängt die App jeden Tastendruck/Maus-Event ab, bevor das Terminal ihn verarbeiten kann. Dadurch funktionieren weder Maus-Selektion (Text markieren zum Kopieren) noch Maus-Rad-Scrolling im Terminal.

Der frühere Fix (Commit `cda296e`, Phase-1-CLI-Statusbar) hatte `<Static>` für Scrollback hinzugefügt, aber das Raw-Mode-Problem nicht gelöst. Mouse-Selection war in `phase-1-cli-statusbar.md` explizit als "Out of Scope" markiert.

## Lösung

Neuer **Selection Mode** über `Ctrl+E`:

1. **`Ctrl+E`** aktiviert den Selection Mode
   - `setRawMode(false)` gibt die Kontrolle ans Terminal zurück
   - Terminal übernimmt Maus-Selektion und Scroll-Handling
2. **Blink-Timer pausiert** (`paused` prop auf `PromptInput`)
   - Keine Re-Renders, die die Selektion stören
   - PromptInput-Input-Handler pausiert (`Ctrl+E` early-return)
3. **Visueller Indikator:** `⬛ Selection mode — scroll & select freely, press Enter to return`
4. **Enter** (oder beliebige stdin-Daten) beendet den Mode
   - `setRawMode(true)` wird wiederhergestellt
   - App läuft normal weiter

## Code-Änderungen

### `src/cli/App.tsx`

- `useStdin` importiert (für `setRawMode`)
- `selectionMode` state (boolean)
- `useEffect`: bei `selectionMode=true` → `setRawMode(false)` + `stdin.once("data")` Listener
- App-Level `useInput`: `Ctrl+E` toggelt `selectionMode`
- `PromptInput`: `paused` prop → Blink-Timer stoppt, `Ctrl+E` early-return
- Render: Selection-Mode-Indikator + `paused={selectionMode}` auf `PromptInput`
- `HelpCard`: `Ctrl+E – Selection mode (scroll & copy)` hinzugefügt

## Keybinds Reference (neu)

| Keybind | Context | Aktion |
|---------|---------|--------|
| `Ctrl+E` | Global | Selection Mode ein/aus (raw mode off — scroll & copy) |
| `Enter` | Selection Mode | Zurück zur normalen Eingabe |

## Limitationen

- Der Selection Mode ist ein "Pause"-Modus: während er aktiv ist, kann nicht tippt man nicht im Prompt
- Dies ist die einfachste Lösung ohne externe Dependencies (`ink-scroll`, `ink-select-input`, etc.)
