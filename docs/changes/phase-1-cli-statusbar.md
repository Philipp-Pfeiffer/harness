# Phase 1: Persistent Input mit Bottom Status Bar

**Branch:** `phase-1/cli-statusbar`  
**Commits:**
- `2914b44` — feat(cli): persistent input with bottom status bar
- `a0fbd8a` — fix(cli): <Static> für abgeschlossene Turns, Input+StatusBar fixiert

---

## Ziel

Die CLI von einem Header-oben-Layout auf ein dreizoniges Bottom-Layout umstellen:
1. **Content-Bereich** (scrollbar): abgeschlossene Turns + aktiver Turn
2. **Persistent Input** (1 Zeile): immer sichtbar, auch während Streaming
3. **Status-Bar** (unten): Model · Status · CWD

## Änderungen

### `src/cli/App.tsx`

| Komponente | Vorher | Nachher |
|------------|--------|---------|
| `Header` | Oben, marginBottom | Entfernt |
| `StatusBar` | — | Neu, unten, zeigt `harness · model · status · cwd` |
| `PromptInput` | Nur sichtbar wenn `!isRunning` | Immer sichtbar, bekommt `isRunning`-Prop |
| Enter-Handling | Sendet sofort | Blockiert während `isRunning`, Text bleibt erhalten |
| Layout | Flache Spalte | Root-Box → `<Static>` → Live-Content → Input → StatusBar |
| Resize | `process.stdout.columns` | `useStdout` + `resize`-Event-Listener |

### `<Static>`-Hybrid

- Abgeschlossene Turns (außer dem letzten) werden in `<Static>` gerendert
- Sie landen im Terminal-Scrollback und verlassen den Live-Render-Baum
- Letzter abgeschlossener Turn bleibt live → **Ctrl+O** funktioniert weiterhin
- Aktiver Turn + Input + StatusBar bleiben dadurch immer am unteren Rand

### Tests (`tests/cli/App.test.tsx`)

5 neue Tests in `describe("Persistent input and status bar")`:

1. Status-Bar zeigt Model, Status und CWD
2. Input bleibt während Streaming sichtbar
3. Tippen während Stream möglich
4. Enter wird während Stream blockiert
5. Multi-Line-Input (Shift+Enter) während Stream erhalten

**Gesamt:** 163 Tests grün (158 bestehende + 5 neue)

## Annahmen & Tradeoffs

- **Kein Token-Counter:** Nicht im Code vorhanden, daher nicht in StatusBar
- **Keine Mailbox/Queue:** Enter während Stream wird ignoriert, nicht gepuffert. Steering-Logik kommt separat (Worktree C)
- **Long-Session-Performance:** Aktuell kein Problem gemessen. Falls >100 Turns, hybrider `<Static>`-Ansatz bereits implementiert
- **Scrollback:** Funktioniert nativ via Terminal-Emulator (ink schreibt in stdout)

## Out of Scope

- Steering-Logik / Mailbox / Queue
- Mouse-Selection (→ nachträglich umgesetzt: `Ctrl+E` Selection Mode, siehe `fix-cli-selection-mode.md`)
- Themes / Farbschemata
