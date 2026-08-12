# Forensik: WhatsApp-Bot ohne Antwort — Turn-Completion-Analyse

- Datum: 2026-08-11
- Auftrag: Forensik + Code-Analyse, keine Fixes
- Session: `20260811T070216-3f896b` (WhatsApp: 4915110619636)
- Betroffene Turns: 28-31 (Rezeptkarten-Workflow, 11:51-12:24 UTC)

## Befund: Zwei getrennte Fehlermuster

### Muster 1 (Turn 28→29): LLM beendet Turn mit Text statt Arbeit

**Timeline:**
- 11:50:38 User: „Check das ist aber nicht richtig… schau dir deine datei nochmal genau an"
- 11:51:18 Turn 28 endet. 1 Tool-Call: `image` (Datei inspizieren). Kein `exec`, kein `send_file`.
  - `finalMessage`: „Ich korrigiere die Karte jetzt vollständig anhand des Originalrezepts — ohne Zutaten wegzulassen."
- 11:51:19 — 12:05:32: **Keine Agent-Aktivität. 14 Minuten Idle.**
- 12:05:32 User: „Und? Noch am ackern?"
- 12:05:46 Turn 29 startet. LLM generiert v2.png per `exec` und sendet via `send_file`.

**Was passiert ist:** Der LLM hat in Turn 28 die Datei mit `image` inspiziert, Fehler gelistet, dann `stopReason: "stop"` produziert. Die Arbeit (Bild generieren und senden) hat er nicht gemacht — sie wurde auf den nächsten Turn verschoben, den der User triggern musste.

### Muster 2 (Turn 30→31): LLM ignoriert existierende Datei

**Timeline:**
- 12:09:45 User (Voice): „nicht die Zutatenliste. Das Problem ist… das Konzept nicht verstanden"
- 12:10:05 Turn 30 endet. **0 Tool-Calls.** Nur Text.
  - `finalMessage`: „Ich setze die Karte neu auf — diesmal mit echten Prozessspalten und ohne irreführende Zellverbünde."
- 12:10:05 — 12:24:01: **Keine Agent-Aktivität. 14 Minuten Idle.**
- 12:24:01 User: „Warum schockst dus nicht"
- 12:24:21 Turn 31 startet. Patched v2.py und sendet via `send_file`.

**Datei-Timestamps beweisen:** `v2.png` hatte `Geburt: 14:05:46` (während Turn 29 erstellt). Turn 30 um 14:10 hätte die existierende Datei sofort senden können — tat es aber nicht.

## Code-Analyse: Warum passiert das?

### 1. Der Agent-Loop hat keine Validierung

```989:1004:packages/core/src/core/agent.ts
        if (response.stopReason === "stop" || response.stopReason === "length") {
          const textParts = response.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text);
          return { aborted: false, turns: i + 1, finalMessage: textParts.join(""), ... };
        }
```

Wenn der LLM `stopReason: "stop"` produziert, wird ALLER Text — auch Text, der Tool-Aufrufe ankündigt — als `finalMessage` zurückgegeben. Keine Prüfung auf: „Hat der Text Arbeit versprochen, die nicht via Tool-Call ausgeführt wurde?"

`handleTurnComplete` (inbound.ts:396-417) sendet `finalResponse` blind via `sendOutbound` — null Validierung.

### 2. `tool_choice` wird nicht gesetzt

```577:580:packages/core/src/core/agent.ts
        const streamOptions: { apiKey?: string; temperature?: number; maxTokens?: number } = { apiKey };
        if (temperature !== undefined) streamOptions.temperature = temperature;
        if (maxTokens !== undefined) streamOptions.maxTokens = maxTokens;
```

Kein `tool_choice`-Parameter. Default ist `"auto"` — der LLM darf frei entscheiden, ob er Tools nutzt oder nicht. pi-ai 0.70.2 hat `tool_choice` nicht im typisierten Interface (`lib.ts:177-183`).

### 3. Der Base Prompt ermutigt Text-Only-Antworten

```1:7:packages/core/prompts/base-prompt.md
Du bist ein Agent in der Harness-Runtime (Node.js, Terminal-Umgebung).
- Dir stehen Tools für Datei-, Shell-, Such- und Web-Zugriffe zur Verfügung — nutze sie, statt über Dateiinhalte oder Systemzustände zu raten.
- Pfade beziehen sich auf das aktuelle Working Directory, wenn sie nicht absolut sind.
- Lies eine Datei, bevor du sie bearbeitest.
- Führe destruktive Aktionen (Löschen, Überschreiben, Prozesse beenden) nur nach expliziter Anweisung des Users aus.
- Antworte direkt und knapp; ohne Tool-Bedarf brauchst du keinen Tool-Call.
```

Die letzte Zeile sagt explizit: „ohne Tool-Bedarf brauchst du keinen Tool-Call". In Kombination mit der zweiten Zeile („nutze sie, statt zu raten") entsteht eine Ambiguität: Der LLM entscheidet selbst, ob er Tool-Bedarf hat. Wenn er glaubt, sein Wissen reiche aus, ruft er keine Tools.

### 4. Der Channel-Addendum ist rein formatting

```17:26:packages/agent/src/daemon/channelAddendum.ts
const WHATSAPP_ADDENDUM = `## WhatsApp formatting
This conversation happens over WhatsApp. Format all replies for WhatsApp.
...
- To send files or images, use the send_file tool.`;
```

Keine Guidance zu Turn-Orchestrierung, kein Hinweis, dass Dateien nach Generierung aktiv gesendet werden müssen.

### 5. Kein Mechanismus erkennt „versprochene aber nicht ausgeführte Arbeit"

Nirgends im Code gibt es eine Prüfung à la:
- „finalMessage enthält Ankündigungen wie 'ich erstelle/korrigiere/schicke', aber es gab keinen Tool-Call"
- „Turn endete ohne produktiven Output (nur Text)"
- „Eine vorher existierende Datei wurde nicht gesendet"
- „exec-Tool-Ausgabe zeigt Generierung, aber kein send_file folgte"

### 6. Memory Hints als Störfaktor

Memory-Hints werden als `role: "user"`-Message ins Context-Array eingefügt (`memoryBackend.ts:49-68`). Sie tragen das Label „NICHT User-Eingaben", aber die Rollenzuweisung als `user` könnte vom LLM als Korrektur/Steer interpretiert werden. Im konkreten Fall: Der Rezept-Memory-Hint aus dem vorherigen Turn könnte den LLM glauben lassen, er habe bereits geantwortet.

## Turn 30 spezifisch: Warum wurde die existierende v2.png ignoriert?

Die Datei `v2.png` lag seit Turn 29 (14:05:46) auf der Platte. Turn 30 (14:10:05) begann mit der User-Nachricht: „nicht die Zutatenliste. Das Problem ist… die Aufteilung stimmt nicht". Der LLM:

1. Las die User-Nachricht (Voice-Transkript) — versteht das Merge-Semantik-Problem
2. Produzierte `[thinking]` — reflektiert über das Konzept
3. Generierte Text-Antwort: „Ich setze die Karte neu auf — diesmal mit echten Prozessspalten"
4. Produzierte `stopReason: "stop"` — beendete den Turn ohne Tool-Call

Der LLM **wusste**, dass er die Karte neu aufsetzen muss. Er wusste auch, dass die Datei existiert (vorheriger Turn 29-Kontext enthält `send_file`-Resultat). Aber er entschied, dass eine Text-Erklärung als Turn-Abschluss ausreicht. Er hat nicht:

- `send_file` auf die existierende Datei aufgerufen
- `image` zur Inspektion der existierenden Datei genutzt
- `exec` zum Patchen der Datei ausgeführt

### Mögliche Mitursachen für Turn 30:

1. **Context-Fatigue.** Nach 30 Turns (~2.5M tokens) könnte der LLM ermüdet sein und Text-Only-Antworten bevorzugen.
2. **Voice-Transkript-Qualität.** Die Transkription könnte Nuancen verloren haben („nicht die Zutatenliste" vs. „das stimmt nicht").
3. **Falsches Verständnis des Cooking-for-Engineers-Konzepts.** Der LLM dachte in Turn 29, er habe es richtig gemacht. Die Voice-Nachricht korrigiert ihn — aber er formuliert nur eine Erklärung zurück, statt zu handeln.
4. **Kein Zwang zum Tool Call.** `tool_choice: "auto"` + Base-Prompt „ohne Tool-Bedarf kein Call" = LLM darf Text-only antworten.

## Hypothesen zur Root Cause (geordnet nach Wahrscheinlichkeit)

**H1 (höchstwahrscheinlich): Kombination aus fehlendem `tool_choice` und Base-Prompt-Phrasing.**
Der LLM erhält keine Aufforderung, Tools zu nutzen, und der Prompt sagt explizit, dass Tool-Calls optional sind. Bei komplexen Multi-Turn-Workflows führt das dazu, dass der LLM Text-Antworten produziert, wenn er unsicher ist oder denkt, er habe schon genug Kontext gegeben.

**H2: `maxTokens` / Token-Limit.**
Wenn `maxTokens` niedrig ist, könnte der LLM `stopReason: "length"` produzieren, bevor er Tool-Calls generiert. Allerdings zeigen die Token-Counts (Turn 30: 788 output tokens) kein offensichtliches Limit-Problem.

**H3: Memory-Hint-Kontamination.**
Die als `user`-Role injizierten Memory-Hints könnten den LLM verwirren und ihn glauben lassen, der User habe bereits eine Antwort bekommen.

**H4: Compaction-Qualität.**
Nach 30 Turns (~2.5M tokens) könnte Compaction den Kontext so verdichtet haben, dass der LLM nicht mehr erkennt, dass eine Datei-Generierung aussteht.

**H5: Modell-spezifisches Verhalten („luna").**
Das verwendete Modell (im Transkript als `modelRef: luna` referenziert, nicht im Code) könnte eine höhere Tendenz zu Text-Only-Antworten haben als andere Modelle.

## Quellen

- Transkript: `~/.harness/sessions/2026-08-11/20260811T070216-3f896b.jsonl`
- Daemon-Log: `~/.harness/logs/daemon-2026-08-11.log`
- Metriken: `~/.harness/metrics/turns-2026-08-11.jsonl`
- Code: `packages/core/src/core/agent.ts:989-1004`, `packages/core/prompts/base-prompt.md:7`, `packages/agent/src/whatsapp/inbound.ts:396-417`, `packages/agent/src/daemon/runtime.ts:1883-1909`, `packages/agent/src/daemon/channelAddendum.ts:17-26`, `packages/core/src/lib.ts:177-183`
- Datei-Timestamps: `stat /home/p-pfeiffer/harness/_scratch/shiitake-bolognese-cooking-engineers-v2.png`

## Appendix: Vollständige Turn-28–31 Message-History

### Turn 28 (11:51:18) — 4 Messages, 1 Tool-Call (image)

| Role | Content |
|------|---------|
| user | `[WhatsApp · Philipp] Check das ist aber nicht richtig… schau dir deine datei nochmal genau an,` |
| assistant | `[toolCall: image]` — Inspiziert v1.png gegen gespeichertes Rezept |
| toolResult | Image-Analyse listet strukturelle Fehler, aber warnt: Referenzrezept fehlt für exakten Vergleich |
| assistant | „Du hast recht — die Datei ist fehlerhaft… Ich korrigiere die Karte jetzt vollständig" |

### Turn 29 (12:06:00) — 6 Messages, 2 Tool-Calls (exec, send_file)

| Role | Content |
|------|---------|
| user | `[WhatsApp · Philipp] Und? Noch am ackern?` |
| assistant | `[toolCall: exec]` — Schreibt und führt `make_shiitake_card_v2.py` aus (v2.png, 1800x1320) |
| toolResult | file bestätigt PNG |
| assistant | `[toolCall: send_file]` — Sendet v2.png (125024 bytes) |
| toolResult | „Datei gesendet" |
| assistant | „Die korrigierte Datei ist gerade raus" |

### Turn 30 (12:10:05) — 2 Messages, 0 Tool-Calls

| Role | Content |
|------|---------|
| user | `[Voice] nicht die Zutatenliste. Problem ist die Aufteilung… chop mushrooms läuft über onions und garlic runter… Konzept nicht verstanden` |
| assistant | `[thinking]` + „Ich setze die Karte neu auf — diesmal mit echten Prozessspalten und ohne irreführende Zellverbünde" |

### Turn 31 (12:24:31) — 6 Messages, 2 Tool-Calls (exec, send_file)

| Role | Content |
|------|---------|
| user | `[WhatsApp · Philipp] Warum schockst dus nicht` |
| assistant | `[toolCall: exec]` — Patched `make_shiitake_card_v2.py` merge-Block |
| toolResult | exec exits 0 |
| assistant | `[toolCall: send_file]` — Sendet reparierte v2.png (108478 bytes) |
| toolResult | „Datei gesendet" |
| assistant | „Stimmt — ich hätte nicht weiter erklären, sondern direkt die korrigierte Datei schicken sollen" |
