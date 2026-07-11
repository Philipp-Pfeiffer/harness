import { describe, it, expect } from "vitest";
import { StubBackend } from "../../src/core/stubBackend.js";

describe("StubBackend", () => {
  it("name is 'stub'", () => {
    const backend = new StubBackend();
    expect(backend.name).toBe("stub");
  });

  it("search returns empty array", async () => {
    const backend = new StubBackend();
    const hits = await backend.search("anything");
    expect(hits).toEqual([]);
  });

  it("query returns empty array", async () => {
    const backend = new StubBackend();
    const hits = await backend.query("anything");
    expect(hits).toEqual([]);
  });

  it("getAmbientHints returns empty array", async () => {
    const backend = new StubBackend();
    const hints = await backend.getAmbientHints("anything");
    expect(hints).toEqual([]);
  });

  it("write does not throw", async () => {
    const backend = new StubBackend();
    await expect(backend.write({ path: "/tmp/x.md", content: "y" })).resolves.toBeUndefined();
  });
});
