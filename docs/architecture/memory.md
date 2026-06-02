# Memory Architecture

**Stand:** 2026-05-30, Phase 2A (SDK-Migration abgeschlossen)  
**Scope:** Core Memory (System-Prompt-Injection) + Markdown-Folder-Layout + QMD Retrieval Backend via `@tobilu/qmd` SDK

---

## 1. Core Memory → System Prompt

### Purpose
`core.md` im Harness-Root enthält persistente Identitäts- und Kontext-Informationen, die in **jeden** System-Prompt injiziert werden.

### File Layout (`core.md`)

```markdown
## Wer
<!-- Name / Identität des Harness-Owners -->

## Projekte
<!-- Aktive Projekte (kurze Liste) -->

## Working-Protocol
<!-- Verweis auf das Arbeits-Protokoll des Repos -->

## Aktive Themen
<!-- Aktueller Fokus -->
```

### Lifecycle

1. **Load** (`src/core/coreMemory.ts`): `loadCoreMemoryRaw(projectRoot?)` liest `core.md`.
2. **Parse** (`parseCoreMemorySections`): Zerlegt in die vier Sections.
3. **Format** (`formatCoreMemoryBlock`): Wrappt den Roh-Inhalt in `<core_memory>…</core_memory>`.
4. **Compose** (`composeSystemPrompt`): Hängt den Block an den Basis-System-Prompt an.
5. **Inject** (`src/cli/App.tsx`): `useEffect` lädt core.md nach App-Mount und ruft `agent.setSystemPrompt(composed)` auf.

### Fallback

- Fehlende `core.md` → Warn-Log + leerer `<core_memory></core_memory>` Block.
- Kein Crash, kein Blocker für den Agent-Loop.

---

## 2. Markdown Folder Layout

### Default Paths

| Variable | Default | Env-Override |
|----------|---------|--------------|
| Memory folder | `<projectRoot>/memory` | `HARNESS_MEMORY_PATH` |
| Sources folder | `<projectRoot>/sources` | `HARNESS_SOURCES_PATH` |
| Inbox file | `<projectRoot>/memory/_inbox.md` | `HARNESS_INBOX_PATH` |
| QMD DB | `<projectRoot>/.qmd/index.sqlite` | `HARNESS_QMD_DB_PATH` |

**Design Decision:** Alle editierbaren Runtime-Files liegen **projekt-lokal** im Harness-Root (oder dem via `HARNESS_PROJECT_ROOT` gesetzten Verzeichnis). Das ermöglicht:
- Workspace-Isolation (mehrere Projekte, kein Konflikt im Home-Verzeichnis)
- Einfaches Deployment via Symlink oder Git-Submodule
- Env-Overrides bleiben erhalten für Power-User, die z. B. `~/memory` bevorzugen

### Init Behavior

`ensureMemoryFolders()` (aufgerufen in `src/index.tsx` vor App-Render):

- Erzeugt `memory/` und `sources/` idempotent (`mkdir -p`).
- Erzeugt `_inbox.md` nur, wenn sie noch nicht existiert (`access` → `writeFile`).
- Loggt: `[harness] memory folders ready: <memoryPath>, <sourcesPath>`

### Design Decision: Top-Level, keine Sub-Ordner

Die Anforderung spezifiziert **keine** Sub-Ordner innerhalb von `memory/` oder `sources/`. QMD indexiert flach über `**/*.md`.

---

## 3. MemoryBackend Interface

```ts
interface MemoryBackend {
  name: string;
  search(query: string, k?: number, opts?: { mode?: "ambient" | "explicit" }): Promise<MemoryHit[]>;
  write(entry: MemoryEntry): Promise<void>;
}

interface MemoryHit {
  source: string;   // file path
  score: number;    // 0.0–1.0
  content: string;  // chunk text
  line?: number;    // optional
}

interface MemoryEntry {
  path: string;     // target file
  content: string;  // markdown body
}
```

### Implementierungen

| Klasse | File | Zweck |
|--------|------|-------|
| `QmdBackend` | `src/core/qmdBackend.ts` | Primärpfad — nutzt `@tobilu/qmd` SDK |
| `StubBackend` | `src/core/stubBackend.ts` | Fallback — no-op, leere Ergebnisse |

---

## 4. QMD SDK Integration

### Overview

Harness nutzt das [`@tobilu/qmd`](https://github.com/tobi/qmd) SDK (nicht mehr die CLI über `execFile`). Das SDK bietet:

- **BM25** (Lexikalisch / Keyword) — `searchLex()`
- **Vektor-Semantic-Search** (Embeddings via lokalem GGUF) — `searchVector()`
- **Hybrid + LLM-Rerank** (Reciprocal Rank Fusion + Re-Ranker) — `search()`

### Voraussetzungen

- **Node:** >= 22 empfohlen (für native SQLite-Erweiterungen)
- **macOS:** `brew install sqlite` (für `sqlite-vec`)
- **Model-Cache:** `~/.cache/qmd/models/` — GGUF-Modelle werden bei erster Nutzung automatisch heruntergeladen (~2 GB total: Embedding + Reranker)

### MemoryService — Lifecycle Owner

`src/core/memoryService.ts` ist der **einzige** Besitzer des QMD-Store-Lifecycles. Design: reine Constructor-Injection, **keine** Kopplung an TUI/CLI/Gateway.

```ts
const service = new MemoryService({
  memoryPath:   "<projectRoot>/memory",
  sourcesPath:  "<projectRoot>/sources",
  dbPath:       "<projectRoot>/.qmd/index.sqlite",
  embedModel?:  "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
});
await service.init();          // createStore → ensureCollections → update → embed
const backend = service.getBackend(); // MemoryBackend (QmdBackend oder StubBackend)
// … Runtime …
await service.shutdown();      // store.close()
```

**`init()` im Detail:**

1. Optional: `QMD_EMBED_MODEL` aus Config setzen.
2. `createStore({ dbPath, config: { collections: { memory, sources } } })`
3. `ensureCollections()`: `listCollections()` prüfen, fehlende via `addCollection()` anlegen (idempotent).
4. `store.update()` — Dateien aus dem Filesystem re-indexieren.
5. `store.embed()` — Embeddings neu berechnen (bzw. inkrementell).

**Degraded Mode:** Falls `createStore()` fehlschlägt (z. B. `sqlite-vec` nicht verfügbar, Modelle offline, Node-Version zu alt), wird `degraded = true` gesetzt, ein Warn-Log ausgegeben, und `getBackend()` liefert einen `StubBackend`. Kein Crash.

### QMD Search-Methoden

| Modus | SDK-Methode | Zweck | Latenz | Harness-Methode |
|-------|-------------|-------|--------|-----------------|
| L2 Ambient | `store.searchVector(query, { limit })` | Reine Vektor-Suche, kein Rerank | < 100 ms | `QmdBackend.vsearch()` |
| L4 Explicit | `store.search({ query, limit })` | Hybrid + LLM-Rerank | ~ 1.7 s | `QmdBackend.query()` |

`QmdBackend.search()` defaulted zu `vsearch` (schnellster Modus). `mode: "explicit"` wählt die tiefere Hybrid-Suche.

### Content Mapping

Die SDK-Rückgaben werden typisiert auf `MemoryHit` gemappt — **kein JSON-Parsing** mehr:

- `searchVector` → `SearchResult[]` mit `body?`, `title`, `chunkPos`
- `search` → `HybridQueryResult[]` mit `body`, `bestChunk`, `bestChunkPos`, `title`

Fallback-Kette: `body ?? title` (Ambient) bzw. `bestChunk ?? body ?? title` (Explicit).

### Write + Inkrementeller Index

`QmdBackend.write(entry)`:

1. Schreibt die `.md`-Datei via `node:fs/promises`.
2. Setzt ein `dirty`-Flag.
3. Queue-Microtask ruft `store.update({ collections: ["memory"] })` + `store.embed({ collection: "memory" })` auf.
4. Mehrere schnelle Writes werden so zu einem einzigen inkrementellen Update gebündelt.

### Deutsch / Embed-Model

Der Default-Embedder (`embeddinggemma-300M`) ist english-optimiert. Für deutsche Inhalte oder DE/EN-Mix:

```bash
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

**Wichtig:** Beim Modellwechsel sind alte Vektoren nicht kompatibel. Ein Re-Embed mit `force: true` ist erforderlich (wird bei `MemoryService.init()` bei Bedarf über `config.embedModel` + Umgebungsvariable gesteuert).

---

## 5. Fallback-Konzept

```
┌─────────────────┐
│  MemoryBackend  │ ← Interface
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐  ┌─────────┐
│  QMD  │  │  Stub   │
│Primary│  │Fallback │
└───────┘  └─────────┘
         ▲
         │ degraded=true
┌────────┴────────┐
│  MemoryService  │ ← Lifecycle Owner
└─────────────────┘
```

- **QMD ist der Primärpfad.** Wenn der Store erfolgreich initialisiert wird, liefert `getBackend()` ein `QmdBackend` mit Live-Store.
- **StubBackend** implementiert das gleiche Interface, liefert aber immer leere Ergebnisse. Wird automatisch bei `degraded=true` ausgegeben.
- Die Entscheidung liegt bei `MemoryService` — Aufrufer (z. B. ein späteres Memory-Tool in Phase 2B+) bekommen nur ein `MemoryBackend` und wissen nicht, ob QMD oder Stub dahintersteckt.

---

## 6. Migration zum Gateway

`MemoryService` ist heute in `src/index.tsx` instanziiert:

```tsx
const memoryService = new MemoryService({ ... });
await memoryService.init();
render(<App memoryService={memoryService} />);
```

Im **Gateway** wird exakt dieselbe Klasse im Gateway-Main instanziiert und das Backend per DI durchgereicht — **kein Aufrufer-Code ändert sich**:

```ts
// Gateway-Main (zukünftig)
const memoryService = new MemoryService({
  memoryPath:  config.memoryPath,
  sourcesPath: config.sourcesPath,
  dbPath:      config.dbPath,
});
await memoryService.init();

// DI an Agent-Handler, RPC-Server, etc.
const agentHandler = new AgentHandler({ memoryBackend: memoryService.getBackend() });
```

Das Interface `MemoryBackend` und die Klasse `MemoryService` bleiben unverändert. Nur der Erzeugungs- und Shutdown-Code wandert vom CLI-Entrypoint in den Gateway-Prozess.

---

## 7. File Map

| Datei | Zweck |
|-------|-------|
| `src/core/coreMemory.ts` | core.md Loader, Parser, Formatter, Composer |
| `src/core/memoryFolders.ts` | Folder-Scaffolding + Env-Config |
| `src/core/memoryBackend.ts` | `MemoryBackend` Interface + `MemoryHit` / `MemoryEntry` Typen |
| `src/core/memoryService.ts` | Lifecycle-Owner: Store-Init, Collection-Setup, Update/Embed, Shutdown |
| `src/core/qmdBackend.ts` | SDK-Adapter: `vsearch`, `query`, `search`, `write` |
| `src/core/stubBackend.ts` | No-op Fallback-Implementierung |
| `core.md` | User-pflegbare Identitäts-/Projekt-Informationen |
