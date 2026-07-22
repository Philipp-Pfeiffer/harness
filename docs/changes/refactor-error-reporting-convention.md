# Refactor: Unified Error Reporting Convention for All Tools

**Date:** 2026-07-22  
**Type:** refactor  
**Files:** 17 source + 9 test files

## Problem

All tools had inconsistent error-reporting patterns:

| Tool | Pattern |
|------|---------|
| readFile | Plain strings |
| exec / process | Internal `{ isError, content }` but stripped at `execute()` boundary |
| write / edit | Typed prefix strings (`SENSITIVE_PATH:`, `READ_REQUIRED:`) |
| web_fetch / web_search | XML-wrapped strings |
| searchMemory | Header strings (`--- memory search: error ---`) |
| loadSkill / findSkill | Plain strings |

The central problem: `Tool.execute()` returned `Promise<string>`, and the agent loop (`agent.ts:594`) set `isError = true` only when a tool **threw**. Since tools almost never threw (they returned error strings), `isError` was always `false` — the LLM saw no error flags, only text. Tools like `exec` that computed `isError` internally had it stripped at the `execute()` boundary.

## Solution

### New `ToolResult` type

```typescript
export interface ToolResult {
  content: string;
  isError: boolean;
}
```

### Helper functions

```typescript
export function ok(content: string): ToolResult;
export function err(content: string): ToolResult;
```

### `Tool.execute()` return type changed

From `Promise<string> | string` to `Promise<ToolResult> | ToolResult`.

### Convention

- **Success:** `return ok("file contents…")`
- **Error (expected):** `return err("File not found: /path")`
- **Error (unexpected):** throw — the agent loop catches and treats as `{ content: err.message, isError: true }`

### Agent loop (`agent.ts`)

```typescript
const toolResult = await Promise.resolve(tool.execute(toolCall.arguments, toolContext));
result = toolResult.content;
if (toolResult.isError) isError = true;
```

The metrics recorder now also respects `isError` for status ("error" vs "ok").

### Logger injection

`ToolCallContext` gained an optional `logger?: (msg: string, level?: "warn" | "debug") => void`. The agent loop injects its existing `logger`. This replaces `console.warn` calls in:

- `execPty.ts` — shell fallback warning
- `processSupervisor.ts` — kill timeout warning (via `setLogger()`)

## Files Changed

### Source
- `packages/core/src/tools/types.ts` — `ToolResult`, `ok()`, `err()`, `ToolCallContext.logger`, `Tool.execute()` return type
- `packages/core/src/tools/readFile.ts` — `ok()`/`err()` on all return paths
- `packages/core/src/tools/exec.ts` — `ExecToolResult extends ToolResult`; `execute()` returns result directly
- `packages/core/src/tools/execPty.ts` — accepts optional `logger` param; `console.warn` → context logger
- `packages/core/src/tools/execBackground.ts` — no changes (already compatible via `ExecToolResult`)
- `packages/core/src/tools/process.ts` — `ProcessToolResult extends ToolResult`; `execute()` returns result directly
- `packages/core/src/tools/processSupervisor.ts` — `setLogger()` method; `console.warn` → injected logger
- `packages/core/src/tools/write_file.ts` — `ok()`/`err()` on all return paths
- `packages/core/src/tools/edit_file.ts` — `ok()`/`err()` on all return paths
- `packages/core/src/tools/web_fetch.ts` — `ok()`/`err()` on all return paths
- `packages/core/src/tools/web_search.ts` — `ok()`/`err()` on all return paths
- `packages/core/src/tools/searchMemory.ts` — `ok()`/`err()` on all return paths
- `packages/core/src/tools/loadSkill.ts` — `ok()`/`err()` on all return paths
- `packages/core/src/tools/findSkill.ts` — `ok()` on all return paths; silent catch in `searchSkills()` now logs via `console.warn`
- `packages/core/src/core/agent.ts` — tool execution extracts `.content`/`.isError`; toolContext includes `logger`

### Tests
- `packages/core/tests/tools/readFile.test.ts` — `.content` access on all `execute()` results
- `packages/core/tests/tools/edit_file.test.ts` — `.content` access
- `packages/core/tests/tools/write_file.test.ts` — `.content` access
- `packages/core/tests/tools/web_search.test.ts` — `.content` access
- `packages/core/tests/tools/web_fetch.test.ts` — `.content` access
- `packages/core/tests/tools/searchMemory.test.ts` — `.content` access
- `packages/core/tests/skills/skills.test.ts` — `.content` access
- `packages/core/tests/core/parallel.test.ts` — mock tools return `ok()`
- `packages/core/tests/agent.test.ts` — mock tools return `ok()`

## Migration Guide for Future Tools

1. Import `ok` and `err` from `./types.js` (or `../tools/types.js`).
2. `execute()` must return `Promise<ToolResult>`.
3. Use `return ok("result")` for success.
4. Use `return err("Error description")` for expected failures (file not found, validation, etc.).
5. Only throw for truly unexpected errors — the agent loop catches them.
6. Use `context?.logger?.(msg, "warn")` instead of `console.warn` for non-critical warnings.
