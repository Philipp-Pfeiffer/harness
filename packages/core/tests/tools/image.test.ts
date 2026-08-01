import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { complete } from "@mariozechner/pi-ai";
import { createImageTool } from "../../src/tools/image.js";

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    complete: vi.fn(),
  };
});

const visionModels = [{
  provider: "openrouter",
  model: "@preset/vision",
  alias: "Vision",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-test",
  input: ["text", "image"] as ("text" | "image")[],
}];

function mockVisionResponse(text: string) {
  vi.mocked(complete).mockResolvedValueOnce({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openrouter",
    model: "@preset/vision",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

describe("image tool", () => {
  let mediaDir: string;

  beforeEach(async () => {
    mediaDir = join(tmpdir(), `harness-image-test-${Date.now()}`);
    await mkdir(mediaDir, { recursive: true });
    vi.mocked(complete).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("analyzes a local image file via the vision model", async () => {
    const imagePath = join(mediaDir, "duck.png");
    // Minimal valid 1x1 PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(imagePath, png);

    mockVisionResponse("One yellow duck on a pond.");

    const tool = createImageTool({ models: visionModels });
    const result = await tool.execute({
      url: imagePath,
      prompt: "How many ducks are in this image?",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("<image_analysis");
    expect(result.content).toContain("One yellow duck on a pond.");
    expect(complete).toHaveBeenCalledOnce();

    const [, context] = vi.mocked(complete).mock.calls[0]!;
    const userMessage = context.messages[0];
    expect(userMessage?.role).toBe("user");
    expect(Array.isArray(userMessage?.content)).toBe(true);
    const blocks = userMessage?.content as Array<{ type: string; text?: string }>;
    expect(blocks[0]).toEqual({ type: "text", text: "How many ducks are in this image?" });
    expect(blocks[1]?.type).toBe("image");
  });

  it("returns error for missing local files", async () => {
    const tool = createImageTool({ models: visionModels });
    const result = await tool.execute({ url: join(mediaDir, "missing.png") });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("File not found");
    expect(complete).not.toHaveBeenCalled();
  });

  it("fetches remote image URLs", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "image/png" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(png);
          controller.close();
        },
      }),
    } as Response);

    mockVisionResponse("A tiny placeholder image.");

    const tool = createImageTool({ models: visionModels });
    const result = await tool.execute({
      url: "https://example.com/photo.png",
      prompt: "Describe this image.",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("A tiny placeholder image.");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("is registered when models are passed to loadTools", async () => {
    const { loadTools } = await import("../../src/tools/registry.js");
    const tools = loadTools({ image: { models: visionModels } });
    expect(tools.some((t) => t.name === "image")).toBe(true);
  });
});
