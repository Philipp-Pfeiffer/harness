import { describe, it, expect } from "vitest";
import { echoTool } from "../src/tools/echo.js";

describe("echoTool", () => {
  it("returns the passed text", async () => {
    const result = await Promise.resolve(echoTool.execute({ text: "Hello" }));
    expect(result).toBe("Hello");
  });

  it("returns any string unchanged", async () => {
    const result = await Promise.resolve(echoTool.execute({ text: "MiniMax funktioniert!" }));
    expect(result).toBe("MiniMax funktioniert!");
  });

  it("has correct metadata", () => {
    expect(echoTool.name).toBe("echo");
    expect(echoTool.description).toBeTruthy();
  });
});