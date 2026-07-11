# Context Compaction — Research

> Untersuchung, wie reale Agent-Harnesses Context Compaction umsetzen.
> Grundlage für die Implementierung in `@harness/core`.

## Überblick

Context Compaction (auch "summarization", "handoff") ist das Verdichten
von Gesprächsverläufen, wenn das Context Window eines LLMs sich füllt.
Ziel: verhindern, dass der Provider Fehler wirft oder die Qualität
durch "Context Rot" degradiert, ohne dabei entscheidende Informationen
zu verlieren.

---

## 1. Claude Code (Anthropic)

**Quellen:** Community Reverse-Engineering von `cli.js` v2.1.47;
GitHub Issues #34202, #27037, #11280; [claudefa.st](https://claudefa.st/blog/guide/mechanics/context-buffer-management);
[r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1jr52qj/here_is_claude_codes_compact_prompt/)

### Trigger-Schwelle

- Auto-Compact bei **~83,5%** des Context Windows (Standard)
  (200K Window → ~167K Tokens)
- Konfigurierbar via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1–100)
- Buffer: ~33K Tokens (16,5% des Fensters) für Compaction-Prozess + Response-Generierung
- Zuvor 45K Buffer (22,5%), in v2.1.21 reduziert
- Deaktivierbar via `settings.json`: `"autoCompact": false`

### Compaction-Prompt (wörtlich)

Aus r/ClaudeAI (Community-extrahiert):

```
Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. This summary will be used as context when continuing the conversation, so preserve critical information including:
- What was accomplished
- Current work in progress
- Files involved
- Next steps
- Key user requests or constraints
```

### Was bewahrt wird

- Zusammenfassung der älteren Turns (ersetzt diese)
- System Prompt, CLAUDE.md, auto memory, skills werden **re-injiziert** nach Compaction
- Path-scoped rules, nested CLAUDE.md files, mid-session gelesene Dateiinhalte **gehen verloren**

### Granularität

- Drei-Schichten-Modell (laut [justin3go.com](https://justin3go.com/en/posts/2026/04/09-context-compaction-in-codex-claude-code-and-opencode)):
  1. **Tool Result Trimming** (Zero-LLM-Cost): alte Tool-Ergebnisse durch Placeholder ersetzen, Tool-Calls bleiben
  2. **Cache-Friendly Strategy**: schneidet am Tail ab, um Prompt-Cache-Hit-Rate zu maximieren
  3. **LLM Summary**: gesamtes Gespräch zusammenfassen
- Persistierte History wird nicht separat gespeichert — Original geht verloren

### Manueller Trigger

`/compact` (optionale Custom Instructions: `/compact focus on the auth work`)

---

## 2. OpenAI Codex CLI

**Quelle:** `codex-rs/core/src/compact.rs`, `codex-rs/core/templates/compact/` ([GitHub](https://github.com/openai/codex))

### Trigger-Schwelle

- Token-basiert: `model_auto_compact_token_limit` (variiert pro Modell, z.B. 180K oder 244K)
- `effective_context_window_percent`: 95% als Safety-Margin

### Compaction-Prompt (wörtlich)

Aus `templates/compact/prompt.md`:

```
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

### Summary Prefix (vor Summary in neuem Context)

Aus `templates/compact/summary_prefix.md`:

```
Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
```

### Was bewahrt wird

- **Alle User-Nachrichten verbatim** (physisch erhalten)
- Alle Assistant-Antworten und Tool-Messages werden durch strukturierte Summary ersetzt
- Letzte ~20K Tokens an User-Nachrichten werden zusätzlich zur Summary behalten

### Granularität

- Single-Pass: alle AI-Antworten + Tool-Results → eine Summary
- Fallback bei Holzweg: "Head Trimming" (älteste Messages abschneiden)
- Retry-Logic mit exponentiellem Backoff

### Manueller Trigger

`/compact` Slash Command

---

## 3. OpenCode (sst/opencode)

**Quelle:** `packages/opencode/src/session/compaction.ts`, `packages/opencode/src/session/prompt/compaction.txt` ([GitHub](https://github.com/sst/opencode))

### Trigger-Schwelle

- `isOverflow()`: Tokens > `context_limit - output_limit`
- Deaktivierbar via `OPENCODE_DISABLE_AUTOCOMPACT`

### Compaction-Prompt (wörtlich)

Aus `packages/opencode/src/session/prompt/compaction.txt`:

```
You are a helpful AI assistant tasked with summarizing conversations.

When asked to summarize, provide a detailed but concise summary of the conversation.
Focus on information that would be helpful for continuing the conversation, including:
- What was done
- What is currently being worked on
- Which files are being modified
- What needs to be done next
- Key user requests, constraints, or preferences that should persist
- Important technical decisions and why they were made

Your summary should be comprehensive enough to provide context but concise enough to be quickly understood.
```

### Final User Message (an LLM gesendet)

Aus `compaction.ts`:

```
Summarize our conversation above. This summary will be the only context available when the conversation continues, so preserve critical information including: what was accomplished, current work in progress, files involved, next steps, and any key user requests or constraints. Be concise but detailed enough that work can continue seamlessly.
```

### Was bewahrt wird

- Neue Assistant-Message mit "summary"-Marker
- Bei Auto-Compaction: zusätzlich "Continue if you have next steps" Message

### Besonderheit: Prune-Mechanismus (vor Compaction)

Separat von Compaction, in `compaction.ts`:
- Scanned rückwärts durch Tool-Calls
- Schützte letzte 40K Tokens an Tool-Output (`PRUNE_PROTECT`)
- Prunte Tool-Outputs jenseits des Schwellenwerts wenn >20K Tokens prunbar (`PRUNE_MINIMUM`)

### Granularität

- Two-Phase: erst Pruning alter Tool-Outputs, dann LLM-Summary
- Non-destructive timestamp-based hiding: alte Messages werden versteckt (nicht gelöscht), bleiben im Session-Log

---

## 4. Gemini CLI (Google)

**Quelle:** `packages/core/src/context/chatCompressionService.ts` ([GitHub](https://github.com/google-gemini/gemini-cli)); Analyse via [codingtour.com](https://www.codingtour.com/posts/context-compress/)

### Trigger-Schwelle

- `DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5` (50% des Model-Token-Limits)
- Früher 0.7 (70%) —zw. 0.5 und 0.7 je nach Version
- Konfigurierbar via `config.getCompressionThreshold()`

### Compaction-Prompt (wörtlich)

Aus `promptProvider.ts` / `snippets.ts` → `getCompressionPrompt()`:

```
You are the component that summarizes internal chat history into a given structure.

When the conversation history grows too large, you will be invoked to distill the entire history into a concise, structured XML snapshot. This snapshot is CRITICAL, as it will become the agent's *only* memory of the past. The agent will resume its work based solely on this snapshot. All crucial details, plans, errors, and user directives MUST be preserved.

First, you will think through the entire history in a private <scratchpad>. Review the user's overall goal, the agent's actions, tool outputs, file modifications, and any unresolved questions. Identify every piece of information that is essential for future actions.

After your reasoning is complete, generate the final <state_snapshot> XML object. Be incredibly dense with information. Omit any irrelevant conversational filler.

The structure MUST be as follows:

<state_snapshot>
    <overall_goal>
        <!-- A single, concise sentence describing the user's high-level objective. -->
    </overall_goal>

    <key_knowledge>
        <!-- Crucial facts, conventions, and constraints the agent must remember. Use bullet points. -->
    </key_knowledge>

    <file_system_state>
        <!-- List files that have been created, read, modified, or deleted. Note their status and critical learnings. -->
    </file_system_state>

    <recent_actions>
        <!-- A summary of the last few significant agent actions and their outcomes. Focus on facts. -->
    </recent_actions>

    <current_plan>
        <!-- The agent's step-by-step plan. Mark completed steps. -->
    </current_plan>
</state_snapshot>
```

### Was bewahrt wird

- Structuriertes XML-Snapshot ersetzt alte History
- Letzte 30% der History (`COMPRESSION_PRESERVE_THRESHOLD = 0.3`) bleibt verbatim erhalten
- Split-Point an User-Message-Grenze (nicht mitten in Model-Response)

### Besonderheiten

1. **Two-Phase Compression**: Erst Summary generieren, dann **Self-Verification** — eine zweite LLM-Call fragt "Did you omit any specific technical details?" und ggf. Korrektur
2. **Function-Response-Token-Budget** (50K): alte Tool-Responses werden trunkiert (last 30 lines + Temp-File-Referenz), nicht gelöscht
3. **Inflation-Check**: wenn komprimierter Context größer als Original → NOOP
4. **Previous-Snapshot-Integration**: wenn bereits ein `<state_snapshot>` existiert, wird das neue damit integriert

### Granularität

- Split bei 70%-Grenze (compress älteste 70%, behalte jüngste 30%)
- Token-basierte Truncation von Tool-Responses vor der LLM-Summary
- Scratchpad + strukturiertes XML-Output

---

## 5. Aider

**Quelle:** `aider/history.py`, `aider/models.py`, `aider/prompts.py` ([GitHub](https://github.com/Aider-AI/aider)); Analyse via [bailey.net.au](https://mike.bailey.net.au/notes/software/aider/Chat%20History/)

### Trigger-Schwelle

- `max_chat_history_tokens`: 1024 (bei <32K context) oder 2048 (bei ≥32K context)
- Sehr kleines Limit — Aider behandelt Chat-History als sekundär, primär ist RepoMap

### Compaction-Prompt (wörtlich)

Aus `aider/prompts.py` → `summarize`:

```
*Briefly* summarize this partial conversation about programming.
Include less detail about older parts and more detail about the most recent messages.
Start a new paragraph every time the topic changes!

This is only part of a longer conversation so *DO NOT* conclude the summary with language like "Finally, ...". Because the conversation continues after the summary.
The summary *MUST* include the function names, libraries, packages that are being discussed.
The summary *MUST* include the filenames that are being referenced by the assistant inside the ```...``` fenced code blocks!
The summaries *MUST NOT* include ```...``` fenced code blocks!

Phrase the summary with the USER in first person, telling the ASSISTANT about the conversation.
Write *as* the user.
The user should refer to the assistant as *you*.
Start the summary with "I asked you...".
```

### Summary Prefix

```
I spoke to you previously about a number of things.
```

### Was bewahrt wird

- **Recursive Summarization**: `summarize_real()` teilt Messages in Head + Tail
  - Tail (letzte ~50% der Tokens) bleibt verbatim
  - Head wird summarisiert, dann mit Tail zusammengefügt
  - Falls zu groß: rekursiv (depth+1, max depth 3)
- User-Nachrichten werden priorisiert (in erster Person geschrieben)
- Function names, libraries, packages, filenames werden explizit bewahrt
- Code-Blöcke werden **nicht** in der Summary reproduziert

### Granularität

- Recursive: Halbierung bis es passt
- Depth-Limit: 3 (danach `summarize_all`)
- `summarize_all`: alles in einen String, dann an LLM

### Besonderheit

Aider nutzt primär RepoMap (tree-sitter AST, graph-rankiert) für Context-Management,
nicht Compaction. Compaction ist Fallback für Chat-History-Overflow.

---

## 6. Lethain-Trick (Will Larson)

**Quelle:** [lethain.com — Agents & Context Compaction](https://lethain.com/agents-context-compaction/)

Will Larson beschreibt in "Building internal agents" einen fünfstufigen Ansatz:

### Kernpattern

1. **Token-Accounting pro Message**: Nach jeder User-Message (inkl. Tool-Response) eine System-Message mit verbrauchten/verfügbaren Tokens + Liste der verfügbaren `files` hinzufügen
2. **Virtual Files für große Messages**: User-Messages und Tool-Responses >10K Tokens werden als "virtual file" gespeichert. Nur die ersten 1K Tokens bleiben im Context; der Rest ist über `file_read`-Tool abrufbar
3. **Base Tools**: `file_read` (ganze Datei, Line-Range, Byte-Range) und `file_regex` (Regex-Scan) als immer-verfügbare Tools
4. **80%-Trigger**: wenn eine Message den Context über 80% des Fensters pusht → Compaction mit LLM
5. **Alt-Context als Virtual File**: nach Compaction wird der gesamte alte Context als virtuelle Datei hinterlegt. Der Agent kann verlorene Details per `file_read` zurückholen

### Wörtliches Zitat

> "After compacting, add the prior context window as a virtual file to allow the agent to retrieve pieces of context that it might have lost"

> "The prompt isn't particularly special, it just already exists and seems pretty good"

### Was bewahrt wird

- Compaction-Prompt (verwendet Claude Code's Prompt als Referenz)
- **Alt-Context als File**: der volle, unverdichtete alte Context bleibt als Datei verfügbar
- Virtual Files für einzelne große Messages (nicht nur bei Compaction)
- File-Usage-Tracking (`<files>` XML zeigt, was gelesen wurde)

### Granularität

- Per-Message Virtual Files (10K Threshold)
- Rolling Compaction bei 80%
- File-Read als Granularitäts-Escape-Hatch

---

## Shortlist: Kernpatterns

| # | Pattern | Beschreibung | Genutzt von |
|---|---------|-------------|-------------|
| 1 | **LLM-Summary Compaction** | Älteste N Turns → LLM-Call mit Dedizierte-Prompt → Summary-Turn ersetzt Originale | Claude Code, Codex, OpenCode, Gemini, Aider |
| 2 | **Tool-Result Pruning** (Pre-Compaction) | Alte Tool-Outputs durch Placeholder ersetzen, Tool-Calls behalten — Zero-LLM-Cost | Claude Code (Layer 1), OpenCode (Prune), Gemini (Token-Budget) |
| 3 | **Recent-Context Preservation** | Letzte N% / N Tokens verbatim behalten, nur älteres verdichten | Codex (20K), Gemini (30%), OpenCode |
| 4 | **Lethain-Trick: Alt-Context als File** | Verdrängter Context als Datei speichern → Agent kann per `read_file` zurückholen | Lethain, Suna (expand-message) |
| 5 | **Virtual Files für große Messages** | Messages >10K Tokens → virtuelles File, nur erste 1K Tokens im Context | Lethain |
| 6 | **Structured XML Summary** | Statt Freitext: strukturiertes XML mit `overall_goal`, `key_knowledge`, `file_system_state`, `recent_actions`, `current_plan` | Gemini CLI |
| 7 | **Recursive Summarization** | Wenn Summary+Tail zu groß: rekursiv weiter verdichten (max depth 3) | Aider |
| 8 | **Self-Verification** | Zweite LLM-Call: "Did you omit critical details?" → ggf. korrigierte Summary | Gemini CLI |
| 9 | **Split-Point an User-Message** | Nicht mitten in Assistant-Response splitten — User-Message-Grenze als Cut | Gemini, Aider |
| 10 | **80%-Trigger** | Compaction bei ~80% des Context Windows (konfigurierbar) | Lethain, Claude Code (~83.5%), OpenCode (overflow) |
| 11 | **Inflation-Check** | Wenn compaction > original → NOOP (nicht ersetzen) | Gemini CLI |
| 12 | **Rolling Chunks** | Nicht alles auf einmal: älteste Turns in Chunks verdichten, jüngere behalten | Alle (implizit durch Recent-Context) |
| 13 | **User-Message-Vorhaltung** | User-Nachrichten verbatim bewahren, auch nach Compaction | Codex (alle), Aider (erste Person) |
| 14 | **Scratchpad vor Summary** | LLM denkt erst im `<scratchpad>` nach, produziert dann strukturierte Summary | Gemini CLI |
| 15 | **Previous-Snapshot-Integration** | Wenn bereits eine Summary existiert: neues integriert Altes, nichts geht verloren | Gemini CLI |

---

## ADR-Entwurf: Compaction für Harness

### Status: Proposed

### Kontext

Das Harness hat aktuell kein Context Window Management. `contextWindow`
wird auf `ResolvedModel` gesetzt aber nie gelesen. Die Message-Array
wächst unbegrenzt innerhalb einer `run()` und über Turns hinweg. Bei
Überschreitung des Fensters gibt der Provider einen Fehler zurück.

### Entscheidung

Implementierung eines **LLM-basierten Compaction-Moduls** mit folgenden
Design-Entscheidungen, begründet aus der Research:

#### 1. LLM-Summary als Summary-Turn (Pattern 1)

Die ältesten N Turns werden zu einem Summary-Turn verdichtet (LLM-Call
mit dediziertem Compaction-Prompt). Das ist der universell bestätigte
Ansatz (Claude Code, Codex, OpenCode, Gemini, Aider).

**Gegencompound:** Tool-Result-Pruning-only (Pattern 2) ist günstiger,
aber nicht ausreichend für tiefe Coding-Sessions mit vielen
Snapshots der Dateiinhalte.

#### 2. Alt-Context als Datei im Session-State (Pattern 4 — Lethain-Trick)

Die verdrängten Turns werden als Markdown-Datei in `$HARNESS_STATE`
gespeichert. Der Pfad wird im Summary-Turn referenziert. Der Agent kann
verlorene Details über das bestehende `readFile`-Tool zurückholen.

**Begründung:** Das ist der entscheidende Vorteil gegenüber allen
anderen Harnesses — kein Informationsverlust, da der volle alte Context
per `read_file` abrufbar bleibt. Larson: "add the prior context window
as a virtual file to allow the agent to retrieve pieces of context that
it might have lost".

#### 3. 80%-Token-Trigger (Pattern 10)

Auto-Trigger bei 80% des `contextWindow` aus `ResolvedModel`.
Konfigurierbar (Default 0.8). Deterministisch und reproduzierbar.

**Begründung:** Lethain empfiehlt 80%. Claude Code nutzt ~83,5%. Bei
95%+ ist es zu spät (Codex Learnings: Context Overflow, Rate-Limits
während Compaction). 80% ist sicher und gibt genug Buffer für den
Compaction-LLM-Call selbst.

#### 4. Strukturierte Summary (Pattern 6 + 14)

Der Compaction-Prompt forciert ein strukturiertes Output mit klaren
Sections: Completed Work, Current State, Open Tasks, Key Decisions,
Critical Context. Optional mit Scratchpad-Phase.

**Begründung:** Gemini CLI's XML-Snapshot ist die elaborierteste Lösung
und wurde hier als Template verwendet. Strukturierte Summaries sind
dichter an Information und leichter für das LLM zu parsen. Freitext
(Claude Code, Codex) ist einfacher, aber weniger zuverlässig.

#### 5. Recent-Context Preservation (Pattern 3 + 9)

Die jüngsten Turns bleiben unverändert im Working-Context. Nur die
ältesten Turns werden verdichtet. Split-Punkt an einer natürlichen
User-Message-Grenze.

**Begründung:** Universal bestätigt. Der Agent braucht die jüngsten
Aktionen in voller Auflösung. Codex (20K Tokens), Gemini (30%),
OpenCode (Tail). Wir behalten die letzten 20% der Turns (mindestens
aber die letzten 2 Turns).

#### 6. Persistierte History bleibt vollständig

Compaction wirkt **nur auf den Working-Context** (die `Message[]`,
die an `stream()` geht), nicht auf das persistierte Transcript
(JSONL). Das Transcript bleibt vollständig erhalten.

**Begründung:** Das Transcript ist die Audit-Spur und die Basis für
Session-Resume. OpenCode's Non-Destructive-Principle: "nothing is
truly deleted, making the compaction process auditable and reversible."

#### 7. Inflation-Check (Pattern 11)

Wenn die compaction die Message-Array nicht kleiner macht → NOOP,
keine Ersetzung.

**Begründung:** Edge-Case, aber wichtig. Bei sehr kurzen Sessions oder
sehr effizientem LLM-Output kann die Summary größer sein als die
Originale. Gemini CLI macht diesen Check explizit.

#### 8. Public-API-Export, kein CLI-Wiring

`compactSession()` wird als Public API in `@harness/core` exportiert.
CLI-Wiring (`/compact`-Command) kommt in einem separaten Goal.

### Konsequenzen

- **+** Kein Informationsverlust dank Alt-Context-File (Lethain-Trick)
- **+** Deterministischer Trigger (reproduzierbar)
- **+** Transcript bleibt vollständig (Audit-Spur)
- **+** Strukturierte Summary (zuverlässigere Verdichtung)
- **−** Extra LLM-Call bei Compaction (Kosten)
- **−** Alt-Context-Files belegen Speicher in `$HARNESS_STATE`
  (regenerierbar, nicht kritisch)
- **−** Erste Compaction-Implementierung — ein Iterationszyklus für
  Prompt-Tuning ist wahrscheinlich nötig

### Offene Punkte (spätere Ziele)

- Tool-Result-Pruning als Pre-Compaction-Phase (Pattern 2)
- Virtual Files für einzelne große Messages (Pattern 5)
- Recursive Summarization bei sehr langen Sessions (Pattern 7)
- Self-Verification der Summary (Pattern 8)
- Konfigurierbare Trigger-Schwelle via `config.json`
