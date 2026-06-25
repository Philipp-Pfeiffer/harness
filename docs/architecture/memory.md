# Memory Architecture

**Stand:** 2026-05-30, Phase 2A Schritt 3 (Ambient Hook)  
**Scope:** Core Memory + Markdown-Folder-Layout + QMD Retrieval Backend + L2 Ambient Hook

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
  getAmbientHints(query: string, opts?: { k?: number; minCosine?: number }): Promise<AmbientHint[]>;
  write(entry: MemoryEntry): Promise<void>;
}

interface MemoryHit {
  source: string;   // file path
  title: string;    // document title
  score: number;    // 0.0–1.0
  content: string;  // chunk text
  line?: number;    // optional
}

interface AmbientHint {
  title: string;
  path: string;
  score: number;
  snippet?: string;
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
await service.init();          // createStore → ensureCollections (schnell)
                               // update + embed laufen asynchron im Hintergrund (warmup)
const backend = service.getBackend(); // MemoryBackend (QmdBackend, WarmupGatedBackend oder StubBackend)
// … Runtime …
await service.shutdown();      // wartet auf warmup → store.close()
```

**`init()` im Detail (Background-Init):**

1. Optional: `QMD_EMBED_MODEL` aus Config setzen.
2. `createStore({ dbPath, config: { collections: { memory, sources } } })`
3. `ensureCollections()`: `listCollections()` prüfen, fehlende via `addCollection()` anlegen (idempotent).
4. `QmdBackend` wird sofort erstellt (nutzt vorhandenen Index aus SQLite).
5. `warmup()` feuert **asynchron im Hintergrund**: `store.update()` → `store.embed()` → `store.searchVector("warmup", { limit: 1 })` (Pre-warm: lädt Embedding-Modell in den Speicher).
6. `init()` **returns sofort** — die TUI rendert, Memory wärmt im Hintergrund auf.

**Warmup-Gate (`getBackend()`):**

| Zustand | `getBackend()` liefert | `getAmbientHints()` | `query()` |
|---------|----------------------|---------------------|-----------|
| Warmup läuft | `WarmupGatedBackend` | `[]` (still, nicht-blockierend) | "index warming" Meldung |
| Warmup fertig | `QmdBackend` (direkt) | Normale Ergebnisse | Normale Ergebnisse |
| Store-Erstellung fehlgeschlagen | `StubBackend` | `[]` | `[]` |

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

## 8. Ambient Retrieval Hook (L2)

### Pipeline

1. **Query extraction:** Aus der aktuellen User-Message wird reiner Text extrahiert (String- oder TextContent-Array-Content).
2. **Retrieval:** `memoryBackend.getAmbientHints(query, { k: 3, minCosine: 0.5 })` → `store.searchVector(query, { limit: 3 })`.
3. **Filter:** Treffer mit Cosine-Score < 0.5 werden verworfen.
4. **Formatierung:** `formatMemoryHint(hits)` baut den `<memory_hint>`-Block (tiered: Top-1 mit Snippet, Top-2/3 ohne).
5. **Injektion:** Der Block wird **ephemer an den per-call `systemPrompt` angehängt**. Die `messages`-Liste wird weder mutiert noch kopiert noch umgebaut.

### Design-Entscheidungen

| Aspekt | Entscheidung | Begründung |
|--------|-------------|------------|
| Injection-Ziel | `systemPrompt` (per-call) | Keine Mutation der History, keine consecutive-user-Messages, native Multimodalität bleibt erhalten |
| L2 Modus | `searchVector` (vector-only) | < 100 ms/Turn, kein LLM-Rerank, kein Query-Expansion |
| Threshold | `minCosine = 0.5` | QMD `score = 1 - bestDist` = roher Cosine. 0.5 = 60° Winkel, filtert schwache Treffer |
| Snippet | Top-1 nur, aus `body` | Phase-A-Limitation: Chunk-Text nicht direkt verfügbar; `body` kann Titel duplizieren |
| 0 Hits | `null` → nichts injizieren | Kein leerer Wrapper, Loop verhält sich exakt wie Baseline |

### Abgrenzung zu L4 (Schritt 4)

- **L2 Ambient** = automatisch vor jedem Turn, `searchVector`, schnell, kein Rerank.
- **L4 Explicit** = `search_memory`-Tool, `searchLex()` + `searchVector()` + RRF (kein LLM), auf User-Anfrage. Siehe §10.

---

## 10. Explicit Search Tool (L4)

**Status:** implementiert (Phase 2A Schritt 4)

### Tool: `search_memory`

| Eigenschaft | Wert |
|-------------|------|
| Name | `search_memory` |
| Datei | `src/tools/searchMemory.ts` |
| Input | `query: string` (required, minLength 1) |
| Backend-Aufruf | `MemoryBackend.query(query, 10)` → `QmdBackend.query()` → `searchLex()` + `searchVector()` + RRF |
| Default K | 10 |
| Read-only | ✅ — keine Writes, keine Message-Mutation |
| Degraded Mode | Graceful: gibt Hinweis-Text zurück, kein Throw |
| LLM-Beteiligung | ❌ — keine Query Expansion, kein Reranking |

### Unterschied zum Ambient Hook (L2)

| Aspekt | L2 Ambient Hook | L4 Explicit `search_memory` |
|--------|-----------------|-----------------------------|
| Trigger | Automatisch vor jedem Turn | Vom Agent bewusst als Tool-Call |
| Backend-Methode | `getAmbientHints()` → `searchVector()` | `query()` → `searchLex()` + `searchVector()` + RRF |
| Retrieval | Vector-only | BM25 + Vector + Reciprocal Rank Fusion |
| LLM-Calls | 0 | 0 (keine Expansion, kein Rerank) |
| Top-K | 3 | 10 |
| Output | Ephememer `<memory_hint>`-Block im System-Prompt | Tool-Result-Message mit strukturiertem Text |
| Latenz | < 100 ms (nach Cold-Start) | < 200 ms (BM25 + vector parallel, keine LLM-Calls) |

### Output-Format

```
--- memory search: N results ---
[1]
Path: /proj/memory/arch.md
Score: 0.920
Content: Architecture: MVC pattern with Ink

[2]
Path: /proj/memory/tools.md
Score: 0.810
Content: Tool registry pattern
```

Bei 0 Treffern:
```
--- memory search: 0 results ---
No matching notes found.
```

Bei fehlendem Backend (degraded):
```
--- memory search: unavailable ---
No memory backend configured. Memory search is not available.
```

### Integration

- `loadTools(memoryBackend?)` in `src/tools/registry.ts` — Factory `createSearchMemoryTool(memoryBackend)` erzeugt das Tool mit Backend im Closure.
- `src/cli/App.tsx` — übergibt `memoryService?.getBackend()` an `loadTools()`.
- `MemoryBackend`-Interface hat `query()` als eigene Methode (ergänzt in Schritt 4).
- `QmdBackend.query()` nutzt `searchLex()` + `searchVector()` + inline RRF (k=60). **Kein** `store.search()`, **keine** LLM-Query-Expansion, **kein** LLM-Rerank.

---

## 11. Inbox Append Pattern (Step 5)

**Status:** implementiert (Phase 2A Schritt 5)

### Konzept

Bei explizitem User-Request ("merk das" / "remember") appended der Agent einen Bullet an `memory/_inbox.md` — unter Nutzung des **vorhandenen edit-Tools**, ohne neues Tool oder neue API.

### Prompt-Contract

Die System-Prompt-Klausel (`prompts/system-prompt.md`) weist den Agent an:

1. **Trigger:** User sagt explizit "merk das" oder "remember" + Inhalt.
2. **Aktion:** `readFile` auf `{{inboxPath}}` → `edit`-Tool: Bullet (`- `) am Ende einfügen.
3. **Keine Heuristik:** Nur explizit angeforderte Dinge, keine automatische Zusammenfassung am Session-Ende.
4. **Pfad:** `{{inboxPath}}` wird via `prompt("system-prompt", { inboxPath })` substituiert. Default: `<projectRoot>/memory/_inbox.md` (via `resolveMemoryConfig()`).

### Was NICHT implementiert ist

- Kein `remember`-Tool — der Agent nutzt `edit`.
- Keine Intent-Heuristik / Auto-Write — nur bei explizitem User-Request.
- Keine Session-End-Distillation.
- Keine neue Tool-API.

### Integration

- `prompts/system-prompt.md` — Klausel mit `{{inboxPath}}`-Platzhalter.
- `src/cli/App.tsx:676` — `prompt("system-prompt", { inboxPath: resolveMemoryConfig().inboxPath })`.
- `src/core/memoryFolders.ts` — `resolveMemoryConfig()` liefert den konfigurierten Inbox-Pfad.

---

## 9. File Map

| Datei | Zweck |
|-------|-------|
| `src/core/coreMemory.ts` | core.md Loader, Parser, Formatter, Composer |
| `src/core/memoryFolders.ts` | Folder-Scaffolding + Env-Config |
| `src/core/memoryBackend.ts` | `MemoryBackend` Interface + `MemoryHit` / `AmbientHint` / `MemoryEntry` + `formatMemoryHint` |
| `src/core/memoryService.ts` | Lifecycle-Owner: Store-Init, Background-Warmup (update+embed+pre-warm async), WarmupGatedBackend, Embed-Model-Marker, Shutdown |
| `src/core/qmdBackend.ts` | SDK-Adapter: `vsearch`, `query` (searchLex + searchVector + RRF, kein LLM), `search`, `getAmbientHints`, `write` |
| `src/core/stubBackend.ts` | No-op Fallback-Implementierung |
| `src/tools/searchMemory.ts` | `search_memory`-Tool: Factory mit `MemoryBackend`-Closure, read-only, L4 Explicit Search |
| `core.md` | User-pflegbare Identitäts-/Projekt-Informationen |
