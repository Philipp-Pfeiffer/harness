# Memory Architecture

**Stand:** 2026-05-30, Phase 2A Step 1+2  
**Scope:** Core Memory (System-Prompt-Injection) + Markdown-Folder-Layout + QMD Retrieval Backend

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
| Memory folder | `~/memory` | `HARNESS_MEMORY_PATH` |
| Sources folder | `~/sources` | `HARNESS_SOURCES_PATH` |
| Inbox file | `~/memory/_inbox.md` | `HARNESS_INBOX_PATH` |

### Init Behavior

`ensureMemoryFolders()` (aufgerufen in `src/index.tsx` vor App-Render):

- Erzeugt `memory/` und `sources/` idempotent (`mkdir -p`).
- Erzeugt `_inbox.md` nur, wenn sie noch nicht existiert (`access` → `writeFile`).
- Loggt: `[harness] memory folders ready: <memoryPath>, <sourcesPath>`

### Design Decision: Top-Level, keine Sub-Ordner

Die Anforderung spezifiziert **keine** Sub-Ordner innerhalb von `~/memory/` oder `~/sources/`. QMD indexiert flach über `**/*.md`.

---

## 3. MemoryBackend Interface

```ts
interface MemoryBackend {
  name: string;
  search(query: string, k?: number): Promise<MemoryHit[]>;
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
| `QmdBackend` | `src/core/qmdBackend.ts` | Primärpfad — ruft QMD-CLI auf |
| `StubBackend` | `src/core/stubBackend.ts` | Fallback — no-op, leere Ergebnisse |

---

## 4. QMD Integration

### QMD Overview

[QMD](https://github.com/tobi/qmd) (Query Markdown Documents) ist eine lokale CLI-Suchmaschine für Markdown. Sie kombiniert:

- **BM25** (Lexikalisch / Keyword)
- **Vektor-Semantic-Search** (Embeddings via lokalem GGUF)
- **Hybrid + LLM-Rerank** (Reciprocal Rank Fusion + Re-Ranker)

### Installation (externe Dependency)

```bash
# QMD erfordert Bun >= 1.0.0
curl -fsSL https://bun.sh/install | bash
bun install -g https://github.com/tobi/qmd
```

**First-Run** lädt automatisch GGUF-Modelle herunter (~300MB Embedding, ~640MB Reranker, ~1.1GB Query-Expansion). Dieser Download erfolgt **beim ersten `qmd embed` oder ersten `qmd vsearch/query`** und ist nicht blockierend für den Harness-Start.

### QMD-Aufrufmodi

| Modus | CLI | Zweck | Latenz | Harness-Methode |
|-------|-----|-------|--------|-----------------|
| L2 Ambient | `qmd vsearch` | Vector-only, kein LLM | <100ms | `QmdBackend.vsearch()` |
| L4 Explicit | `qmd query` | Hybrid + LLM-Rerank | ~1.7s | `QmdBackend.query()` |

`QmdBackend.search()` defaulted zu `vsearch` (schnellster Modus).

### JSON Parsing

QMD wird mit `--json` aufgerufen. Die Ausgabe wird geparsed:

- Direktes Array: `[{ file, score, content, line }]`
- Oder verschachtelt: `{ results: [...] }`
- Unparseable / leer → `[]`

### Error Handling

- `qmd` nicht in PATH → `execFile` wirft Error (z. B. "spawn qmd ENOENT").
- Caller (z. B. ein späteres Memory-Tool) kann auf `StubBackend` fallbacken.

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
```

- **QMD ist der Primärpfad.** Wenn QMD verfügbar ist, werden alle Retrieval-Operationen darüber ausgeführt.
- **StubBackend** implementiert das gleiche Interface, liefert aber immer leere Ergebnisse. Er wird nur aktiv, wenn ein Caller explizit auf ihn zurückfällt (z. B. weil QMD nicht installiert ist).
- Es gibt keinen automatischen Fallback im Backend selbst — die Entscheidung liegt beim Aufrufer (zukünftiges Memory-Tool in Phase 2B+).

---

## 6. File Map

| Datei | Zweck |
|-------|-------|
| `src/core/coreMemory.ts` | core.md Loader, Parser, Formatter, Composer |
| `src/core/memoryFolders.ts` | Folder-Scaffolding + Env-Config |
| `src/core/memoryBackend.ts` | `MemoryBackend` Interface + Typen |
| `src/core/qmdBackend.ts` | QMD-CLI Adapter (`vsearch`, `query`, `write`) |
| `src/core/stubBackend.ts` | No-op Fallback-Implementierung |
| `core.md` | User-pflegbare Identitäts-/Projekt-Informationen |
