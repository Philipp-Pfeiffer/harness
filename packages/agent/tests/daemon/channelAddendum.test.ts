import { describe, it, expect } from "vitest";
import { channelAddendum } from "../../src/daemon/channelAddendum.js";
import type { SessionOrigin } from "../../src/core/session.js";

describe("channelAddendum", () => {
  it("returns a non-null string for the whatsapp origin", () => {
    const text = channelAddendum("whatsapp");
    expect(text).toBeTypeOf("string");
    expect((text as string).length).toBeGreaterThan(0);
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
