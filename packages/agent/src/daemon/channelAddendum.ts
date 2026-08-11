import type { SessionOrigin } from "../core/session.js";

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
