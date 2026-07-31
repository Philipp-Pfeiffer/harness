import { describe, it, expect } from "vitest";
import { buildSnapshotMarkdown, wrapUntrusted } from "../../src/browser/snapshot.js";

describe("buildSnapshotMarkdown", () => {
  it("formats refs and truncates to token cap", () => {
    const nodes = [
      { ref: 1, tag: "a", role: "link", name: "Login", selector: '[data-harness-ref="1"]', text: "Login" },
      { ref: 2, tag: "h1", role: "heading", name: "Welcome", selector: '[data-harness-ref="2"]', text: "Welcome" },
    ];
    const result = buildSnapshotMarkdown("https://example.com", "Example", nodes, 10_000);
    expect(result.markdown).toContain('[1] link "Login"');
    expect(result.markdown).toContain('[2] heading "Welcome"');
    expect(result.refs.get(1)?.selector).toBe('[data-harness-ref="1"]');
    expect(result.truncated).toBe(false);
  });

  it("wraps untrusted content in delimiters", () => {
    const wrapped = wrapUntrusted("page text");
    expect(wrapped).toContain("<untrusted_page_content>");
    expect(wrapped).toContain("page text");
  });
});
