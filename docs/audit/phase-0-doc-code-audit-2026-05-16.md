# Phase 0 · Doc-Code-Audit · 2026-05-16

## Executive Summary

| Metrik | Wert |
|--------|------|
| Anzahl Tools im Code | 5 (+ 9 Helper-Module) |
| Tools mit vollständiger Doku | 2 (exec, process) — partiell |
| Tools ohne Doku | 0 (alle haben mind. 1 Datei) |
| Drift-Befunde gesamt | 8 kritisch/wichtig, 4 nice-to-have |
| Loop-Schritte komplett (ADR-001 Schritte 1–4) | 1,5 / 4 |

**Wichtigster Befund:** Die Doku `docs/tools/write_edit_registry.md` ist komplett veraltet (referenziert gelöschtes `echoTool` und umbenanntes `bashTool`). Zwei weitere kritische Drifts: `readFile` markiert PDF-Reads nicht als gelesen (trotz Doku-Versprechen), und die Background-RingBuffer-Größe beträgt 64 KB statt dokumentierter 200 KB.

---

## 1 · Discovery

### 1a · Tool-Inventar (Code)

| # | Datei | Tool-Name | Kurz-Zweck |
|---|-------|-----------|------------|
| 1 | `src/tools/readFile.ts` | `readFileTool` | Liest UTF-8-Text und PDF (Magic-Byte-Erkennung, pdfjs-dist), optional mit Zeilen-Range, 64-KB-Cap. |
| 2 | `src/tools/exec.ts` | `execTool` | CLI-Execution via `child_process.spawn` (shell: true). Sync, PTY, elevated, background, yieldMs. 64-KB-Output-Cap. No-Fly-List. |
| 3 | `src/tools/process.ts` | `processTool` | Lifecycle-Management für Background-Prozesse (list, poll, kill, log, wait). |
| 4 | `src/tools/write_file.ts` | `writeTool` | Atomares Write (`tmp + rename`). Blockt sensitive Pfade. |
| 5 | `src/tools/edit_file.ts` | `editTool` | Sequentielles Find-and-Replace. Erfordert vorheriges `read`/`write`. |

**Helper-Module (keine eigenen Tool-Constants):**

| Datei | Rolle |
|-------|-------|
| `src/tools/atomic_write.ts` | Atomares Write (`tmp + rename + cleanup`). |
| `src/tools/file_state.ts` | In-Memory `Set<string>` für Read-Before-Edit-Tracking. |
| `src/tools/path_util.ts` | `expandTilde()` — Tilde-Expansion. |
| `src/tools/execPty.ts` | PTY-Execution via `node-pty`. |
| `src/tools/execBackground.ts` | Sofortiger detached Background-Spawn. |
| `src/tools/processSupervisor.ts` | Singleton für Session-Registry, GC, Kill, Poll, Wait. |
| `src/tools/ringBuffer.ts` | `RingBuffer` (capped append-only Buffer) + `generateHandle()`. |
| `src/tools/types.ts` | `Tool<TParameters>` Interface. |

**Registry / Loader:**
- `src/tools/registry.ts` exportiert `loadTools()`, das die 5 Tools in einem **hartkodierten Array** zurückgibt: `[readFileTool, execTool, processTool, writeTool, editTool]`.
- `src/tools/index.ts` re-exportiert nur `readFileTool`.
- `src/index.ts` ruft `loadTools()` auf und übergibt das Array an `createAgent()`.

### 1b · Loop- / Core-Module

| Datei | Verantwortlichkeit |
|-------|-------------------|
| `src/core/agent.ts` | **Agent-Loop & Orchestration.** Baut pro Turn ein pi-ai `Context`, ruft `complete()` auf, führt Tools sequenziell aus, loggt truncated, baut `ToolResultMessage`, iteriert bis `maxIterations` (default 10). |
| `src/core/context.ts` | **Orphaned Skeleton.** Definiert `Message`, `Context`, `createContext`, `addMessage`, `trimContext`. Wird **nicht** von `agent.ts` oder `index.ts` importiert. |
| `src/core/session.ts` | **Orphaned Skeleton.** Definiert `Session`, `createSession`, `touchSession`. Wird **nicht** vom Agent-Loop genutzt. |
| `src/index.ts` | CLI-Entrypoint. Lädt Tools, erzeugt Agent, startet interaktive Readline-Loop. |

### 1c · Doku-Inventar

| Pfad | Erste Überschrift | Kategorie |
|------|-------------------|-----------|
| `AGENTS.md` | `# AGENTS.md` | Sonstiges (Projekt-Konventionen) |
| `README.md` | `# Harness` | README |
| `docs/README.md` | `# Harness – Documentation` | README |
| `docs/agent/loop.md` | `# Agent Loop` | Architektur |
| `docs/architecture/exec-tool-architecture.md` | `# exec-Tool — Technical Architecture` | Architektur |
| `docs/tools/edit.md` | `# Tool: edit (edit_file)` | Tool-Docs |
| `docs/tools/exec.md` | `# Tool: exec` | Tool-Docs |
| `docs/tools/file_state.md` | `# Modul: file_state` | Tool-Docs |
| `docs/tools/index.md` | `# Tools Documentation` | Tool-Docs |
| `docs/tools/process.md` | `# Tool: process` | Tool-Docs |
| `docs/tools/readFile.md` | `# Tool: readFile` | Tool-Docs |
| `docs/tools/readFile_extension.md` | `# Tool: readFile – Erweiterung` | Tool-Docs |
| `docs/tools/write.md` | `# Tool: write (write_file)` | Tool-Docs |
| `docs/tools/write_edit_registry.md` | `# Tool-Registry – write & edit` | Tool-Docs |

**Zusammenfassung:** 9 Tool-Docs, 2 Architektur-Docs, 2 READMEs, 1 AGENTS.md.

---

## 2 · Per-Tool-Audit

### Tool: readFile

**Code-Datei:** `src/tools/readFile.ts`  
**Doku-Datei(en):** `docs/tools/readFile.md`, `docs/tools/readFile_extension.md`  
**Registrierung:** `src/tools/registry.ts` (hartkodiertes Array)

#### Audit-Tabelle

| Aspekt | Im Code | In der Doku | Status |
|--------|---------|-------------|--------|
| Tool-Name (string-id) | `readFile` | `readFile` | ✅ |
| Input-Schema (Args + Typen) | `path: string`, `lineStart?: integer (min 1)`, `lineEnd?: integer (min 1)` | Identisch | ✅ |
| Pflicht- vs. Optional-Args | `path` = req, `lineStart`/`lineEnd` = opt | Identisch | ✅ |
| Return-Format | Plain: roher Text oder `--- Lines X-Y of Z ---\n<content>`; PDF: `--- PDF, N pages ---\n<text>` | Identisch | ✅ |
| Validierungen | 64-KB-Cap, Null-Byte-Detection, PDF-Magic-Bytes, `lineStart>lineEnd`→Error, `lineStart>total`→Error, `lineEnd>total`→silent clamp | Identisch | ✅ |
| Side-Effects | Filesystem-Read, PDF-Parsing via `pdfjs-dist`, `markRead()`-Aufruf | `markRead()` nur in `readFile_extension.md` dokumentiert | 🟡 |
| Error-Cases | `ENOENT`, `EACCES`, `EISDIR`, Null-Byte, >64KB, PDF-Parse-Fehler, `lineStart>lineEnd`, `lineStart` out of range | Identisch | ✅ |
| Beispiel-Aufrufe | — | Keine direkten Beispiele, nur Fixture-Tabelle | ⚪ |
| Bekannte Limits | Kein Path-Scoping, kein Logger, kein Binary-Decode, keine weiteren Formate | Identisch | ✅ |

#### Befunde

- **Undokumentiert:** Keine.
- **Drift:**
  - `docs/tools/readFile_extension.md` verspricht `markRead(resolvedPath)` im **PDF-Pfad** (Zeilen 20–23), aber im Code (`src/tools/readFile.ts` Zeilen 94–117) wird `markRead()` **nicht** für PDF aufgerufen. Nur Plain-Text-Pfade rufen `markRead()` auf (Zeilen 137, 143). Konsequenz: Ein direkt nach `readFile` aufgerufenes `edit` an einer PDF-Datei würde an `READ_REQUIRED` scheitern.
- **Doku-only:**
  - `docs/tools/readFile.md` → Abschnitt "Nicht enthalten (MVP)" listet `writeFile` / `editFile`. Diese Tools **sind inzwischen implementiert** (seit Phase 1+2). Die Notiz ist veraltet.

---

### Tool: exec

**Code-Datei:** `src/tools/exec.ts` (Hauptdatei), `src/tools/execPty.ts`, `src/tools/execBackground.ts`  
**Doku-Datei(en):** `docs/tools/exec.md`, `docs/architecture/exec-tool-architecture.md`  
**Registrierung:** `src/tools/registry.ts`

#### Audit-Tabelle

| Aspekt | Im Code | In der Doku | Status |
|--------|---------|-------------|--------|
| Tool-Name (string-id) | `exec` | `exec` | ✅ |
| Input-Schema (Args + Typen) | `command: string (minLength 1)`, `cwd?: string`, `env?: Record<string,string>`, `stdin?: string`, `timeout?: integer (100–3.600.000, default 30.000)`, `pty?: boolean (default false)`, `elevated?: boolean (default false)`, `background?: boolean (default false)`, `yieldMs?: integer (0–600.000, default 10.000)` | Identisch | ✅ |
| Pflicht- vs. Optional-Args | Nur `command` req, Rest opt | Identisch | ✅ |
| Return-Format | Sync: `--- stdout ---\n…\n--- stderr ---\n…\n--- exit ---\ncode: …, signal: …`; PTY: `--- output ---\n…`; Background: Handle-Block; Timeout: prepend `Command timed out…` | Identisch | ✅ |
| Validierungen | `Value.Check` (TypeBox), Cross-Field (`pty+stdin`, `background+stdin`), No-Fly-Patterns, CWD-Directory-Check | Identisch | ✅ |
| Side-Effects | Process-Spawn (sync/detached/PTY), Process-Group-Kill (`-pid`), Background-Registrierung beim Supervisor, Signal-Sendung | Identisch | ✅ |
| Error-Cases | `Invalid arguments`, `cwd does not exist…`, `Blocked destructive command…`, `Failed to spawn…`, `Process error…`, Timeout, Cross-Field-Errors | Identisch | ✅ |
| Beispiel-Aufrufe | — | Umfangreich in `docs/architecture/exec-tool-architecture.md` (14 Test-Cases) und `docs/tools/exec.md` | ✅ |
| Bekannte Limits | Kein Live-PTY-Input, kein Output-Spill, kein ANSI-Strip, keine Persistenz, kein stdin-Streaming, keine Workspace-Policy | Identisch | ✅ |

#### Befunde

- **Undokumentiert:**
  - `yieldMs = 0` im Schema erlaubt (`minimum: 0`), führt aber im Code (`exec.ts` Zeile 554) zu einem Sync-Fallback (`if (args.yieldMs !== undefined && args.yieldMs > 0)`). Dieses Edge-Case-Verhalten ist nicht dokumentiert.
- **Drift:**
  - **RingBuffer-Größe:** `docs/tools/exec.md` (Tabelle "Grenzen") und `docs/architecture/exec-tool-architecture.md` (Tabelle "Output-Cap") behaupten **200 KB pro Stream** für den RingBuffer. Im Code (`exec.ts`, `execBackground.ts`, `execPty.ts`) wird jedoch überall `MAX_OUTPUT_BYTES = 64 * 1024` (64 KB) an den `RingBuffer` übergeben. Der Default-Konstruktor von `ringBuffer.ts` ist zwar `200_000`, wird aber **nie** verwendet.
  - **PTY-Timeout-Format:** `docs/tools/exec.md` zeigt im Timeout-Beispiel (`--- stdout ---`) nur das Sync-Format. Für PTY-Timeouts gibt der Code (`execPty.ts`) jedoch `--- output ---` aus. Die Doku unterscheidet nicht zwischen Sync- und PTY-Timeout-Format.
  - **Architektur-Diagramm-Inkonsistenz:** In `docs/architecture/exec-tool-architecture.md` behauptet das Routing-Diagramm `RingBuffer(64KB)` für Background/Yield, während die Output-Cap-Tabelle weiter unten `200 KB` angibt.
- **Doku-only:**
  - `docs/architecture/exec-tool-architecture.md` listet im `Session`-Typ ein Feld `resolvePromise?: (value: ExecToolResult) => void`. Dieses Feld wird **nie** von `exec.ts`, `execBackground.ts` oder `execPty.ts` gesetzt (`processSupervisor.ts` Zeile 52 prüft es, aber es ist immer `undefined`). Dead Code, der in der Architektur-Doku als Feature erscheint.

---

### Tool: process

**Code-Datei:** `src/tools/process.ts`  
**Doku-Datei(en):** `docs/tools/process.md`  
**Registrierung:** `src/tools/registry.ts`

#### Audit-Tabelle

| Aspekt | Im Code | In der Doku | Status |
|--------|---------|-------------|--------|
| Tool-Name (string-id) | `process` | `process` | ✅ |
| Input-Schema (Args + Typen) | `action: "list" \| "poll" \| "kill" \| "log" \| "wait"`, `sessionId?: string (pattern ^bg_[a-f0-9]{8}$)`, `signal?: "SIGTERM" \| "SIGKILL" \| "SIGINT"`, `offset?: integer (min 0)`, `limit?: integer (1–64.000)`, `timeout?: integer (0–120.000)` | Identisch | ✅ |
| Pflicht- vs. Optional-Args | `action` req, `sessionId` req für alle außer `list`, Rest opt | Identisch | ✅ |
| Return-Format | `list`: running/finished-Block; `poll`: Status + recent 4 KB; `kill`: Signal + Exit; `log`: offset/limit/truncated + stdout/stderr; `wait`: finished- oder running-Block | Identisch | ✅ |
| Validierungen | `Value.Check` (TypeBox), `sessionId`-Pattern, Session-Existenz-Check | Identisch | ✅ |
| Side-Effects | Prozess-Signale (`kill`), RingBuffer-Lesepositionen (`poll`/`log`/`wait`), Session-Map-Lookup | Identisch | ✅ |
| Error-Cases | `Invalid arguments`, `sessionId required for …`, `Session … not found or expired.` | Identisch | ✅ |
| Beispiel-Aufrufe | — | Beispiele in `docs/tools/index.md` und `docs/tools/process.md` | ✅ |
| Bekannte Limits | Kein `action: "write"`, kein `filter` bei list, kein `follow` bei log | Identisch | ✅ |

#### Befunde

- **Undokumentiert:** Keine.
- **Drift:** Keine signifikanten Drifts im Tool-Verhalten. Die Architektur-Doku `exec-tool-architecture.md` beschreibt `processSupervisor` korrekt.
- **Doku-only:** Keine.

---

### Tool: write

**Code-Datei:** `src/tools/write_file.ts`  
**Doku-Datei(en):** `docs/tools/write.md`  
**Registrierung:** `src/tools/registry.ts`

#### Audit-Tabelle

| Aspekt | Im Code | In der Doku | Status |
|--------|---------|-------------|--------|
| Tool-Name (string-id) | `write` | `write` | ✅ |
| Input-Schema (Args + Typen) | `path: string`, `content: string` | Identisch | ✅ |
| Pflicht- vs. Optional-Args | Beide req | Identisch | ✅ |
| Return-Format | `ok` | Identisch | ✅ |
| Validierungen | Tilde-Expansion, `WRITE_NO_FLY_PATTERNS` (sensitive paths) | Identisch | ✅ |
| Side-Effects | Atomares Filesystem-Write (`tmp + rename`), `markRead()` | Identisch | ✅ |
| Error-Cases | `SENSITIVE_PATH: …`, `WRITE_FAILED: …` | Identisch | ✅ |
| Beispiel-Aufrufe | — | Keine direkten Beispiele | ⚪ |
| Bekannte Limits | Kein Mode-Flag, keine Backups, kein Cross-Agent-Locking, keine Staleness-Checks, kein Diff-Return | Identisch | ✅ |

#### Befunde

- **Undokumentiert:** Keine.
- **Drift:**
  - `docs/tools/write.md` (Abschnitt Tilde-Expansion) schreibt wörtlich: "Danach `path.resolve(cwd(), expanded)`". Der Code (`write_file.ts` Zeile 38) ruft jedoch `resolve(expanded)` auf (ohne explizites `cwd()`-Argument — `resolve()` verwendet implizit `cwd()`, aber die Beschreibung ist wörtlich genommen nicht exakt).
- **Doku-only:** Keine.

---

### Tool: edit

**Code-Datei:** `src/tools/edit_file.ts`  
**Doku-Datei(en):** `docs/tools/edit.md`  
**Registrierung:** `src/tools/registry.ts`

#### Audit-Tabelle

| Aspekt | Im Code | In der Doku | Status |
|--------|---------|-------------|--------|
| Tool-Name (string-id) | `edit` | `edit` | ✅ |
| Input-Schema (Args + Typen) | `path: string`, `edits: Array<{ oldText: string, newText: string, replaceAll?: boolean }>` | Identisch | ✅ |
| Pflicht- vs. Optional-Args | `path` + `edits` req, `replaceAll` opt | Identisch | ✅ |
| Return-Format | `ok: <anzahl>` | Identisch | ✅ |
| Validierungen | Sensitive-Path-Guard (`WRITE_NO_FLY_PATTERNS`), `wasRead()`-Check, `edits.length > 0`, `oldText === newText`→NOOP, `matchCount !== 1` (ohne replaceAll)→NOT_UNIQUE | Identisch | ✅ |
| Side-Effects | Filesystem-Read + atomares Write, `markRead()` | Identisch | ✅ |
| Error-Cases | `SENSITIVE_PATH`, `READ_REQUIRED`, `EMPTY_EDITS`, `NOOP_EDIT`, `NOT_UNIQUE`, `WRITE_FAILED`, `READ_FAILED` | Identisch | ✅ |
| Beispiel-Aufrufe | — | Keine direkten Beispiele | ⚪ |
| Bekannte Limits | Kein V4A-Patch, kein Diff-Return, keine Merge-Logik, kein Locking, keine mtime-Checks | Identisch | ✅ |

#### Befunde

- **Undokumentiert:** Keine.
- **Drift:**
  - `docs/tools/edit.md` (Abschnitt Tilde-Expansion) schreibt wörtlich: "Danach `path.resolve(cwd(), expanded)`". Der Code (`edit_file.ts` Zeile 28) ruft `resolve(expanded)` auf — analog zu `write` (siehe oben).
- **Doku-only:** Keine.

---

### Zusätzlicher Befund: `write_edit_registry.md`

**Doku-Datei:** `docs/tools/write_edit_registry.md`

Diese Datei ist **massiv veraltet** und referenziert Code-Zustände, die nicht mehr existieren:

| Problem | Doku | Code (aktuell) |
|---------|------|----------------|
| Registry-Inhalt | `[echoTool, readFileTool, bashTool, writeTool, editTool]` | `[readFileTool, execTool, processTool, writeTool, editTool]` |
| Tool-Name | `bashTool` | `execTool` (umbenannt) |
| Datei-Referenz | `bash.ts` | existiert nicht (ist `exec.ts`) |
| Fehlendes Tool | `processTool` fehlt in der Registry-Darstellung | ist vorhanden |
| Gelöschtes Tool | `echoTool` ist enthalten | wurde entfernt |
| Error-Shape-Vergleich | "…wie `bash.ts` intern" | `bash.ts` existiert nicht |

**Empfohlene Aktion:** Diese Datei überarbeiten oder löschen (Inhalt ist größtenteils in `write.md`, `edit.md`, `file_state.md` abgedeckt).

---

## 3 · Loop- / Architektur-Audit

### ADR-001 Compliance

> Hinweis: Das Dokument "ADR-001" existiert **nicht** im Repository. `AGENTS.md` verweist auf den Harness Tracker (Notion). `docs/README.md` nennt `architecture/adr-001-pi-ai-only.md` als Beispiel-Datei, die ebenfalls nicht existiert. Die folgende Prüfung basiert auf den in der Aufgabenstellung genannten Schritten.

| # | ADR-001-Schritt | Im Code? | Doku? | Notiz |
|---|-----------------|----------|-------|-------|
| 1 | Basis-Loop mit `complete()` | ✅ `src/core/agent.ts` Zeile 80 | ⚪ `docs/agent/loop.md` beschreibt den Flow korrekt, aber sehr knapp | Vollständig implementiert. |
| 2 | Streaming mit `stream()` | ❌ Nirgends verwendet | ❌ Nicht erwähnt | Nur `complete()` wird genutzt. |
| 3 | Max Turns / Abort | 🟡 `maxIterations` (default 10) in `agent.ts` Zeile 68 | ⚪ In `docs/agent/loop.md` nicht erwähnt | Max Turns: ja. Abort-Mechanismus (externes Signal / CancellationToken): nein. |
| 4 | Parallel Tool Execution | ❌ `for…of` über `toolCalls` (sequenziell) in `agent.ts` Zeile 96 | ❌ Nicht erwähnt | Pi-ai liefert potenziell mehrere `toolCall`s pro Turn; diese werden nacheinander abgearbeitet. |
| 5 | Context Pruning / Compaction | ❌ `trimContext()` in `context.ts` existiert, wird aber **nicht** aufgerufen | ❌ Nicht erwähnt | Der Agent baut den `Context` inline pro `run()` und hängt Nachrichten an. Keine Token-Begrenzung, kein Sliding Window. |
| 6 | Agent Router | ❌ Nicht implementiert | ❌ Nicht erwähnt | Single-Agent-Architektur. |
| 7 | Memory Persistence | ❌ `session.ts` existiert als Skeleton, wird aber **nicht** verwendet | ❌ Nicht erwähnt | Keine Session-Speicherung zwischen Turns. |

### Weitere Architektur-Befunde

- **Orphaned Modules:** `src/core/context.ts` und `src/core/session.ts` sind definiert, exportiert, getestet (`tests/context.test.ts`), aber **kein Produktiv-Code importiert sie**. Der Agent-Loop in `agent.ts` baut pi-ai `Context` inline und hält keinen Session-State.
- **LLM-Adapter:** Kein eigener Adapter — `@mariozechner/pi-ai` wird direkt in `agent.ts` importiert (`complete`, `getModel`).
- **Tool-Executor:** Inline in `agent.ts` (Zeilen 96–124). Kein separates Executor-Modul.
- **Context Builder:** Inline in `agent.ts` (Zeilen 73–77). `createUserMessage`, `toPiTool`, `createToolResultMessage` sind lokale Helper in `agent.ts`.

---

## 4 · Gap-Liste (priorisiert)

| Prio | Tool/Modul | Fehlend / Drift | Empfohlene Aktion |
|------|------------|-----------------|-------------------|
| 🔴 Critical | `readFile` | **Drift:** `markRead()` wird für PDF-Reads **nicht** aufgerufen (trotz Doku in `readFile_extension.md`). Konsequenz: `edit` nach `readFile` einer PDF schlägt mit `READ_REQUIRED` fehl. | **Code fixen:** `markRead(resolvedPath)` im PDF-Erfolgspfad einfügen. |
| 🔴 Critical | `exec` | **Drift:** Background-RingBuffer-Größe ist 64 KB, Doku verspricht 200 KB (`exec.md`, `exec-tool-architecture.md`). | **Entscheiden:** Entweder Doku auf 64 KB korrigieren oder Code auf 200 KB anheben. |
| 🔴 Critical | `docs/tools/write_edit_registry.md` | **Doku-only/Drift:** Referenziert gelöschtes `echoTool`, umbenanntes `bashTool`, fehlendes `processTool`. | **Doku überarbeiten oder löschen.** |
| 🟡 Important | `agent.ts` (Loop) | **Fehlend:** Context wächst unbegrenzt innerhalb eines `run()`-Aufrufs. Kein Pruning, keine Token-Begrenzung. | **Architektur-Entscheidung:** `trimContext` aus `context.ts` integrieren oder entfernen. |
| 🟡 Important | `context.ts`, `session.ts` | **Fehlend:** Module sind "orphaned" — definiert, getestet, aber nicht vom Agent-Loop genutzt. | **Architektur-Entscheidung:** Entweder in den Loop integrieren oder als bewusstes "Future"-Skeleton markieren/löschen. |
| 🟡 Important | `readFile.md` | **Doku-only:** "Nicht enthalten (MVP): `writeFile` / `editFile`" — beide sind inzwischen implementiert. | **Doku korrigieren:** MVP-Notizen aktualisieren. |
| 🟡 Important | `write.md`, `edit.md` | **Drift:** Path-Resolution wird als `path.resolve(cwd(), expanded)` beschrieben, Code macht `resolve(expanded)`. | **Doku korrigieren:** Formulierung anpassen (oder Code explizit machen). |
| 🟡 Important | `exec.md` | **Drift:** PTY-Timeout-Format (`--- output ---`) wird nicht vom Timeout-Beispiel abgedeckt (zeigt nur Sync-Format `--- stdout ---`). | **Doku ergänzen:** PTY-Timeout-Format separat dokumentieren. |
| 🟡 Important | `docs/README.md` | **Fehlend:** Beispiel-ADR-Datei `architecture/adr-001-pi-ai-only.md` wird genannt, existiert aber nicht. | **Doku klären:** Entweder Datei anlegen oder Beispiel entfernen. |
| 🟢 Nice | `exec.md` | **Fehlend:** `yieldMs = 0` Verhalten (Sync-Fallback) nicht dokumentiert. | **Doku ergänzen:** Edge-Case erwähnen. |
| 🟢 Nice | `processSupervisor.ts` | **Code:** `resolvePromise`-Feld im `Session`-Typ ist Dead Code (nie gesetzt, nie aufgerufen außer Guard-Check). | **Code bereinigen:** Feld und Logik entfernen, oder verwenden. |
| 🟢 Nice | `write.md`, `edit.md` | **Fehlend:** Keine direkten Beispiel-Aufrufe (im Gegensatz zu `exec.md` / `process.md`). | **Doku ergänzen:** 1–2 Beispiele je Tool. |
| 🟢 Nice | `agent.ts` (Loop) | **Fehlend:** Keine Streaming-Unterstützung (`stream()` statt `complete()`). | **ADR-Review:** Ist Streaming in Phase 1 geplant? Falls nein, Dokumentation des bewussten Verzichts. |
| 🟢 Nice | `agent.ts` (Loop) | **Fehlend:** Kein Abort / Cancellation-Token. | **Code ergänzen:** Optionaler `AbortSignal`-Support. |

---

## 5 · echo-Removal

**Status:** ✅ Entfernt

### Betroffene Files

| Aktion | File |
|--------|------|
| Gelöscht | `src/tools/echo.ts` (bereits in Working Tree gelöscht) |
| Gelöscht | `tests/echo.test.ts` |
| Geändert | `src/tools/registry.ts` — `echoTool` entfernt aus `loadTools()` |
| Geändert | `src/tools/index.ts` — `echoTool` Export entfernt |
| Geändert | `tests/agent.test.ts` — `echoTool`-Import entfernt, stattdessen Inline-Mock-Tool für Tests |

### Verifikation

| Check | Befehl | Ergebnis |
|-------|--------|----------|
| Typecheck | `npm run typecheck` | ✅ Grün (0 Fehler) |
| Tests | `npm test -- --run` | ✅ Grün (117 Tests, 10 Dateien) |
| Build | `npm run build` | ✅ Grün |
| Grep (src) | `rg -i "echoTool\|echo\.ts" src/` | ✅ Keine Treffer |
| Grep (tests) | `rg -i "echoTool\|echo\.ts" tests/` | ✅ Keine Treffer (verbleibende `"echo"`-Vorkommen in `agent.test.ts` sind Inline-Mock-Tool-Variablennamen, keine echte Tool-Referenz) |

---

## Open Questions

1. **RingBuffer-Größe:** Soll die Background-Output-Cap auf 200 KB angehoben werden (wie dokumentiert) oder soll die Doku auf 64 KB korrigiert werden? Dies beeinflusst, wie viel Output von langlaufenden Background-Prozessen erhalten bleibt.

2. **Orphaned Modules (`context.ts`, `session.ts`):** Sind diese bewusste "Future Skeletons" für Phase 2/3, oder sollen sie entfernt / in den Loop integriert werden? Derzeit verursachen sie keinen Schaden, aber sie suggerieren eine Architektur, die nicht existiert.

3. **ADR-001 Lokation:** Soll eine Kopie der ADR-001 ("Agent Loop selbst bauen, nur pi-ai als Dependency") in das Repo (`docs/architecture/adr-001-pi-ai-only.md`) migriert werden, oder bleibt Notion die Single Source of Truth? `docs/README.md` suggeriert ersteres.

4. **`docs/tools/write_edit_registry.md`:** Soll diese Datei überarbeitet oder gelöscht werden? Ihr Inhalt ist fast vollständig in den Einzeldokumentationen `write.md`, `edit.md`, `file_state.md` abgedeckt.

5. **PDF `markRead`:** War das Fehlen von `markRead()` im PDF-Pfad ein Versehen (Omission) oder bewusst? `readFile_extension.md` dokumentiert es als vorhanden.


---

## Resolution (Fix-Run A, 2026-05-16)

Dieser Abschnitt dokumentiert den Bearbeitungs-Status der Gap-Liste aus Fix-Run A.

| Prio | Befund | Status | Anmerkung |
|------|--------|--------|-----------|
| 🔴 Critical | `readFile` PDF `markRead()` fehlte | ✅ Resolved | `markRead(resolvedPath)` im PDF-Erfolgspfad ergänzt; Test hinzugefügt. |
| 🔴 Critical | RingBuffer-Größe 64 KB statt 200 KB | ✅ Resolved | `BG_OUTPUT_CAP = 200 * 1024` eingeführt; Background, PTY und Yield-Sessions nutzen 200 KB. Sync bleibt bei 64 KB. |
| 🔴 Critical | `write_edit_registry.md` veraltet | ✅ Resolved | Datei gelöscht; Inhalt durch `index.md` → "Tool-Registry" ersetzt. |
| 🟡 Important | Context/Session unbounded growth | ⏳ Doc only | Kein Code-Change in Fix-Run A; Doku reflektiert aktuellen Zustand (kein Pruning). |
| 🟡 Important | Orphaned `context.ts` + `session.ts` | ✅ Resolved | Beide Dateien + Tests gelöscht. Keine verwaisten Imports. |
| 🟡 Important | `readFile.md` MVP-Notiz (writeFile/editFile) | ✅ Resolved | Veraltete Zeile entfernt. |
| 🟡 Important | `write.md`/`edit.md` Path-Resolution-Wording | ✅ Resolved | Formulierung korrigiert: `path.resolve(expanded)` mit Hinweis auf implizites cwd. |
| 🟡 Important | `exec.md` PTY-Timeout-Format | ✅ Resolved | Separater PTY-Timeout-Block mit `--- output ---` hinzugefügt. |
| 🟡 Important | Beispiel-ADR-Datei fehlt | ❌ Out of scope | ADR-Repo-Spiegel separat geplant (OQ-3). |
| 🟢 Nice | `yieldMs = 0` Edge-Case | ✅ Resolved | Schema-Minimum auf 1 angehoben; Sync-Fallback entfällt. Test angepasst. |
| 🟢 Nice | `resolvePromise` Dead Code | ✅ Resolved | Feld aus `Session`-Typ und `register()` entfernt. |
| 🟢 Nice | Keine Beispiele in `write.md`/`edit.md` | ✅ Resolved | Kurze TypeScript-Beispiele für beide Tools ergänzt. |
| 🟢 Nice | Streaming (`stream()` statt `complete()`) | ❌ Out of scope | Keine Phase-1-Planung. |
| 🟢 Nice | Abort / Cancellation-Token | ❌ Out of scope | Keine Phase-1-Planung. |

### Zusammenfassung Fix-Run A

- **Code-Dateien geändert:** 8 (`exec.ts`, `execBackground.ts`, `execPty.ts`, `processSupervisor.ts`, `readFile.ts`, `edit_file.ts`, `limits.ts` neu, `registry.ts` / `index.ts` bereinigt)
- **Code-Dateien gelöscht:** 4 (`context.ts`, `session.ts`, `echo.ts`, `tests/context.test.ts`)
- **Tests geändert/ergänzt:** 6 (`readFile.test.ts`, `edit_file.test.ts`, `execPty.test.ts`, `process.test.ts`, `exec.test.ts`, `agent.test.ts`)
- **Alle 118 Tests grün**, `typecheck` grün, `build` grün.
