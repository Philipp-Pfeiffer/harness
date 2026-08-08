import { describe, it, expect } from "vitest";
import { channelAddendum } from "../../src/daemon/channelAddendum.js";
import type { SessionOrigin } from "../../src/core/session.js";

describe("channelAddendum", () => {
  it("returns a WhatsApp formatting block for the whatsapp origin", () => {
    const text = channelAddendum("whatsapp");
    expect(text).not.toBeNull();
    expect(text).toContain("## WhatsApp formatting");
    // Single-asterisk bold — and explicitly NOT double-asterisk bold
    expect(text).toContain("*single asterisks*");
    expect(text).toContain("NOT **double**");
    // Headings are not supported (raw #)
    expect(text).toContain("# renders as raw text");
    // Tables are allowed and rendered as images
    expect(text).toContain("Tables are allowed");
    expect(text).toContain("rendered as images");
    // Files/images go through send_file
    expect(text).toContain("send_file");
    // Addendum must be byte-stable (pure function — same input, same output)
    expect(channelAddendum("whatsapp")).toBe(text);
  });

  it.each<SessionOrigin>(["tui", "cron", "api"])(
    "returns undefined for the %s origin (no addendum)",
    (origin) => {
      expect(channelAddendum(origin)).toBeUndefined();
    },
  );
});
