# Prompts

This directory contains external prompt templates loaded at runtime by the Harness agent loop.

## Files-as-API Pattern

Each `.md` file is a standalone prompt template. The code loads it by name and performs minimal variable substitution. There is no frontmatter parser, no YAML, and no template engine — just plain Markdown with `{{varName}}` placeholders.

## Variable Convention

- `{{varName}}` (double curly braces) is a placeholder that gets replaced at runtime.
- Variables are documented in an HTML comment at the top of each prompt file: `<!-- vars: varName1, varName2 -->`.
- Missing variables cause a hard crash — this is intentional. Broken prompts must never ship silently.

## Adding a New Prompt

1. Create a new `.md` file in this directory.
2. Add an HTML comment on the first line listing all variables.
3. Use `{{varName}}` for every runtime value.
4. Load it via `prompt("file-name", { varName: "value" })` from `src/prompts.ts`.

## Prompt & Injection Register

| File | Trigger | Injection Site | Status |
|------|---------|----------------|--------|
| `base-prompt.md` | immer (Daemon-Sessions) | Anfang des System-Prompts, vor der Profil-Persona | required |
| `web-content-safety.md` | `web_fetch` or `web_search` in active tool set | `buildSystemPrompt()` after `system-prompt` + `<core_memory>` | required when web tools active |
