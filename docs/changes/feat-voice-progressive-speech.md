# feat: Progressive Sprachausgabe bei reinen Textantworten (Voice)

## Problem/Symptom

Voice-Turns sprachen Zwischentexte bisher nur bei `tool_call_start`
(`queueProgressiveSay` in `packages/agent/src/daemon/runtime.ts`). Reine
Textantworten wurden erst nach dem kompletten `finalMessage` gesprochen →
wahrgenommene Antwortzeit ~5,8 s statt ~2,5 s (TTFT). Der Angerufene hörte
während der gesamten Generierung Stille.

## Befund

- Der `onEvent`-Handler von `submitVoiceTurn` puffert Text-Tokens bereits
  (`progressiveText`), spricht sie aber nur beim `tool_call_start`-Event.
- `token_revoke` (Thinking-Leak-Schutz des `ThinkingStreamTransformer`)
  wurde im Voice-Pfad gar nicht behandelt — zurückgenommenes Reasoning
  hätte bei einem Flush gesprochen werden können.
- `thinking`-Events erreichen den Handler nie als `token` (pi-ai parst
  `reasoning_content` separat), `toolcall_delta`-Argumente ebenfalls nicht.

## Änderung

- **Neu: `packages/agent/src/daemon/progressiveSpeech.ts`** —
  `takeProgressiveChunk(buffer, flush)`:
  - Flusht am **ersten** Satzende (`.`, `!`, `?`, `\n`), sobald mindestens
    `PENDING_TAIL` (12) Zeichen hinter der Grenze liegen — das Satzende
    liegt dann außerhalb des Revoke-Fensters.
  - Ohne Satzgrenze flusht ab `MIN_CHUNK` (80) Zeichen, hält aber
    `PENDING_TAIL` Zeichen als Puffer für `token_revoke` zurück.
  - `flush=true` (Turn-Ende / `tool_call_start`) gibt den kompletten
    Rest frei.
  - `MAX_FLUSH` (200) begrenzt die Chunk-Größe für die TTS-Cadence.
- **`submitVoiceTurn` in `runtime.ts`**:
  - `token`-Events: Puffer anhängen, Chunk ziehen, sofort `say` (satzweise
    progressive Sprachausgabe während das Modell weiter generiert).
  - Neu: `token_revoke`-Event → die letzten N Zeichen aus dem Puffer
    entfernen (Thinking-Leak-Schutz, analog zum WhatsApp-Pfad). Bereits
    gesprochene Chunks lassen sich nicht zurücknehmen.
  - `tool_call_start`: unverändert — verbleibender Text wird sofort
    gesprochen (Pre-Tool-Ansagen), Puffer geleert.
  - Turn-Ende: verbliebener Puffer-Rest wird einmal nachgeholt
    (Tail-Flush), damit nichts verloren geht.
- **Tests** (`voiceRuntime.test.ts`, `voiceChannel.test.ts`):
  - Satzweise progressive Sprachausgabe bei reiner Textantwort (TTFT).
  - Lange Antwort ohne Satzgrenze → Flush nach Mindestgröße.
  - Thinking-Tokens (`thinking`) werden nie gesprochen.
  - `token_revoke` vor Flush → zurückgenommenes Reasoning wird nie
    gesprochen; `token_revoke` nach Satzgrenze → nur der Rest wird
    zurückgezogen.
  - Tool-Call-Markup wird nicht gesprochen, Pre-Tool-Text sofort.
  - VoiceChannel: mehrere progressive `say`-Frames in Reihenfolge.

## Dateien

- `packages/agent/src/daemon/progressiveSpeech.ts` (neu)
- `packages/agent/src/daemon/runtime.ts`
- `packages/agent/tests/daemon/voiceRuntime.test.ts`
- `packages/agent/tests/daemon/voiceChannel.test.ts`

## Verification

- `pnpm build` — grün
- `pnpm typecheck` — grün
- `pnpm test -- tests/daemon/voiceRuntime.test.ts tests/daemon/voiceChannel.test.ts` — grün
- `pnpm test -- tests/daemon/runtimeWhatsAppProgressive.test.ts tests/daemon/runtimeWhatsAppVision.test.ts` — grün
- Gesamtsuite `packages/agent`: 703 Tests grün

## Offene Punkte

- `token_revoke` zählt UTF-8-Bytes, `slice` nutzt UTF-16-Einheiten —
  bei non-BMP-Zeichen (Emojis) kann der Revoke minimal danebenliegen
  (bestand schon im WhatsApp-Pfad, hier unverändert übernommen).
