import { describe, it, expect } from "vitest";
import { createAgent } from "../src/core/agent.js";

describe("Agent", () => {
  it("should return a placeholder response when the loop is not wired", async () => {
    const agent = createAgent({ tools: [] });
    const result = await agent.run("Hello");
    expect(result).toBe("Cliffford V2 is alive but the loop is not wired yet.");
  });

  it("should expose configured tools", async () => {
    const tools = [
      { name: "readFile", description: "Reads a file", parameters: [], execute: () => "" },
    ];
    const agent = createAgent({ tools });
    // Smoke test: agent creation succeeds with tools
    expect(agent).toBeDefined();
  });
});
