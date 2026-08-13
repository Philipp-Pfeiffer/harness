# Progressive Sends für Reasoning-Modelle (DeepSeek Pro)

**Datum:** 2026-08-13 · **Branch:** `fix/progressive-sends-reasoning`

## Problem

Bei Reasoning-Modellen (`reasoning: true`, z. B. DeepSeek Pro via OpenRouter-@preset)
wurde der Text **vor einem Toolcall** nie progressiv an den Kanal gesendet:

- WhatsApp: `submitWhatsAppTurn` unterdrückte Pre-Tool-Text komplett
  (`if (!turnReasoning) queueProgressiveSend(...)`).
- Voice: `submitVoiceTurn` sprach Pre-Tool-Text nie (`if (!turnReasoning) queueProgressiveSay(...)`).

Folge: Das Muster „Nachricht → Toolcall → Nachricht" (z. B. „Ich delegiere das…" vor
einem Subagent-Start) kam bei DeepSeek Pro nie an — die Zwischennachricht wurde
systematisch verschluckt. Flash-Modelle (ohne `reasoning`-Flag) waren nicht betroffen.

## Ursache

Die Sperre war ein defensives Sicherheitsnetz gegen *untagged reasoning* (Modell
streamt Denken als normalen Text statt als `reasoning_content`). Sie war für den
tatsächlichen DeepSeek-via-OpenRouter-Pfad unnötig:

- pi-ai parst `reasoning_content`/`reasoning`/`reasoning_text` in separate
  `thinking`-Blöcke (`thinking_delta`-Events) — unabhängig vom Modell-Flag.
- Der Agent routet diese als `thinking`-Events, **nie** als `token`.
- Der progressive Puffer (`progressiveText`) enthält daher ausschließlich
  legitimen Assistenten-Text. Die Sperre schützte vor einem Geist und brach
  echte Funktion.

## Fix

Blanket-Suppression entfernt (WhatsApp + Voice): Pre-Tool-Text wird bei
`tool_call_start` immer progressiv gesendet/gesprochen. Der eigentliche
Leak-Schutz bleibt auf Event-Ebene bestehen: `thinking`-Events erreichen den
progressiven Puffer nie.

## Tests

- Neuer Test in `runtimeWhatsAppProgressive.test.ts`: Reasoning-fähiges Modell
  + Text vor Toolcall → Text wird trotzdem progressiv gesendet
  (schlug vor dem Fix fehl: 0 Sends).

## Risiko

Restrisiko: Falls ein Reasoning-Modell sein Denken *ungetaggt* im content-Stream
liefert (kein `reasoning_content`, keine `<think>`-Tags), würde dieses Denken
nun progressiv mitgesendet. Für DeepSeek via OpenRouter in den Session-Daten
nicht beobachtet (finale Antworten waren durchgehend sauber); die
`ThinkingStreamTransformer`-Reklassifizierung (Flush-Revoke) schützt zusätzlich
die finale Antwort für Modelle mit aktivem `inlineThinking`.
