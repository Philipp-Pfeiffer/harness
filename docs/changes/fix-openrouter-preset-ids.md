# fix: OpenRouter @preset model IDs pass through to API

## Problem

Config used raw OpenRouter model slugs (`deepseek/deepseek-v4-flash`) instead of
the user's OpenRouter dashboard presets (`@preset/deepseek-flash`). Harness also
treated `@preset/` as a local file convention to resolve — that was wrong.

OpenRouter expects the API `model` field to be literally `@preset/<name>` when
using dashboard presets.

## Fix

- `config.models[].model` uses `@preset/deepseek-flash`, `@preset/deepseek-pro`,
  `@preset/vision` — sent unchanged to OpenRouter
- Browser sub-agent accepts `@preset/...` refs (no `provider/model` parsing)
- `resolveModelFromConfig` builds custom models with `id: "@preset/..."` when
  provider has `baseUrl`/`apiKey`

## Files

- `~/harness/config.json`
- `packages/core/src/browser/config.ts`
- `packages/core/src/browser/runner.ts`
- `packages/core/tests/browser/integration.test.ts`
- `packages/core/tests/core/resolveModel.test.ts`
