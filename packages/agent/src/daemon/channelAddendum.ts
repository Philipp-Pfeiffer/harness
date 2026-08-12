import type { SessionOrigin } from "../core/session.js";
import { buildStickerCatalog } from "../stickers/library.js";

/*
 * ORIGINAL (German):
 *
 * const WHATSAPP_ADDENDUM = `## WhatsApp formatting
 *
 * This conversation happens over WhatsApp. Format all replies for WhatsApp.
 *
 * These formatting rules override any general markdown conventions from the base prompt:
 * - Bold with *single asterisks* (NOT **double** asterisks), italic with _underscores_,
 *   strikethrough with ~tildes~, \`inline code\` and \`\`\`code fences\`\`\` all work natively in WhatsApp.
 * - Do NOT use markdown headings (# renders as raw text), markdown link syntax
 *   ([text](url) renders raw — write URLs plainly), or image markdown (![](...) renders raw).
 * - Tables are allowed and rendered as images — use them when they genuinely structure data.
 * - Lists with - or 1. are fine. Keep messages conversational in length;
 *   long output is split at paragraph boundaries (~4000 characters).
 * - To send files or images, use the send_file tool.`;
 */

/**
 * Builds the channel system-prompt addendum for a session origin.
 *
 * WhatsApp sessions get the formatting rules plus — when the sticker library
 * has entries — a compact catalog ("name — beschreibung", one line per
 * sticker, capped at 50). A missing or broken library yields an empty
 * catalog: nothing is injected, no crash.
 *
 * The catalog is read from the sticker library dir. When no library dir is
 * given (e.g. non-daemon contexts), the addendum falls back to the static
 * formatting rules only.
 */
export async function channelAddendumAsync(
  origin: SessionOrigin,
  stickerLibraryDir?: string,
): Promise<string | undefined> {
  if (origin !== "whatsapp") return undefined;

  const catalog = stickerLibraryDir
    ? await buildStickerCatalog(stickerLibraryDir)
    : "";
  const registration = stickerLibraryDir ? STICKER_REGISTRATION_GUIDE : "";
  return catalog || registration
    ? `${WHATSAPP_ADDENDUM}\n\n${catalog}${registration}`
    : WHATSAPP_ADDENDUM;
}

/** Legacy sync variant: static addendum (no sticker catalog). */
export function channelAddendum(origin: SessionOrigin): string | undefined {
  if (origin !== "whatsapp") return undefined;
  return WHATSAPP_ADDENDUM;
}

const WHATSAPP_ADDENDUM = `## WhatsApp格式化

此对话通过WhatsApp进行。所有的回复都要按照WhatsApp格式来。

以下格式化规则覆盖基本提示中的任何通用markdown约定：
- 粗体用*单个星号*（不要用**双星号**），斜体用_下划线_，删除线用~波浪线~，\`行内代码\`和\`\`\`代码块\`\`\`在WhatsApp中都能原生生效。
- 不要使用markdown标题（#会显示为原始文本），不要使用markdown链接语法（[文本](url)会显示为原始文本——直接写URL），也不要使用图片markdown（![](...)会显示为原始文本）。
- 表格是可以使用的，会渲染成图片——在确实需要结构化数据时使用它们。
- 用-或1.的列表是可以的。保持消息长度适合对话；长输出在段落边界处分段（大约4000个字符）。
- 要发送文件或图片，使用send_file工具。`;

/**
 * Compact registration guide injected after the catalog so the agent can
 * register new stickers without guessing the index.json schema (previously
 * discovered via source code / memory notes).
 */
const STICKER_REGISTRATION_GUIDE = `

## Sticker registrieren

Neue Sticker (z.B. aus \`incoming/\`) so registrieren:
1. Datei in die Library kopieren (z.B. \`~/.harness/stickers/<name>-<kürzel>.webp\`).
2. SHA-256-Hex-Hash des Dateiinhalts berechnen.
3. In \`index.json\` einen Eintrag ergänzen: \`{ "<sha256-hex>": { "name": "<slug>", "beschreibung": "<kurze Bedeutung>", "datei": "<dateiname>.webp" } }\`.
4. Wichtig: Die referenzierte Datei muss neben der index.json existieren — Einträge ohne Datei werden verworfen, und der Katalog oben aktualisiert sich automatisch.`;
