import { describe, it, expect } from "vitest";
import { createContext, addMessage } from "../src/core/context.js";

describe("Context", () => {
  it("should start with a system message when provided", () => {
    const ctx = createContext("You are a test agent.");
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].role).toBe("system");
  });

  it("should add user messages", () => {
    const ctx = createContext();
    addMessage(ctx, { role: "user", content: "Hello" });
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].role).toBe("user");
  });
});
