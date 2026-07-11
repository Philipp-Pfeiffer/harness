# Befund-Report: Multi-Session-Fähigkeit des Daemons

**Datum:** 2026-07-11
**Scope:** `src/daemon/runtime.ts`, `src/daemon/ipc.ts`, `src/daemon/types.ts`
**Branch:** `feature/daemon`

## Zusammenfassung

Der Daemon ist aktuell **Single-Session**. Es gibt keine Session-Registry, keine
`sessionId` in IPC-Frames, und genau ein globales `this.session`-Feld. Eine
Multi-Session-Architektur erfordert substanzelle Änderungen an Runtime, IPC-Protocol
und Types — diese sind **nicht trivial** und in diesem Review nicht umgesetzt.

## Detail-Befunde

### B1: Globaler Single-Session-State statt Registry

**Datei:** `src/daemon/runtime.ts:86`

```typescript
private session: Session | null = null;
```

Die `DaemonRuntime`-Klasse verwaltet genau eine Session in einem einzelnen Feld.
Es gibt keine `Map<sessionId, Session>` oder ähnliche Registry.

**Auswirkungen:**
- Nur ein gleichzeitiger Conversation-Context möglich.
- `submit-turn` geht immer an die einzige aktive Session.
- `getStatus()` reportet `sessionsActive: this.session ? 1 : 0` (immer 0 oder 1).

**Fix-Klassifikation:** Nicht trivial. Erfordert:
- `Map<string, Session>` als Registry.
- Session-Lifecycle-Management (create/list/resume/end via IPC).
- Routing-Logik in `handleIpcRequest`.
- Anpassung von `turnsCompleted` auf per-Session-Basis.
- Abwärtskompatibilität für bestehende CLI-Clients.

### B2: Keine sessionId in IPC-Frames

**Datei:** `src/daemon/types.ts:37-42`

```typescript
export type IpcRequest =
  | { type: "ping" }
  | { type: "status" }
  | { type: "submit-turn"; messages: SerializedMessage[]; model?: string }
  | { type: "reload-config" }
  | { type: "shutdown" };
```

Kein `sessionId`-Feld in `submit-turn` oder anderen Request-Typen. Der Client
kann keine Session auswählen — das Protokoll hat kein Konzept von Session-Routing.

**Auswirkungen:**
- Mehrere Clients teilen sich dieselbe Session erzwingen.
- Keine Möglichkeit, eine bestehende Session wieder aufzunehmen (resume).
- Kein隔离 zwischen verschiedenen Conversation-Contexts.

**Fix-Klassifikation:** Trivial vorzubereiten — optionales `sessionId?: string`-Feld
hinzufügen (rückwärtskompatibel). Vollständiges Routing erfordert B1.

### B3: Keine IPC-Endpunkte für Session-Management

**Datei:** `src/daemon/runtime.ts:313-389` (`handleIpcRequest`)

Es gibt keine IPC-Request-Typen für:
- `create-session` — Starten einer neuen Session.
- `list-sessions` — Auflisten aktiver Sessions.
- `resume-session` — Wiederaufnahme einer beendeten Session.
- `end-session` — Beenden einer spezifischen Session ohne Daemon-Stop.

Ein Client kann nur Turns an die eine globale Session senden.

**Fix-Klassifikation:** Nicht trivial. Neue IPC-Typen, Handler, und Session-Lifecycle-Logik.

### B4: Session wird beim Start erstellt, nicht on-Demand

**Datei:** `src/daemon/runtime.ts:147` (`initSession`)

```typescript
this.session = await createSession(this.paths, {
  model: this.model?.name ?? "unknown",
  title: "Daemon Session",
});
```

Die Session wird in `start()` erstellt — lange bevor der erste Turn reinkommt.
Bei Multi-Session müsste die Session-Erstellung on-Demand via `submit-turn` mit
neuer `sessionId` oder via explizitem `create-session`-Request erfolgen.

**Fix-Klassifikation:** Nicht trivial. Verändert den Start-Flow.

### B5: turnsCompleted ist global, nicht per-Session

**Datei:** `src/daemon/runtime.ts:90`

```typescript
private turnsCompleted = 0;
```

Ein globaler Counter, nicht per-Session. Bei Multi-Session müsste dies in die
Session-Registry wandern oder als `Map<sessionId, number>` geführt werden.

**Fix-Klassifikation:** Nicht trivial (abhängig von B1).

## Triviale Fixes (in diesem Review umgesetzt)

### T1: Optionales `sessionId` in `submit-turn` IPC-Request

**Datei:** `src/daemon/types.ts`

`sessionId?: string` wird zu `submit-turn` hinzugefügt. Das Feld ist optional und
rückwärtskompatibel — bestehende Clients funktionieren unverändert. Wenn kein
`sessionId` gesendet wird, fällt der Daemon auf sein aktuelles Verhalten zurück
(die eine globale Session).

Dies bereitet das Protokoll auf Multi-Session vor, ohne die Implementierung zu
erzwingen. Die Runtime kann das Feld später auswerten, sobald die Registry existiert.

## WAL-Mode der Session-DB

**Datei:** `src/daemon/runtime.ts:131-138`

Der Daemon öffnet keine eigene SQLite-Datenbank. Die einzige SQLite-DB ist
`index.sqlite`, die über `MemoryService` → `@tobilu/qmd` `createStore()` geöffnet
wird.

**Befund:** QMD setzt `PRAGMA journal_mode = WAL` bereits beim Öffnen der
Datenbank (`@tobilu/qmd/dist/store.js:660` in `initializeDatabase()`). Weitere
PRAGMAs: `foreign_keys = ON`.

**Status:** ✅ WAL ist aktiv. Keine Aktion erforderlich.
