# feat: `voiceModel`-Config-Feld für Voice-Call-Sessions

## Was

Neues optionales Daemon-Config-Feld `voiceModel`: ein Modell-Referenzstring
(config keyword, alias, model id oder provider/model) für Voice-Call-Sessions.

## Warum

Voice-Calls sollen ein eigenes Standardmodell bekommen können (z. B.
`google/gemini-3.7-flash`), statt das globale `defaultModel` des Daemons zu
nutzen. Sprachsessions brauchen oft ein anderes Modell als Chat-/Agent-Turns —
bisher war das nicht steuerbar, ohne das globale Default zu ändern.

## Wie

- `DaemonConfig.voiceModel?: string` (`packages/agent/src/daemon/types.ts`),
  direkt nach `defaultModel`.
- `resolveVoiceSession` (`packages/agent/src/daemon/runtime.ts`) übergibt
  `this.config.voiceModel` als `modelRef` an `createSessionEntry`. Dadurch
  greifen die bestehenden Voice-Turn-Pfade (inbound ringing +
  `submitVoiceTurn`) automatisch: `applyTurnModel(turnCtx, entry.modelRef)`
  löst den Ref über `resolveModelRef` → `findConfigModel` +
  `resolveModelFromConfig` auf — dieselbe Matcher-Logik wie bei `/model`.
- Fehlt das Feld (`undefined`), bleibt es beim bisherigen Verhalten: Voice
  nutzt das Daemon-Default-Modell.

## Konfiguration

`this.config.voiceModel` wird aus `config.json` unter `daemon.voiceModel`
gelesen — der Daemon-Config-Loader übernimmt das Feld automatisch per Spread,
kein Loader-Code nötig.

## Dateien

| Datei | Änderung |
|-------|----------|
| `packages/agent/src/daemon/types.ts` | `voiceModel?: string` auf `DaemonConfig` |
| `packages/agent/src/daemon/runtime.ts` | `resolveVoiceSession` übergibt `this.config.voiceModel` als `modelRef` |
| `docs/changes/feat-voice-model.md` | dieses Dokument |

## Non-Goals

- Kein neuer Matcher — Voice nutzt die vorhandene `resolveModelRef`-Logik.
- Kein Fallback-/Fehler-Sonderfall: ungültige Refs verhalten sich wie bei
  `/model` (kein Match → Fehler/Default je nach bestehender Auflösung).
- `~/harness/config.json` bleibt unangetastet (wird separat konfiguriert).
