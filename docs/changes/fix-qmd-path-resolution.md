# fix: qmd://-Pfade in echte Dateipfade auflösen

## Problem/Symptom

QMD liefert Treffer mit `filepath`-Werten, die als `qmd://<collection>/<path>`-URIs
formatiert sind (z. B. `qmd://memory/foo.md`). Der `QmdBackend` mappte diese 1:1
auf `MemoryHit.source` bzw. `AmbientHint.path` — der spätere `readFile`-Aufruf auf
diese Pfade scheiterte mit ENOENT.

## Befund

- `searchResultToHit` (`packages/agent/src/core/qmdBackend.ts`, ~Z.11-19) mappte
  `r.filepath` direkt auf `hit.source`.
- Der Ambient-Hint-Pfad (`getAmbientHints`, ~Z.138-143) mappte `r.filepath` direkt
  auf `hit.path`.
- Die Collection-Roots waren bekannt, wurden dem Backend aber nie übergeben:
  `MemoryService` registriert `memory` → `memoryPath` und `sources` → `sourcesPath`
  (in `createStore` und `ensureCollections`).

## Was geändert wurde

### `packages/agent/src/core/qmdBackend.ts`
- `QmdBackendOptions.collectionRoots?: Record<string, string>` — Collection-Name →
  Dateisystem-Root.
- Neue exportierte Hilfsfunktion `resolveQmdFilepath(filepath, roots)`:
  - Nur wenn `filepath` mit `qmd://` beginnt: `<collection>/<path>` parsen.
  - Bekannte Collection → `${root}/${path}`.
  - Unbekannte Collection, fehlender Root, kein Slash, leerer relativer Pfad oder
    kein `qmd://`-Präfix → Originalwert unverändert (kein Crash, kein leerer Pfad).
- `searchResultToHit` nimmt jetzt die Roots entgegen und resolved `source` über
  `resolveQmdFilepath`.
- `getAmbientHints` resolved `path` über `resolveQmdFilepath`.

### `packages/agent/src/core/memoryService.ts`
- Beim Erzeugen des `QmdBackend` werden die Roots übergeben:
  `{ memory: this.config.memoryPath, sources: this.config.sourcesPath }`
  (gleiche Quellen wie die Collection-Registrierung — keine eigenen Pfad-Berechnungen).

### `packages/agent/tests/core/qmdBackend.test.ts`
- Neue Unit-Tests für `resolveQmdFilepath`: bekannte Collections (`memory`, `sources`),
  unbekannte Collection, normaler Pfad, URI ohne Slash, leeres Path-Segment, keine Roots.
- Neue Integrationstests: `vsearch`, `query` (RRF-Fusion) und `getAmbientHints`
  liefern aufgelöste Pfade, wenn `collectionRoots` gesetzt sind; unbekannte
  Collections bleiben unangetastet.

## Welche Dateien

- `packages/agent/src/core/qmdBackend.ts`
- `packages/agent/src/core/memoryService.ts`
- `packages/agent/tests/core/qmdBackend.test.ts`

## Tests

- `CI=true npx vitest run packages/agent/tests/core/qmdBackend.test.ts` →
  **19 → 30 Tests grün** (11 neue).
- `pnpm build` → clean (core + agent).
- `pnpm typecheck` (`tsc --noEmit`) → clean.
- Volle Agent-Suite: 664/665 grün — einziger Rot ist der prä-existente
  `pipeline.test.ts`-Snapshots-Rot (unverändert zum Status vor diesem Fix).
