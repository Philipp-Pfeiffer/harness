# fix: Bug Hunter findings — 5 bugs fixed

## Problem/Symptom

Adversarial bug hunt (local-sequential, 65 source files scanned) found 5 behavioral bugs ranging from Critical (SSRF bypass) to Low (resource leak).

## Findings & Fixes

### BUG-1 (Critical, security): IPv4-mapped IPv6 SSRF bypass
- **File:** `packages/core/src/tools/webSecurity.ts:117-127`
- **Befund:** `isPrivateIp()` erkennt IPv4-mapped IPv6-Adressen (`::ffff:127.0.0.1`) nicht als private IPs. Sowohl `validateUrl()` als auch `createSecureLookup()` können umgangen werden.
- **Fix:** Regex-Matching für `::ffff:a.b.c.d` hinzugefügt, das an die IPv4-Prüfung delegiert.

### BUG-2 (High, data corruption): Background process output lost after yield
- **File:** `packages/core/src/tools/exec.ts:342-370`
- **Befund:** Nach yieldMs-Transition suchen die stdout/stderr Data-Handler das Session-Objekt über einen PID-basierten Key, der nie mit dem zufälligen Handle übereinstimmt. Alle Ausgaben nach der Yield-Transition werden verworfen.
- **Fix:** Session-Referenz direkt in Closure speichern (`bgSession`-Variable) statt Lookup über komputierten Key.

### BUG-3 (Medium, logic): Sync I/O in compaction blocks event loop
- **File:** `packages/core/src/core/compaction.ts:1, 224-235, 314`
- **Befund:** `writeAltContext()` verwendet `writeFileSync`/`mkdirSync`, was den Event Loop blockiert. Verstößt gegen AGENTS.md-Konvention (`node:fs/promises, nie synchron`).
- **Fix:** Zu `fs/promises`-Äquivalenten migriert, Funktion auf `async` umgestellt.

### BUG-4 (Low, logic): disableJobFile creates duplicate key with quoted values
- **File:** `packages/agent/src/daemon/jobs.ts:256, 273-274`
- **Befund:** `ENABLED_RE` matcht keine gequoteten Werte (`enabled: "true"`). Fallback fügt Duplikat-Key ein, der beim nächsten Reload einen Parse-Fehler verursacht.
- **Fix:** Regex um optionale Quotes erweitert: `(["']?)(\w+)\3`.

### BUG-5 (Low, resource leak): GC timer prevents clean process exit
- **File:** `packages/core/src/tools/processSupervisor.ts:41-43`
- **Befund:** `setInterval` für GC hat kein `.unref()`, was den Node.js-Prozess am Leben hält, auch wenn alle Arbeit erledigt ist.
- **Fix:** `.unref()` nach `setInterval` hinzugefügt.

## Tests

- `tsc --noEmit`: clean (beide Packages)
- `pnpm test`: 732 tests passed, 0 failures (281 agent + 451 core)
