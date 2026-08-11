# feat: Vision-Inline-Images — Bilder direkt in den Turn-Kontext bei vision-fähigen Modellen

## Problem

WhatsApp-Bilder wurden bisher als Datei-Annotation in den Turn gelegt; der Agent
musste das externe `image`-Tool (OpenRouter-Vision-Preset) aufrufen, um das Bild
zu sehen. Das galt auch dann, wenn das aktive Modell selbst vision-fähig war
(z. B. `@preset/vision` via `/model vision`).

Befund aus Phase 1:

- Der Agent-Loop und pi-ai unterstützen Image-Content-Blocks nativ
  (`{ type: "image", data, mimeType }`; siehe `dist/types.d.ts` und
  `dist/providers/openai-completions.js` / `dist/providers/anthropic.js`).
- `submitWhatsAppTurn` baute die Blöcke jedoch im **falschen Format**:
  `{ type: "image", source: { type: "base64", mediaType, data } }`. pi-ai
  liest `data`/`mimeType` direkt auf dem Block — der `source`-Wrapper wurde
  von keinem Provider gelesen (nur Anthropic baut ihn intern selbst).
- Die Vision-Entscheidung lag im WhatsApp-Plugin und nutzte nur den
  **Config-Default-Modell** (`configDefaultModel?.supportsVision`), nicht das
  pro Session aktive Modell (`/model vision` ging ins Leere).
- Kein Size-Cap / keine Größen-Limitierung für inline Bilder.

## Lösung

1. **Korrektes ImageContent-Format** in `submitWhatsAppTurn`
   (`packages/agent/src/daemon/runtime.ts`): `{ type: "image", data, mimeType }`
   (base64). Das ist der pi-ai-Vertrag, den alle Provider verstehen.

2. **Per-Session-Vision-Entscheidung** im Daemon (nicht mehr im Plugin):
   - `modelSupportsVision(model)` prüft `input` (enthält `"image"`) und
     `supportsVision` aus der Model-Config — kein Hardcode auf Modellnamen.
   - Vision-fähige Session → Bild als Image-Block direkt im User-Content.
   - Nicht-vision Session → Bild wird NICHT inline geschickt; der Turn-Text
     bekommt den image-Tool-Hinweis mit dem Dateipfad als Fallback.

3. **Plugin erzeugt Kandidaten-Blöcke** (unkonditioniert bei vorhandenem
   Modell), damit die Runtime je Session entscheiden kann. Das
   `modelSupportsVision`-Flag der Plugin-Optionen wurde entfernt.

4. **Size-Cap + Resize** in `createImageBlock`
   (`packages/agent/src/whatsapp/media.ts`):
   - `MAX_INLINE_IMAGE_BYTES` (10 MB, analog zum image-Tool) → größere Bilder
     fallen auf Datei-Annotation + image-Tool zurück.
   - `MAX_INLINE_IMAGE_DIMENSION` (2048 px) → Bilder größer als die größte
     Seite werden mit `sharp` auf max. 2048 px (fit inside) als JPEG
     downscaled. hält Token-Kosten begrenzt.
   - Nicht-dekodierbare Dateien → `null` (Annotation-Fallback).
   - Neue Abhängigkeit `sharp@0.35.3` (war bereits transitiv via baileys im
     Lockfile; jetzt explizit in `@harness/agent`).

5. **Annotation / Profil-Hinweis**:
   - Media-Annotation ist jetzt neutral (`Bild angehängt: <pfad> (<größe>).`).
   - Die Runtime hängt den richtigen Hinweis an: Vision → „Du siehst das
     angehängte Bild direkt — kein image-Tool nötig."; Nicht-Vision → der
     image-Tool-Hinweis mit Pfad.
   - Agent-Profile (`packages/agent/agents/*/agent.md`) referenzieren das
     image-Tool nicht — kein Profil-Edit nötig.

## Dateien

- `packages/agent/src/daemon/runtime.ts` — ImageContent-Format, Per-Session-Vision, Hinweise
- `packages/agent/src/daemon/types.ts` — `InboundImageBlock.filePath`
- `packages/agent/src/whatsapp/plugin.ts` — Kandidaten-Blöcke, Optionen bereinigt
- `packages/agent/src/whatsapp/media.ts` — Size-Cap, Resize, neutrale Annotation
- `packages/agent/src/whatsapp/limits.ts` — `MAX_INLINE_IMAGE_BYTES`, `MAX_INLINE_IMAGE_DIMENSION`
- `packages/core/src/core/resolveModel.ts` — `supportsVision` auf `ResolvedModel`
- `packages/agent/package.json` / `pnpm-lock.yaml` — `sharp` explizit
- `packages/agent/tests/whatsapp/media.test.ts` — erweitert (Cap, Resize, filePath)
- `packages/agent/tests/daemon/runtimeWhatsAppVision.test.ts` — neu

## Tests

```bash
# Vision-Modell bekommt Image-Block, Nicht-Vision nutzt weiterhin Tool:
pnpm --filter @harness/agent test tests/daemon/runtimeWhatsAppVision.test.ts

# Media-Pipeline (Cap, Resize, Annotation):
pnpm --filter @harness/agent test tests/whatsapp/media.test.ts

pnpm typecheck && pnpm -r build
```

Agent-Suite: 530/530 grün. Core-Suite: 548/549 grün (einzige Rote:
`exec.test.ts > elevated > id -u` — pre-existing Sudo-Flake, braucht
passwordless sudo).
