# fix: Voice-Transkriptionsfehler sichtbar machen

## Problem

`transcribeVoice()` in `packages/agent/src/whatsapp/voice.ts` gab bei **jedem** Fehler still `null` zurück:

- fehlender `ASSEMBLYAI_API_KEY`
- Upload-Fehler (HTTP-Status von AssemblyAI)
- Submit-Fehler
- AssemblyAI-`status:"error"` (mit `error`-Feld)
- Polling-Timeout
- Datei-Lesefehler

Kein Log, keine Unterscheidung der Ursache. Folge: Voice-Notes kamen beim Agent als leere/generische Nachricht an, ohne dass jemand den Grund erfuhr.

## Befund

Alle Fehlerpfade liefen in denselben `return null` bzw. den äußeren `catch`-Block, der wieder `null` lieferte. Die Call-Site in `parseBaileysMessage` (plugin.ts) konnte Erfolg von Misserfolg nur anhand von `null` vs. String unterscheiden und hängte bei Fehlern die Audio-Datei als generische Media-Annotation an.

## Fix

### 1. `transcribeVoice` → discriminated Result-Objekt

`voice.ts` exportiert jetzt:

```typescript
type VoiceErrorReason =
  | "missing-api-key"
  | "upload-failed"
  | "submit-failed"
  | "transcription-error"
  | "timeout"
  | "read-error";

type VoiceTranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; reason: VoiceErrorReason; detail?: string };
```

- `detail` trägt bei HTTP-Fehlern den Statuscode (z.B. `"401"`), bei AssemblyAI-`error` das `error`-Feld.
- Keine Keys/Bodies werden geloggt; `detail` ist auf Statuscode/Fehlermeldung beschränkt.
- Lese-, Upload-, Submit- und Poll-Fehler haben jetzt eigene Fehlerpfade (kein alles-verschluckender äußerer `catch`).

### 2. Call-Site (plugin.ts `parseBaileysMessage`)

Bei `ok: false`:

- **warn-Log** mit `reason` (+ `detail` wenn vorhanden) über den vorhandenen Logger.
- **Maschinenlesbare Annotation** im Stil der bestehenden Annotation-Mechanik. Die Annotation wird über `annotations[]` dem Turn-Text beigefügt (inbound.ts hängt sie an `[WhatsApp · Sender] …` an), damit das Modell den Grund kennt und dem Nutzer natürlich antworten kann.
- `isVoiceTranscript` bleibt `false`, keine Datei-Annotation mehr.

Beispiel-Annotation (missing key):

> Voice note could not be transcribed: missing ASSEMBLYAI_API_KEY — set it in ~/harness/.env and /restart.

Bei Quota/Auth-Fehlern (401/402/429 bei Upload oder Submit):

> Voice note could not be transcribed: AssemblyAI rejected the upload (HTTP 401) — check your ASSEMBLYAI_API_KEY and quota in ~/harness/.env, then /restart.

### 3. Erfolgsfall unverändert

`{ ok: true, text }` → `text = [Voice-Nachricht] <transcript>`, `isVoiceTranscript = true`. Kein Verhaltensunterschied.

## Dateien

- `packages/agent/src/whatsapp/voice.ts` — `transcribeVoice` liefert `VoiceTranscriptionResult`, Fehlerpfade differenziert
- `packages/agent/src/whatsapp/plugin.ts` — Call-Site auf Result-Objekt umgestellt; `voiceErrorAnnotation()`-Helper; `parseBaileysMessage` für Tests exportiert
- `packages/agent/tests/whatsapp/voice.test.ts` — neu: fehlender Key, Upload-401, Submit-500, AssemblyAI-error, Timeout, Erfolgsfall
- `packages/agent/tests/whatsapp/plugin_voice.test.ts` — neu: Call-Site — Annotation landet im Event (Turn-Text), warn-Log, kein Crash, Erfolgsfall unverändert

## Tests

`pnpm --filter @harness/agent test` — 457 Tests in 44 Files, alle grün (davon 11 neue: 7 voice + 4 call-site).

Validierung im Worktree: `pnpm build`, `pnpm typecheck`, `pnpm --filter @harness/agent test` — grün. Kein Daemon-Restart.
