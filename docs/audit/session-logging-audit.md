# Audit: Session-Logging als Substrat für die Distillation-Pipeline

**Datum:** 2026-07-17
**Scope:** Nur Lesezugriff, keine Code-Änderungen. Alle Aussagen mit Datei:Zeile belegt.
**Fragestellung:** Sessions sollen Substrat für eine nächtliche Distillation-Pipeline werden (Consumer liest abgeschlossene Sessions strukturiert). Was ist der Ist-Stand?

**Aufwandsskala:** XS < 1 h · S ≈ halber Tag · M ≈ 1–2 Tage · L > 2 Tage.

---

## TL;DR

- Transkripte liegen als JSONL unter `$HARNESS_STATE/sessions/YYYY-MM-DD/<sessionId>.jsonl`, ein `SessionTurn` pro Zeile, Append pro abgeschlossenem Turn (kein Batching).
- **Kernbefund:** Das Schema hat Felder für `tool_calls`/`tool_results`, aber **kein Producer befüllt sie**. Im Daemon-Pfad (dem Standard für TUI-via-Daemon und Gateways) wird nicht mal der `messages`-Slice persistiert — nur finaler Assistant-Text + User-Text + Tokens.
- Es gibt drei Status (`active`/`idle`/`ended`), aber `ended` ist semantisch überladen (Shutdown, Idle-Timeout und explizites `/end` landen alle dort) und wird nirgends enforced — Resume auf eine beendete Session ist problemlos möglich.
- Interne Read-Funktionen (`readSession`, `listSessions`) existieren und werden bereits benutzt, sind aber nicht als Library paketiert (`@harness/agent` hat kein `exports`-Feld). IPC bietet keinen Endpunkt, der Turn-Inhalte liefert.

---

## 1. Persistenz

### 1.1 Ablageorte und Formate

| Was | Wo | Beleg |
|---|---|---|
| Session-Transkripte | `$HARNESS_STATE/sessions/YYYY-MM-DD/<sessionId>.jsonl` | `packages/agent/src/core/session.ts:160-166` (Pfadaufbau), `packages/core/src/config/paths.ts:68` (`sessions` = `$state/sessions`), `paths.ts:52-56` (`$HARNESS_STATE`, Default `~/.harness`) |
| Session-Index | `$HARNESS_STATE/sessions/sessions.json` | `session.ts:213-215` |
| Legacy-Layout (Fallback) | `$HARNESS_STATE/sessions/<sessionId>.jsonl` (flach) | `session.ts:168-173`, Auflösung mit Folder-Scan in `session.ts:189-211`, Migration in `session.ts:667-701` |
| Compaction-Alt-Context | `$HARNESS_STATE/compaction/<sessionId>.md` (Markdown) | `packages/core/src/core/compaction.ts:224-235` |
| Metriken (sekundär) | `$HARNESS_STATE/metrics/{tools,turns,system}-YYYY-MM-DD.jsonl` | `packages/core/src/core/metrics.ts:97-123` |

Der Datumsordner leitet sich aus der **Session-ID** ab (Erstellungsdatum), nicht aus Turn-Zeitpunkten: `sessionDateFromId` in `session.ts:152-158`, ID-Format `YYYYMMDDTHHMMSS-<uuid6>` in `session.ts:223-227`. Eine Session, die über Mitternacht läuft, bleibt komplett im Start-Datumsordner — ein Nightly-Pass darf **nicht** über Ordnerdaten filtern.

### 1.2 Turn-Format

Pro Zeile ein `SessionTurn` (`session.ts:65-92`):

- `id`, `role: "assistant"`, `content` (nur der **finale** Assistant-Text), `userContent` (die auslösende User-Message)
- `tool_calls?: { id, name, arguments }[]` (`session.ts:73-74`), `tool_results?: { toolCallId, name, result, isError }[]` (`session.ts:75-76`) — **optional, siehe 1.3**
- `tokens`, optional `cost`, `timing` (startedAt/latencyMs), `model`, `timestamp`
- `messages?: Message[]` — voller pi-ai-Message-Slice des Turns (user + assistant + toolResult), laut Kommentar für exaktes Resume (`session.ts:87-91`)

Index-Eintrag (`SessionIndexEntry`, `session.ts:106-115`): `sessionId`, `created`, `lastActivity`, `model`, `tokenTotals`, `parentSessionId?`, `title`, `status`.

### 1.3 Sind Tool-Calls UND Tool-Results vollständig enthalten?

**Nein — in keinem der drei Producer-Pfade vollständig.** Die Schema-Felder existieren, aber:

| Producer | `tool_calls` | `tool_results` | `messages`-Slice | Beleg |
|---|---|---|---|---|
| Daemon, new-style (`text`) | fehlt | fehlt | **fehlt** | `packages/agent/src/daemon/runtime.ts:662-684`, insb. `messages: req.messages ? messages : undefined` in Zeile 683 |
| Daemon, old-style (`messages`) | fehlt | fehlt | vorhanden | `runtime.ts:683` |
| InProcessBackend (TUI lokal) | `[]` (hartkodiert) | `[]` (hartkodiert) | vorhanden | `packages/agent/src/backends/inProcessBackend.ts:244-245` bzw. `:269` (`messages.slice(messagesBeforeTurn)`) |

- Der aktuelle Daemon-Client sendet ausschließlich `text` (`packages/agent/src/backends/daemonClientBackend.ts:135`: `{ type: "submit-turn", text, sessionId }`). Damit persistiert der Daemon-Pfad in der Praxis **keinerlei Tool-Daten und keinen Message-Slice** — nur `content` (finaler Text), `userContent`, Tokens, Timing, Modell.
- Zwischen-Assistant-Texte (Text vor/zwischen Tool-Calls) gehen im Daemon-Pfad ebenfalls verloren; `content` ist nur `result.finalMessage` (`runtime.ts:659-665`).
- Die Daten wären verfügbar: Die Agent-Loop appended Assistant-Messages (inkl. `toolCall`-Blöcke) und `ToolResultMessage`s in das vom Aufrufer übergebene Array (`packages/core/src/core/agent.ts:485` bzw. `agent.ts:612-615`; `context.messages` ist das Caller-Array, `agent.ts:340-344`) und emittiert `tool_call_start`/`tool_call_done`/`tool_call_error` mit Args bzw. Result (`agent.ts:541-545`, `agent.ts:581-583`). Der InProcessBackend nutzt das (`messages.slice`), der Daemon nicht.
- Folge für Resume: Daemon-Sessions ohne `messages`-Slice fallen beim Resume auf synthetische user/assistant-Messages zurück (`turnsToMessages`-Fallback, `session.ts:571-584`) — Tool-Kontext ist nach einem Daemon-Neustart verloren.
- Die TUI-Wiedergabe alter Sessions liest genau diese leeren Felder (`turnToCompletedTurn`, `packages/agent/src/cli/App.tsx:168-180`) — resumed Sessions zeigen keine Tool-Aktivität.

**Sekundärspur Metriken:** `tools-*.jsonl` enthält pro Tool-Call `tool`, `latencyMs`, `status`, ggf. `error` — **keine Args, keine Results** (`metrics.ts:24-32`; geschrieben aus `agent.ts:551-573`). Der `TurnMetric`-Recorder (`turns-*.jsonl`, `metrics.ts:9-22`) wird in Produktion **nirgends** aufgerufen — nur in Tests (Grep über `packages/`: `.recordTurn(` nur in `packages/agent/tests/` und `packages/core/tests/`). Für die Pipeline ist die Metrik-Spur kein Ersatz.

**Compaction-Ausreißer:** Kompaktierte Vorgeschichte liegt als Markdown in `$HARNESS_STATE/compaction/<sessionId>.md` (`compaction.ts:224-235`). Pro Session genau eine Datei, die bei jeder Compaction **überschrieben** wird (`writeFileSync`, `compaction.ts:233`) — frühere Alt-Contexts gehen verloren. Für die Distillation heißt das: Was im Transkript durch Compaction aus dem Live-Kontext fiel, ist nur als Markdown (nicht strukturiert) und nur in der letzten Version greifbar. (Randnotiz: sync IO via `mkdirSync`/`writeFileSync` verletzt die Projekt-Konvention "File-IO async", AGENTS.md.)

### 1.4 Schreibzeitpunkt und Crash-Safety

**Pro Turn sofort, kein Batching** — aber erst **nach** Turn-Abschluss:

1. `recordTurn` appended zuerst die Turn-Zeile ans Transkript ("source of truth", Kommentar `session.ts:415`; Append in `session.ts:416-417`), dann
2. Index-Update (`session.ts:438`, intern serialisiert via `indexUpdateQueue`, `session.ts:260-310`).

- **Prozess-Crash:** Append ist abgeschlossen, bevor `recordTurn` zurückkehrt → geschriebene Turns überleben einen Prozess-Crash. Ein Crash **mitten im Turn** (Tool läuft, LLM streamed) hinterlässt **nichts** — der gesamte Turn inkl. bisheriger Tool-Calls fehlt. Es gibt keine Intra-Turn-Persistenz.
- **Maschinen-Crash:** Kein `fsync` nach dem Append (`session.ts:416-417`) — Daten sitzen ggf. nur im OS-Page-Cache. Für eine Nightly-Pipeline vermutlich akzeptabel, aber bewusst entscheiden.
- **Crash zwischen Append und Index-Update:** Transkript hat den Turn, Index-Totals/`lastActivity` sind stale. Der Index ist aus den Transkripten rebuildbar — ein solcher Rebuild existiert aber nicht (`harness reindex` betrifft nur den Memory-Index, `packages/agent/src/cli/migrateHome.ts:171`).
- **Index-Schreiben ist atomar:** Tmp-Datei (eindeutig via PID + UUID) + `rename` (`session.ts:281-291`). Keine Torn Writes.
- **Index-Korruption = Datenunsichtbarkeit:** `loadIndex` behandelt korruptes JSON als leeren Index (`session.ts:272-278`). Da `readSession` zuerst den Index-Eintrag verlangt (`session.ts:449-451`), werden **alle** Sessions unsichtbar, obwohl die Transkripte existieren — der Folder-Scan in `findTranscriptPath` (`session.ts:189-211`) wird in dem Fall gar nicht erreicht.
- **Partielle letzte Zeile** (z. B. Crash mitten im Append): `readSession` skippt nicht-parsebare Zeilen still (`session.ts:466-474`). Lesen ist damit gegen eine halbe Zeile tolerant.

---

## 2. Boundaries

### 2.1 Beginn und Ende

- **Beginn:** `createSession` (`session.ts:327-364`) — vergibt ID, legt eine **leere** Transkript-Datei an (`session.ts:359-360`), schreibt Index-Eintrag mit `status: "active"` (`session.ts:356`). Sessions entstehen explizit (`create-session`-IPC, `runtime.ts:383-404`) oder implizit beim ersten `submit-turn` ohne `sessionId` (`runtime.ts:544-553`).
- **Ende:** `endSession` (`session.ts:378-385`) setzt `status: "ended"` — **nur im Index**. Es gibt keinen End-Marker im Transkript selbst und keinen `endedAt`-Zeitstempel; die letzte JSONL-Zeile ist einfach der letzte Turn.

### 2.2 Gibt es einen "abgeschlossen"-Zustand?

Formal ja (`"ended"`, `session.ts:103`/`session.ts:114`), semantisch ist er aber **überladen und nicht enforced**:

`ended` entsteht durch mindestens fünf verschiedene Wege:

- explizites `/end` (`runtime.ts:984-1001`) und `end-session`-IPC (`runtime.ts:723-749`)
- `/new` (beendet die alte Session, `runtime.ts:954-981`) und `/resume <id>` (beendet die bisherige, `runtime.ts:1063-1068`)
- TUI-Idle-Timeout (`App.tsx:1020-1046`) und TUI-Unmount (`App.tsx:1049-1058`)
- **Daemon-Shutdown beendet pauschal alle In-Memory-Sessions** (`runtime.ts:248-260`) — ein `daemon restart` macht aus jeder laufenden Unterhaltung eine "beendete" Session.

Daneben: **Crash** → Sessions bleiben `active` im Index und werden erst beim nächsten Daemon-Start zu `idle` (`markActiveSessionsIdle`, `session.ts:387-406`, aufgerufen in `runtime.ts:165-170`). Ein TUI-Crash ohne laufenden Daemon → `active` bleibt **unbegrenzt** stehen (die Bereinigung läuft nur im Daemon).

**`ended` wird nirgends durchgesetzt:** `resume-session` prüft den Status nicht (`runtime.ts:454-490`), `loadSession` filtert nicht (`session.ts:629-658`) — eine "beendete" Session kann jederzeit resumed werden und hängt dann weitere Turns an dasselbe Transkript. Für den Nightly-Pass heißt das: `status == "ended"` ist weder ein Garant für "wird nicht mehr verändert" noch ein sauberes "Konversation abgeschlossen"-Signal.

### 2.3 Parallele Langläufer

- **Intra-Daemon:** Pro Session serialisiert eine Turn-Queue die Turns (`SessionEntry.turnQueue`, `runtime.ts:116-119`; Chaining in `runtime.ts:574-710`). Verschiedene Sessions laufen parallel und blockieren sich nicht (Kommentar `runtime.ts:578-582`). Index-Updates aus parallelen Turns sind prozess-intern über `indexUpdateQueue` serialisiert (`session.ts:260-310`).
- **Prozessübergreifend (Daemon + TUI in-process, oder zwei Prozesse auf demselben `$HARNESS_STATE`):** Kein Lock. `loadIndex → modify → saveIndex` ist prozessübergreifend racy — Lost Updates im Index möglich (nur die Write-Ebene ist via Tmp+Rename geschützt, `session.ts:285-291`; der Kommentar `session.ts:260-263` benennt das Problem, löst es aber nur prozessintern). Zwei Prozesse können zudem an **dieselbe** Transkript-Datei appenden (Resume in zwei Prozessen) — Zeilen-Appends bleiben intakt, aber Index-Einträge verlieren Updates.
- **Langläufer über Datumsgrenzen:** Turn-Zeitstempel stehen pro Zeile im Transkript (`timestamp`, `timing.startedAt`), aber der Ordner trägt das Erstellungsdatum (s. 1.1). `listSessions(range)` filtert zudem auf `created`, **nicht** auf `lastActivity` (`session.ts:506-510`) — "alle gestern aktiven Sessions" ist mit der heutigen Range-API nicht abbildbar (eine vorgestern erstellte, gestern aktive Session fällt durch den Filter).

---

## 3. Read-Zugriff

### 3.1 IPC (Unix-Socket, newline-delimited JSON, `ipc.ts:26-74`)

| Request | Response | Turn-Inhalte? | Beleg |
|---|---|---|---|
| `list-sessions` | `sessions-listed` mit `SessionSummary[]` (Metadaten + `turnsCompleted`-Zähler) | **Nein** — kein Range-Parameter, keine Inhalte | `types.ts:54`, `types.ts:72`, `types.ts:112-122`; Handler `runtime.ts:406-452` |
| `resume-session` | `session-resumed` mit `messageCount` | **Nein** — lädt in den Daemon-Speicher, liefert nur eine Zahl | `types.ts:56`, `types.ts:73`; Handler `runtime.ts:454-490` |
| `submit-turn`, `end-session`, `status`, ... | — | Nein | `types.ts:50-59` |

**Es gibt keinen IPC-Endpunkt, der persistierte Turn-Inhalte ausliefert.** Wer über IPC lesen will, bekommt nur Metadaten.

### 3.2 Interne Funktionen (alle exportiert, `packages/agent/src/core/session.ts`)

- `readSession(sessionId, paths)` → `{ session: SessionIndexEntry, turns: SessionTurn[] } | null` (`session.ts:445-477`)
- `listSessions(paths, range?)` → `SessionIndexEntry[]`, Range auf `created` (`session.ts:499-511`)
- `listSessionsWithDetails` (Turn-Count + Token-Schätzung, `session.ts:518-534`), `countTurnsInTranscript` (`session.ts:483-497`)
- `loadSession` (Resume-orientiert, inkl. `turnsToMessages`-Rekonstruktion, `session.ts:629-658`), `turnsToMessages` (`session.ts:557-586`)

### 3.3 Kann ein Consumer heute schon ohne IPC strukturiert lesen?

**Im selben Monorepo-Prozess: ja.** Der DaemonClientBackend macht genau das für die TUI-Anzeige — er liest via `loadSession` direkt von Disk, parallel zum Daemon (`daemonClientBackend.ts:8`, `daemonClientBackend.ts:69-85`). Die JSONL-Struktur ist stabil und append-only-tolerant lesbar (s. 1.4).

**Als externe Library: nein.**

- `@harness/agent` hat **kein `main`/`exports`-Feld** — nur `bin` (`packages/agent/package.json:6-8`). `readSession`/`listSessions` sind zwar `export`, aber paketseitig nicht konsumierbar; ein externer Consumer müsste Deep-Imports in `dist/core/session.js` machen.
- `@harness/core` hat saubere Exports (`packages/core/package.json:7-12`), aber `session.ts` liegt nicht dort — und hängt nur an `HarnessPaths` aus `@harness/core` (`session.ts:14`), eine Verschiebung wäre mechanisch.
- Format-Hürde: Das `messages`-Feld enthält pi-ai-`Message[]` (`session.ts:91`) — ein Consumer, der das Feld auswerten will, braucht pi-ai-Typen oder JSON-Toleranz. Die übrigen Felder sind plain JSON.

---

## 4. Lücken und Aufwand

### a) `read_session(id)` + `list_sessions(range)` als Library-API

| Lücke | Detail | Aufwand |
|---|---|---|
| Paket-Export fehlt | Funktionen existieren (`session.ts:445-511`), aber `@harness/agent` ist nicht importierbar (kein `exports`). Entweder `session.ts` nach `@harness/core` verschieben (Dependency `HarnessPaths` ist bereits dort, `session.ts:14`) oder `@harness/agent` ein `exports`-Feld + lib-Entry geben. | XS–S |
| Range filtert falsches Feld | `listSessions` filtert `created` (`session.ts:506-510`); die Pipeline braucht `lastActivity` ("gestern aktive Sessions"). Filter-Option ergänzen. | XS |
| Index-Abhängigkeit | `readSession` verlangt einen Index-Eintrag (`session.ts:449-451`) und gibt bei korruptem Index `null` zurück, obwohl Transkripte existieren (`session.ts:272-278`). Fallback: Transkript-Scan (`findTranscriptPath` existiert, `session.ts:189-211`) auch ohne Index-Eintrag; optional Index-Rebuild aus Transkripten. | S |
| Status-Sichtbarkeit | Range/Filter auf `status` fehlt (Pipeline will nur `ended`/`idle`). | XS |

**Summe a: S.**

### b) Vollständige Tool-Call/Result-Erfassung

| Lücke | Detail | Aufwand |
|---|---|---|
| Daemon persistiert keinen Slice | `messages` nur bei old-style Requests (`runtime.ts:683`); der aktuelle Client sendet `text` (`daemonClientBackend.ts:135`). Fix: Slice analog InProcessBackend persistieren (`messagesBeforeTurn`-Muster, `inProcessBackend.ts:184`, `:269`). | XS |
| Strukturfelder nie befüllt | `tool_calls`/`tool_results` fehlen (Daemon) bzw. hartkodiert leer (`inProcessBackend.ts:244-245`). Aus dem Message-Slice ableitbar (Assistant-`toolCall`-Blöcke + `toolResult`-Messages, `agent.ts:485`, `:612-615`). Schema (`session.ts:73-76`) und Konsument (TUI-Replay, `App.tsx:168-180`) existieren schon. | S |
| Compaction-Slice-Bug (latent) | Nach Mid-Turn-Compaction ersetzt die Loop das Message-Array (`agent.ts:379-383`); `messages.slice(messagesBeforeTurn)` im InProcessBackend liefert dann einen inkonsistenten Slice (Teile der Summary bzw. fehlende Turn-Messages). Beim Befüllen der Felder mit Test abdecken. | S |
| Intra-Turn-Persistenz fehlt | Crash mid-turn verliert den ganzen Turn (1.4). Optional: Event-Stream (tool_call_start/done) inkrementell appenden. Für Nightly-Distillation vermutlich nicht nötig — bewusst offen lassen. | M (falls gewünscht) |

**Summe b: S** (ohne Intra-Turn-Persistenz; mit ihr M).

### c) Saubere Boundary-Semantik für den Nightly-Pass

| Lücke | Detail | Aufwand |
|---|---|---|
| `ended` überladen | Fünf End-Wege in einem Status (2.2); Shutdown-Ende (`runtime.ts:248-260`) ≠ logisches Ende. Mindestens dokumentieren + der Pipeline eine belastbare Regel geben (z. B. "`idle`/`ended` + `lastActivity < now - grace`"); besser: `endedAt` + Unterscheidung `ended_reason` (user / idle / shutdown). | S–M |
| Kein Terminal-Verhalten | Resume auf `ended` ungehindert möglich (`runtime.ts:454-490`) — "abgeschlossen" garantiert keine Immutabilität. Policy klären (Enforcement oder zumindest `lastActivity`-Re-Check durch die Pipeline). | XS–S |
| Kein Distill-Cursor | Nichts markiert "bereits distilliert" (kein Watermark, kein `distilledAt`). Pipeline müsste eigenen State führen oder Index-Feld ergänzen. | S |
| Prozessübergreifende Races | Kein Lock auf Index/Transkript (2.3). Lesen neben dem Daemon ist append-only-tolerant (partielle Zeile wird geskippt, `session.ts:466-474`), aber ein gleichzeitig resumter/schreibender Zweitprozess kann Lost Updates erzeugen. Single-Writer-Regel dokumentieren oder Lock. | XS–S |
| Compaction-Nebenschauplatz | Verdichtete Vorgeschichte liegt nur als Markdown, nur letzte Version (`compaction.ts:224-235`). Entscheiden, ob die Pipeline sie braucht; ggf. strukturiert ablegen statt zu überschreiben. | S |

**Summe c: M** (eine bewusste State-Machine-Entscheidung + Cursor + Reason-Feld; der Rest sind Kleinigkeiten).

---

## 5. Positiv festzuhalten

- Append-only-JSONL mit sofortigem Append pro Turn und Transkript-first-Reihenfolge ist eine solide Basis für einen lesenden Nightly-Consumer (`session.ts:410-441`).
- Atomare Index-Schreiben (`session.ts:281-291`), tolerantes Lesen partieller Zeilen (`session.ts:466-474`).
- Die Read-Funktionen existieren bereits und sind im DaemonClientBackend als Direct-Disk-Reader im Einsatz (`daemonClientBackend.ts:69-85`) — der beabsichtigte Konsumweg ist also schon einmal durchdacht.
- Das `SessionTurn`-Schema sieht Tool-Daten explizit vor (`session.ts:73-76`, `:87-91`) — die Lücke ist im Schreiben, nicht im Design.
