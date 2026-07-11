import { describe, it, expect } from "vitest";
import {
  resolveModel,
  resolveModelFromConfig,
  getApiKey,
} from "../../src/core/resolveModel.js";

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

describe("resolveModelFromConfig", () => {
  it("resolves a known provider/model without custom endpoint", () => {
    const model = resolveModelFromConfig({
      provider: "minimax",
      model: "MiniMax-M2.7",
      alias: "MiniMax M2.7",
    });
    expect(model.provider).toBe("minimax");
    expect(getApiKey(model)).toBeUndefined();
  });

  it("builds a custom OpenAI-compatible model for unknown providers with baseUrl", () => {
    const model = resolveModelFromConfig({
      provider: "neuralwatt",
      model: "kimi-k2.7-code",
      alias: "Kimi K2.7 Code",
      api: "openai-completions",
      baseUrl: "https://api.neuralwatt.com/v1",
      apiKey: "sk-test",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262000,
      maxTokens: 8192,
    });

    expect(model.id).toBe("kimi-k2.7-code");
    expect(model.provider).toBe("neuralwatt");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://api.neuralwatt.com/v1");
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.contextWindow).toBe(262000);
    expect(model.maxTokens).toBe(8192);
    expect(getApiKey(model)).toBe("sk-test");
  });

  it("throws when a custom provider has no baseUrl", () => {
    expect(() =>
      resolveModelFromConfig({
        provider: "neuralwatt",
        model: "kimi-k2.7-code",
        alias: "Kimi K2.7 Code",
      }),
    ).toThrow(/Custom provider 'neuralwatt' requires a baseUrl/);
  });

  it("throws for unsupported custom api types", () => {
    expect(() =>
      resolveModelFromConfig({
        provider: "neuralwatt",
        model: "kimi-k2.7-code",
        alias: "Kimi K2.7 Code",
        baseUrl: "https://api.neuralwatt.com/v1",
        // @ts-expect-value unsupported api value for test
        api: "anthropic-messages",
      }),
    ).toThrow(/Unsupported api 'anthropic-messages'/);
  });
});
