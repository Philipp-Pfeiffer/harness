# fix: daemon web_search providers missing

## Problem

`web_search` failed with `No web_search providers configured` in daemon/TUI
sessions, even though `~/harness/config.json` had a Tavily provider and
`TAVILY_API_KEY` was set in `~/harness/.env`.

## Befund

- `DaemonRuntime.initAgent()` called `loadTools()` without `webConfig`.
- `createWebSearchTool(undefined)` builds zero providers → immediate error.
- The TUI passes `webConfig` when running in-process, but daemon-backed
  sessions did not.
- `daemon run` did not load `$HARNESS_HOME/.env` before `loadConfig()`.

## Fix

- Store `webConfig` from `loadConfig()` on `DaemonRuntime`.
- Pass `webConfig` into `loadTools()`.
- Load `.env` from `$HARNESS_HOME` at the start of `daemonRun()`.

## Files

- `packages/agent/src/daemon/runtime.ts`
- `packages/agent/src/daemon/commands.ts`
