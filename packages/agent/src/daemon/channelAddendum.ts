import type { SessionOrigin } from "../core/session.js";

/**
 * Channel-specific system-prompt addendum.
 *
 * A pure function of the session origin: "whatsapp" returns a static
 * markdown block, every other origin returns null (no addendum). The text
 * is constant per session because the origin is fixed at session creation
 * and persisted — this keeps the effective system prompt byte-identical
 * across turns and daemon restarts (required for prompt caching).
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
