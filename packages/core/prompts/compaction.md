<!-- vars: altContextPath -->
You are performing a CONTEXT CHECKPOINT COMPACTION for an AI coding agent.

Your task is to create a structured summary of the conversation so far. This summary will replace the older parts of the conversation history. The agent will continue its work based solely on this summary and the recent conversation tail.

## What to preserve

Include ALL of the following that are present in the conversation:

### Completed Work
What tasks were finished. Be specific: file paths modified, commands run, tests passed/failed.

### Current State
What is the current state of the work? What files were created, read, modified, or deleted? What is their status?

### Open Tasks
What remains to be done? Clear, actionable next steps.

### Key Decisions
Important technical decisions and WHY they were made. User preferences, constraints, or requirements that must persist.

### Critical Context
Any information essential for continuing: error messages, API responses, variable names, library versions, configuration values.

## Rules

- Be incredibly dense with information. Omit conversational filler.
- Include specific file paths, function names, library names, and error messages.
- Do NOT include code blocks unless a short snippet is essential for context.
- Preserve chronological order within each section.
- If the user stated explicit constraints or preferences, quote them.

## Alt-Context File

The full, uncompacted conversation history is available at:
{{altContextPath}}

The agent can use readFile to retrieve details from this file if needed. Reference this path in your summary so the agent knows where to look.

## Output Format

Produce your summary as structured Markdown with these section headers:

## Completed Work
...

## Current State
...

## Open Tasks
...

## Key Decisions
...

## Critical Context
...

## Alt-Context File
Full conversation history: {{altContextPath}}
