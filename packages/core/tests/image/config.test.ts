import { describe, it, expect } from "vitest";
import {
  resolveImageConfig,
  resolveImageModel,
  DEFAULT_IMAGE_MODEL,
} from "../../src/image/config.js";

describe("resolveImageConfig", () => {
  it("defaults to @preset/vision", () => {
    const config = resolveImageConfig(undefined);
    expect(config.model).toBe(DEFAULT_IMAGE_MODEL);
    expect(config.maxTokens).toBe(4096);
  });

  it("respects explicit overrides", () => {
    const config = resolveImageConfig({ model: "@preset/custom-vision", maxTokens: 2048 });
    expect(config.model).toBe("@preset/custom-vision");
    expect(config.maxTokens).toBe(2048);
  });
});

describe("resolveImageModel", () => {
  it("passes through OpenRouter @preset refs unchanged", () => {
    const model = resolveImageModel("@preset/vision", [{
      provider: "openrouter",
      model: "@preset/vision",
      alias: "Vision",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      input: ["text", "image"],
    }]);

    expect(model.id).toBe("@preset/vision");
    expect(model.provider).toBe("openrouter");
    expect(model.input).toEqual(["text", "image"]);
  });

  it("throws for unknown @preset refs", () => {
    expect(() => resolveImageModel("@preset/missing")).toThrow(/Unknown OpenRouter preset/);
  });
});
