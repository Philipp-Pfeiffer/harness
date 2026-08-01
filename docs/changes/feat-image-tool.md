# feat: image tool for vision via OpenRouter preset

## Problem

Non-vision main models (e.g. DeepSeek via `@preset/deepseek-flash`) cannot see images.
WhatsApp inbound images are saved to disk with a file-path annotation, but the agent had
no tool to analyze them. Vision must use the OpenRouter dashboard preset (`@preset/vision`)
and pass the preset ID through to the API unchanged.

## Solution

New `image` tool that:

- Accepts `url` (http/https link or local file path) and optional `prompt`
- Resolves the vision model from `image.model` config (default `@preset/vision`)
- Calls `complete()` on the configured vision model with text + image content blocks
- Returns analysis wrapped in `<image_analysis>`

## Config

`$HARNESS_HOME/config.json`:

```json
{
  "image": {
    "model": "@preset/vision",
    "maxTokens": 4096
  },
  "models": [
    {
      "provider": "openrouter",
      "model": "@preset/vision",
      "alias": "Vision",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "env:OPENROUTER_API_KEY",
      "input": ["text", "image"]
    }
  ]
}
```

## Files

- `packages/core/src/image/config.ts` — model resolution (OpenRouter preset passthrough)
- `packages/core/src/tools/image.ts` — tool implementation
- `packages/core/src/tools/registry.ts` — register when models are configured
- `packages/core/src/config.ts` — `ImageConfig` type + load
- `packages/agent/src/daemon/runtime.ts`, `index.tsx`, `cli/App.tsx` — wire image config
- `packages/core/tests/image/config.test.ts`, `packages/core/tests/tools/image.test.ts`

## Tests

```bash
CI=true pnpm --filter @harness/core test tests/image tests/tools/image.test.ts
```
