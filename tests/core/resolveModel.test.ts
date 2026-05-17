import { describe, it, expect } from "vitest";
import { resolveModel } from "../../src/core/resolveModel.js";

describe("resolveModel", () => {
  it("returns a model for a known provider and model", () => {
    const model = resolveModel("minimax", "MiniMax-M2.7");
    expect(model).toBeDefined();
    expect(model.id).toBe("MiniMax-M2.7");
    expect(model.provider).toBe("minimax");
  });

  it("throws a clear error for an unknown provider", () => {
    expect(() => resolveModel("unknown-provider", "some-model")).toThrow(
      /Unknown provider 'unknown-provider'\. Known providers:/,
    );
  });

  it("throws a clear error for an unknown model on a known provider", () => {
    expect(() => resolveModel("minimax", "unknown-model")).toThrow(
      /Unknown model 'unknown-model' for provider 'minimax'\. Known models:/,
    );
  });
});
