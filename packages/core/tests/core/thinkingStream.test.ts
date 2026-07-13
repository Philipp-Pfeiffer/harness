import { describe, it, expect } from "vitest";
import { ThinkingStreamTransformer } from "../../src/core/thinkingStream.js";

// Build tag strings without writing literal tags that editors might mangle.
const OPEN = "<think>";
const CLOSE = "</think>";

function feedAll(
  transformer: ThinkingStreamTransformer,
  chunks: string[],
) {
  const results: { type: "token" | "thinking"; text: string }[] = [];
  for (const chunk of chunks) {
    results.push(...transformer.feed(chunk));
  }
  results.push(...transformer.flush());
  return results;
}

function collect(
  events: { type: "token" | "thinking"; text: string }[],
  type: "token" | "thinking",
): string {
  return events
    .filter((e) => e.type === type)
    .map((e) => e.text)
    .join("");
}

describe("ThinkingStreamTransformer", () => {
  it("passes through plain text with no think tags", () => {
    const t = new ThinkingStreamTransformer();
    const out = feedAll(t, ["Hello, world!"]);
    expect(collect(out, "token")).toBe("Hello, world!");
    expect(collect(out, "thinking")).toBe("");
  });

  it("routes a simple think block as thinking", () => {
    const t = new ThinkingStreamTransformer();
    const input = "before " + OPEN + "inner content" + CLOSE + " after";
    const out = feedAll(t, [input]);
    expect(collect(out, "token")).toBe("before  after");
    expect(collect(out, "thinking")).toBe("inner content");
  });

  it("handles think block at stream start", () => {
    const t = new ThinkingStreamTransformer();
    const input = OPEN + "reasoning here" + CLOSE + "visible answer";
    const out = feedAll(t, [input]);
    expect(collect(out, "token")).toBe("visible answer");
    expect(collect(out, "thinking")).toBe("reasoning here");
  });

  it("handles multiple think blocks in one stream", () => {
    const t = new ThinkingStreamTransformer();
    const input =
      "a" + OPEN + "b1" + CLOSE + "c" + OPEN + "b2" + CLOSE + "d";
    const out = feedAll(t, [input]);
    expect(collect(out, "token")).toBe("acd");
    expect(collect(out, "thinking")).toBe("b1b2");
  });

  it("splits open tag across chunk boundary", () => {
    const t = new ThinkingStreamTransformer();
    const chunks = [
      "text before " + OPEN.slice(0, 3),
      OPEN.slice(3) + "thinking content" + CLOSE + " text after",
    ];
    const out = feedAll(t, chunks);
    expect(collect(out, "token")).toBe("text before  text after");
    expect(collect(out, "thinking")).toBe("thinking content");
  });

  it("splits close tag across chunk boundary", () => {
    const t = new ThinkingStreamTransformer();
    const chunks = [
      "prefix " + OPEN + "think text" + CLOSE.slice(0, 4),
      CLOSE.slice(4) + " suffix",
    ];
    const out = feedAll(t, chunks);
    expect(collect(out, "token")).toBe("prefix  suffix");
    expect(collect(out, "thinking")).toBe("think text");
  });

  it("splits both open and close tags across boundaries", () => {
    const t = new ThinkingStreamTransformer();
    const chunks = [
      "x" + OPEN.slice(0, 2),
      OPEN.slice(2) + "inner" + CLOSE.slice(0, 3),
      CLOSE.slice(3) + "y",
    ];
    const out = feedAll(t, chunks);
    expect(collect(out, "token")).toBe("xy");
    expect(collect(out, "thinking")).toBe("inner");
  });

  it("handles unclosed think block (flush emits as thinking)", () => {
    const t = new ThinkingStreamTransformer();
    const input = "text " + OPEN + "unfinished thinking";
    const out = feedAll(t, [input]);
    expect(collect(out, "token")).toBe("text ");
    expect(collect(out, "thinking")).toBe("unfinished thinking");
  });

  it("handles partial open tag that turns out to be plain text", () => {
    const t = new ThinkingStreamTransformer();
    // "<th" + "i" is not the start of "<think>" — it's just literal text
    const chunks = ["hello <thi", "s is text"];
    const out = feedAll(t, chunks);
    expect(collect(out, "token")).toBe("hello <this is text");
    expect(collect(out, "thinking")).toBe("");
  });

  it("handles partial close tag that turns out to be plain text", () => {
    const t = new ThinkingStreamTransformer();
    // Inside a think block, "</thi" followed by "s" is not "</think>"
    const chunks = [
      OPEN + "thinking about </thi", "s is not closing" + CLOSE + " visible",
    ];
    const out = feedAll(t, chunks);
    expect(collect(out, "token")).toBe(" visible");
    expect(collect(out, "thinking")).toBe("thinking about </this is not closing");
  });

  it("handles empty think block", () => {
    const t = new ThinkingStreamTransformer();
    const input = "before" + OPEN + CLOSE + "after";
    const out = feedAll(t, [input]);
    expect(collect(out, "token")).toBe("beforeafter");
    expect(collect(out, "thinking")).toBe("");
  });

  it("handles think block at stream end", () => {
    const t = new ThinkingStreamTransformer();
    const input = "visible text" + OPEN + "end thinking" + CLOSE;
    const out = feedAll(t, [input]);
    expect(collect(out, "token")).toBe("visible text");
    expect(collect(out, "thinking")).toBe("end thinking");
  });

  it("handles single-character chunks", () => {
    const t = new ThinkingStreamTransformer();
    const input = "a" + OPEN + "b" + CLOSE + "c";
    const chunks = input.split("");
    const out = feedAll(t, chunks);
    expect(collect(out, "token")).toBe("ac");
    expect(collect(out, "thinking")).toBe("b");
  });

  it("handles nested open tag as thinking text (first close ends block)", () => {
    const t = new ThinkingStreamTransformer();
    const input = OPEN + "outer " + OPEN + "inner" + CLOSE + "trailing" + CLOSE + "visible";
    const out = feedAll(t, [input]);
    // First CLOSE ends the think block. Inner OPEN is thinking text.
    // "trailing" + CLOSE is now visible text (the extra CLOSE is literal).
    expect(collect(out, "token")).toBe("trailing" + CLOSE + "visible");
    expect(collect(out, "thinking")).toBe("outer " + OPEN + "inner");
  });
});
