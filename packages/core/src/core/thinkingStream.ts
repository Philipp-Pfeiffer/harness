/**
 * Inline `<think>…</think>` stream transformer.
 *
 * Some OpenAI-compatible endpoints (e.g. neuralwatt with kimi-k2.7-code)
 * deliver reasoning content not as a separate `reasoning_content` field
 * (which pi-ai would map to `thinking_start`/`thinking_delta`/`thinking_end`
 * events), but as inline `<think>…</think>` tags embedded in the
 * `text_delta` stream.
 *
 * This transformer sits between pi-ai's stream events and the agent's
 * `AgentEvent` emission. It detects `<think>` open and `</think>` close
 * tags—robustly across chunk boundaries—and routes the enclosed content
 * as `thinking` events instead of `token` events.
 *
 * Activation: per-model config flag `inlineThinking: true` on `ConfigModel`.
 */

// ─── Types ────────────────────────────────────────────────────────

/**
 * Output events from the transformer.
 * `token` = visible assistant text (no think tags).
 * `thinking` = reasoning content (inside `<think>…</think>`).
 */
export type ThinkingStreamOutput =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string };

// ─── State Machine ────────────────────────────────────────────────

/**
 * Tracks the parser state across chunks.
 *
 * The core difficulty: the `<think>` or `</think>` tag can be split
 * across two or more `text_delta` chunks. We handle this by buffering
 * a partial tag match at the boundary.
 *
 * States:
 * - `text`: outside a think block, emitting `token` events.
 * - `thinking`: inside a think block, emitting `thinking` events.
 * - `text_partial`: might be at the start of a `<think>` opening tag.
 * - `thinking_partial`: might be at the start of a `</think>` closing tag.
 */
type ParserState = "text" | "thinking" | "text_partial" | "thinking_partial";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * Find the longest prefix of `tag` that appears as a suffix of `text`.
 * Returns the length (0 = no match).
 *
 * Example: `text="hello<thi"`, `tag="<think>"` → returns 4 (`"<thi"`).
 */
function partialSuffix(text: string, tag: string): number {
  const maxLen = Math.min(text.length, tag.length - 1);
  for (let len = maxLen; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Try to complete a partial tag at the start of `chunk`.
 * Returns `{ consumed: number, matched: boolean }`.
 * `consumed` = how many characters of `chunk` were part of the tag.
 * `matched` = true if the full tag was consumed.
 */
function consumeTagFromStart(
  partialLen: number,
  chunk: string,
  tag: string,
): { consumed: number; matched: boolean } {
  const remaining = tag.length - partialLen;
  if (chunk.length >= remaining) {
    if (chunk.slice(0, remaining) === tag.slice(partialLen)) {
      return { consumed: remaining, matched: true };
    }
    return { consumed: 0, matched: false };
  }
  // chunk is shorter than the remaining tag
  if (chunk === tag.slice(partialLen, partialLen + chunk.length)) {
    return { consumed: chunk.length, matched: false };
  }
  return { consumed: 0, matched: false };
}

// ─── Transformer ──────────────────────────────────────────────────

export class ThinkingStreamTransformer {
  private state: ParserState = "text";
  /** Partial tag match accumulated at a chunk boundary. */
  private partialLen = 0;
  /** Accumulated partial tag text (for flushing on mismatch). */
  private partialText = "";
  /** Total length of all token text emitted during feed() this stream. */
  private streamedTokenTextLen = 0;
  /** Accumulated token text emitted during feed() (for re-emission as
   * thinking when reclassified at flush()). */
  private capturedTokenText = "";
  /** True if any explicit `<think>`/`</think>` tag was seen this stream. */
  private sawVisibleDelimiter = false;
  /** Set when the last flush() reclassified untagged reasoning — the
   * caller must rewind the token text already emitted during feed(). */
  private revokedTokenTextLen = 0;
  /** Reasoning-capable model: untagged text with no visible delimiter
   * is reclassified as thinking at flush(). */
  private readonly assumeUntaggedIsReasoning: boolean;

  constructor(assumeUntaggedIsReasoning = false) {
    this.assumeUntaggedIsReasoning = assumeUntaggedIsReasoning;
  }

  /**
   * Feed a chunk of text from the LLM stream.
   * Returns zero or more output events.
   *
   * The transformer is stateful — call this for each `text_delta`
   * in order.
   */
  feed(chunk: string): ThinkingStreamOutput[] {
    const outputs: ThinkingStreamOutput[] = [];
    let pos = 0;

    while (pos < chunk.length) {
      const remaining = chunk.slice(pos);

      switch (this.state) {
        case "text": {
          // Look for `<think>` in the remaining text.
          const idx = remaining.indexOf("<think>");
          if (idx === -1) {
            // Check for partial match at the end.
            const partial = partialSuffix(remaining, OPEN_TAG);
            if (partial > 0) {
              // Emit the safe prefix, buffer the partial.
              const safe = remaining.slice(0, remaining.length - partial);
              if (safe) {
                outputs.push({ type: "token", text: safe });
                this.streamedTokenTextLen += safe.length;
                this.capturedTokenText += safe;
              }
              this.partialText = remaining.slice(remaining.length - partial);
              this.partialLen = partial;
              this.state = "text_partial";
              pos = chunk.length;
            } else {
              // No match at all — emit everything.
              outputs.push({ type: "token", text: remaining });
              this.streamedTokenTextLen += remaining.length;
              this.capturedTokenText += remaining;
              pos = chunk.length;
            }
          } else {
            // Found the open tag. Emit text before it.
            if (idx > 0) {
              outputs.push({ type: "token", text: remaining.slice(0, idx) });
              this.streamedTokenTextLen += idx;
              this.capturedTokenText += remaining.slice(0, idx);
            }
            this.sawVisibleDelimiter = true;
            this.state = "thinking";
            pos += idx + OPEN_TAG.length;
          }
          break;
        }

        case "thinking": {
          // Look for `</think>` in the remaining text.
          const idx = remaining.indexOf("</think>");
          if (idx === -1) {
            // Check for partial match at the end.
            const partial = partialSuffix(remaining, CLOSE_TAG);
            if (partial > 0) {
              // Emit the safe prefix as thinking, buffer the partial.
              const safe = remaining.slice(0, remaining.length - partial);
              if (safe) outputs.push({ type: "thinking", text: safe });
              this.partialText = remaining.slice(remaining.length - partial);
              this.partialLen = partial;
              this.state = "thinking_partial";
              pos = chunk.length;
            } else {
              // No close tag — emit everything as thinking.
              outputs.push({ type: "thinking", text: remaining });
              pos = chunk.length;
            }
          } else {
            // Found the close tag. Emit thinking text before it.
            if (idx > 0) outputs.push({ type: "thinking", text: remaining.slice(0, idx) });
            this.sawVisibleDelimiter = true;
            this.state = "text";
            pos += idx + CLOSE_TAG.length;
          }
          break;
        }

        case "text_partial": {
          // We have a partial `<think>` match from the previous chunk.
          const result = consumeTagFromStart(this.partialLen, remaining, OPEN_TAG);
          if (result.matched) {
            this.state = "thinking";
            this.partialLen = 0;
            this.partialText = "";
            pos += result.consumed;
          } else if (result.consumed > 0) {
            // Still partial — wait for more data.
            pos += result.consumed;
            this.partialLen += result.consumed;
          } else {
            // Mismatch — flush the buffered partial as token text.
            if (this.partialText) {
              outputs.push({ type: "token", text: this.partialText });
              this.streamedTokenTextLen += this.partialText.length;
              this.capturedTokenText += this.partialText;
            }
            this.sawVisibleDelimiter = true;
            this.partialText = "";
            this.partialLen = 0;
            this.state = "text";
            // Don't advance pos — reprocess `remaining` from the start.
          }
          break;
        }

        case "thinking_partial": {
          // We have a partial `</think>` match from the previous chunk.
          const result = consumeTagFromStart(this.partialLen, remaining, CLOSE_TAG);
          if (result.matched) {
            this.state = "text";
            this.partialLen = 0;
            this.partialText = "";
            pos += result.consumed;
          } else if (result.consumed > 0) {
            // Still partial — wait for more data.
            pos += result.consumed;
            this.partialLen += result.consumed;
          } else {
            // Mismatch — flush the buffered partial as thinking text.
            if (this.partialText) outputs.push({ type: "thinking", text: this.partialText });
            this.partialText = "";
            this.partialLen = 0;
            this.state = "thinking";
            // Don't advance pos — reprocess `remaining` from the start.
          }
          break;
        }
      }
    }

    return outputs;
  }

  /**
   * Flush any remaining state at stream end.
   * If we're mid-think-block (unclosed), emit the accumulated content
   * as thinking. If we have a partial tag, emit it as the appropriate type.
   */
  flush(): ThinkingStreamOutput[] {
    const outputs: ThinkingStreamOutput[] = [];
    this.revokedTokenTextLen = 0;
    // Reasoning-capable models stream their reasoning as *untagged* text
    // (DeepSeek Pro via OpenRouter). If the whole stream contained no
    // visible-text delimiter (no `<think>` open, no `</think>` close,
    // no partial-tag mismatch), everything that passed through as "token"
    // is actually reasoning — reclassify it as thinking so it can never
    // leak into the visible assistant output.
    if (
      this.assumeUntaggedIsReasoning &&
      this.streamedTokenTextLen > 0 &&
      !this.sawVisibleDelimiter
    ) {
      // The feed()-emitted token text is revoked: the caller (agent.ts)
      // rewinds its partial accumulator and downstream listeners truncate
      // their progressive output by revokedTokenTextLength(). The
      // reasoning text itself is re-emitted as thinking events so it is
      // visible as reasoning (e.g. in the CLI), never as assistant text.
      const thinkingText = this.capturedTokenText;
      this.revokedTokenTextLen = this.streamedTokenTextLen;
      outputs.push({ type: "thinking", text: thinkingText });
    }
    if (this.partialText) {
      const type: "token" | "thinking" =
        this.state === "thinking_partial" ? "thinking" : "token";
      outputs.push({ type, text: this.partialText });
      this.partialText = "";
      this.partialLen = 0;
    }
    this.streamedTokenTextLen = 0;
    this.capturedTokenText = "";
    // Reset to text state — no dangling think blocks.
    this.state = "text";
    return outputs;
  }

  /** Length of token text emitted during feed() that flush() has since
   * reclassified as thinking. The caller (agent.ts) rewinds its partial
   * text accumulator by this amount so the reasoning never becomes part
   * of the visible assistant output. Valid only after a flush() call. */
  revokedTokenTextLength(): number {
    return this.revokedTokenTextLen;
  }

  /** Whether the transformer is currently inside a think block. */
  get isThinking(): boolean {
    return this.state === "thinking" || this.state === "thinking_partial";
  }
}
