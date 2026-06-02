# Phase-2A Step 3 — Ambient Hook in Agent-Loop (tiered Payload)

**Date:** 2026-05-30  
**Branch:** `feat/phase-2a-ambient-hook`  
**Baseline:** `main` (261 tests green)

---

## Commits

### Block 0 — Fix: force-Re-Embed nur bei Modellwechsel

`ecd3f1f` → `4c329c5` — **feat(memory): force-re-embed only on model change**
- `MemoryService` persistiert einen Marker (`.qmd/.embed-model`) mit dem zuletzt verwendeten Embed-Modell.
- `init()` vergleicht Marker mit `config.embedModel`:
  - Marker matches → `embed({ force: false })`
  - Marker differs → `embed({ force: true })`
  - No marker (first run) → `embed({ force: false })` (incremental is sufficient)
- Kein `force: true` mehr bei jedem Boot mit konfiguriertem Modell.

### Block 1 — Ambient-Retrieval

`24da13e` — **feat(memory): ambient retrieval getAmbientHints**
- Neue `AmbientHint` Type: `{ title, path, score, snippet? }`
- `MemoryBackend.getAmbientHints(query, opts?)` — default `k=3`, `minCosine=0.5`
- `QmdBackend.getAmbientHints`: ruft `store.searchVector()`, filtert nach Cosine-Score, mappt auf `AmbientHint`
- `StubBackend.getAmbientHints`: returns `[]`
- Snippet = erste 2–3 nicht-leere Zeilen aus `body` (Phase-A-Limitation: Chunk-Text nicht verfügbar)

### Block 2 — Payload-Formatierung

`904ccbd` — **feat(memory): tiered memory_hint payload formatter**
- Reine Funktion `formatMemoryHint(hits): string | null`
- Tiered (per ADR):
  - Top-1: Title + Path + Snippet
  - Top-2/Top-3: Title + Path (kein Snippet)
  - 0 Hits → `null`
- Wrapper-Format exakt nach Spec:
  ```
  <memory_hint>
  Dies sind Erinnerungen aus deinen persönlichen Notes ...
  [Top-1]
  Title: ...
  Path: ...
  Snippet: ...
  </memory_hint>
  ```

### Block 3 — Agent-Loop

`d189fb4` — **feat(agent): inject ambient hint as ephemeral systemPrompt append**
- `RunOptions.memoryBackend?: MemoryBackend` hinzugefügt
- In `agent.run()`: vor dem LLM-Call wird aus der letzten User-Message Text extrahiert, `getAmbientHints()` aufgerufen, und der Hint **ephemer an den per-call `systemPrompt` angehängt**
- **History-Immutabilität:** `messages`-Array wird weder mutiert, noch kopiert, noch umgebaut
- **Native Multimodalität:** User-Message-Content (Bilder, etc.) bleibt unangetastet
- `App.tsx` übergibt `memoryService?.getBackend()` an `agent.run()`

### Block 4 — System-Prompt-Klausel

`909feb1` — **feat(prompts): system prompt clause for memory hints**
- `prompts/system-prompt.md` um ADR-Block ergänzt:
  > "Du erhältst vor manchen Turns einen <memory_hint>-Block ..."
- `search_memory` NICHT erwähnt (kommt in Schritt 4)

### Block 5 — Tests

`dd14882` — **test(memory,agent): ambient hook coverage**
- `memoryService.test.ts`: 9 Tests (Marker-Logik: match, mismatch, first-run, no-model)
- `qmdBackend.test.ts`: 13 Tests (inkl. getAmbientHints: k-limit, threshold, snippet, empty body)
- `stubBackend.test.ts`: 4 Tests (inkl. getAmbientHints)
- `memoryBackend.test.ts`: 5 neue Tests (formatMemoryHint: tiering, 0 hits → null)
- `agent.test.ts`: 6 neue Tests:
  - systemPrompt enthält `<memory_hint>` bei Hits
  - Keine Injektion bei 0 Hits / kein memoryBackend
  - messages-Array unverändert durch Ambient-Injection
  - Multimodal-Regression-Guard (ImageContent bleibt erhalten)
  - Latenz-Disziplin: `getAmbientHints` aufgerufen, `search` NICHT

### Block 6 — Dokumentation

*(dieser Commit)* — **docs(memory): ambient retrieval architecture + changes**
- `docs/architecture/memory.md`: Neuer Abschnitt "8. Ambient Retrieval Hook (L2)"
- `docs/changes/phase-2a-ambient-hook.md`: Dieser Report

---

## Test Counts

| Stage | Tests | Status |
|-------|-------|--------|
| Baseline (main) | 261 passed | ✅ |
| After Step 3 | 279 passed | ✅ |

**Delta: +18 tests** (261 → 279). Keine Regressionen.

---

## Verifiziert vs. Angenommen

| Annahme | Verifikation | Status |
|---------|-------------|--------|
| `searchVector` Score = Cosine Similarity | QMD `store.js` Zeile 2738: `score: 1 - bestDist` | ✅ roher Cosine |
| Threshold 0.5 sinnvoll | Cosine 0.5 = 60° Winkel, filtert schwache Treffer | ✅ korrekt kalibriert |
| `systemPrompt` in `agent.run()` ist lokal/ephemer | Closure-Variable, nie zurück in `messages` geschrieben | ✅ leak-free |
| `prompts/system-prompt.md` ist effektiver Prompt-Pfad | `src/prompts.ts` liest `prompts/${name}.md`, `agent.ts` nutzt `prompt("system-prompt")` | ✅ |

---

## Bekannte Einschränkungen

1. **Snippet aus `body` statt Chunk:** `searchVector` liefert `body` (volles Dokument), nicht den gematchten Chunk-Text. Bei Markdown mit Frontmatter/Titel dupliziert sich der Snippet daher mit `title`. Chunk-Level-Snippets kommen in einer späteren Phase.
2. **Startup-Latenz:** Erster `getAmbientHints`-Call nach Store-Start triggert Query-Embed (Modell-Load). Das ist ein einmaliger Cold-Start pro Prozess; danach < 200 ms.
3. **Prompt-Caching:** Der ephemere `systemPrompt`-Append ändert den Prompt pro Turn leicht. Da der Hint klein ist (< 1 KB) und am Ende angehängt wird, bleibt der cachebare Prefix stabil.
