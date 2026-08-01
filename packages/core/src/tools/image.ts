import { Type } from "@sinclair/typebox";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import { complete } from "@mariozechner/pi-ai";
import type { Context as PiContext } from "@mariozechner/pi-ai";
import type { Tool, ToolCallContext } from "./types.js";
import { ok, err } from "./types.js";
import type { ConfigModel, ImageConfig, WebConfig } from "../config.js";
import { getApiKey } from "../core/resolveModel.js";
import { resolveImageConfig, resolveImageModel } from "../image/config.js";
import { detectMimeFromExtension } from "./send_file.js";
import { validateUrl, WebSecurityError, createSecureDispatcher } from "./webSecurity.js";
import type { Dispatcher } from "undici";

const ImageArgs = Type.Object({
  url: Type.String({
    minLength: 1,
    description:
      "Image URL (http/https) or local file path (e.g. from WhatsApp inbound-media/).",
  }),
  prompt: Type.Optional(Type.String({
    description:
      "Question or instruction about the image. Defaults to a detailed description.",
  })),
});

const DEFAULT_PROMPT = "Describe this image in detail.";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const USER_AGENT = "harness-image/0.0.1";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

function expandTilde(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return path.replace(/^~/, homedir());
  }
  return path;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/");
}

function assertImageMimeType(mimeType: string, source: string): void {
  if (!isImageMimeType(mimeType)) {
    throw new Error(`Not an image (${mimeType}): ${source}`);
  }
}

async function readLocalImage(source: string): Promise<{ mimeType: string; data: string; resolvedPath: string }> {
  const expanded = expandTilde(source);
  const resolvedPath = resolve(expanded);

  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    throw new Error(`File not found: ${resolvedPath}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`Path is not a file: ${resolvedPath}`);
  }
  if (fileStat.size > DEFAULT_MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds maximum size of ${DEFAULT_MAX_IMAGE_BYTES} bytes`);
  }

  const ext = extname(resolvedPath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported image extension "${ext || "(none)"}" for ${resolvedPath}`);
  }

  const mimeType = detectMimeFromExtension(resolvedPath);
  assertImageMimeType(mimeType, resolvedPath);

  const buffer = await readFile(resolvedPath);
  return { mimeType, data: buffer.toString("base64"), resolvedPath };
}

async function fetchRemoteImage(
  rawUrl: string,
  webConfig: WebConfig | undefined,
  dispatcher: Dispatcher,
): Promise<{ mimeType: string; data: string }> {
  await validateUrl(rawUrl, { allowlist: webConfig?.web_fetch?.allowlist });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(rawUrl, {
      method: "GET",
      headers: {
        Accept: "image/*",
        "User-Agent": USER_AGENT,
      },
      redirect: "follow",
      signal: controller.signal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dispatcher,
    } as any);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof Error && e.name === "AbortError") {
      throw new WebSecurityError(`Request timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    throw new WebSecurityError(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new WebSecurityError(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!contentType || !isImageMimeType(contentType)) {
    throw new Error(`URL did not return an image (content-type: ${contentType || "unknown"})`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new WebSecurityError("Response body is not readable");
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalSize += value.length;
        if (totalSize > DEFAULT_MAX_IMAGE_BYTES) {
          throw new WebSecurityError(`Image exceeds maximum size of ${DEFAULT_MAX_IMAGE_BYTES} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { mimeType: contentType, data: buffer.toString("base64") };
}

function extractAssistantText(response: Awaited<ReturnType<typeof complete>>): string {
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? "Vision model request failed");
  }
  return response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export interface CreateImageToolOptions {
  imageConfig?: ImageConfig;
  defaultModel?: ConfigModel;
  models?: ConfigModel[];
  webConfig?: WebConfig;
}

export function createImageTool(opts: CreateImageToolOptions): Tool<typeof ImageArgs> {
  const resolved = resolveImageConfig(opts.imageConfig);
  const dispatcher = createSecureDispatcher({ allowlist: opts.webConfig?.web_fetch?.allowlist });

  return {
    name: "image",
    description:
      "Analyze an image using a dedicated vision model (OpenRouter preset). " +
      "Use when the main model cannot see images (e.g. DeepSeek) or when the user " +
      "sends a picture via WhatsApp — pass the local file path from the attachment annotation. " +
      "Provide a specific prompt to count objects, read text, or answer questions about the image.",
    parameters: ImageArgs,
    async execute(args, context?: ToolCallContext) {
      const userPrompt = args.prompt?.trim() || DEFAULT_PROMPT;
      let sourceLabel = args.url;

      try {
        let image: { mimeType: string; data: string };
        if (isHttpUrl(args.url)) {
          image = await fetchRemoteImage(args.url, opts.webConfig, dispatcher);
        } else {
          const local = await readLocalImage(args.url);
          sourceLabel = local.resolvedPath;
          image = local;
        }

        const model = resolveImageModel(resolved.model, opts.models);
        if (!model.input.includes("image")) {
          return err(
            `Vision model "${resolved.model}" does not accept image input. ` +
            `Set input: ["text", "image"] on the model in config.json.`,
          );
        }

        const piContext: PiContext = {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              { type: "image", mimeType: image.mimeType, data: image.data },
            ],
            timestamp: Date.now(),
          }],
        };

        const response = await complete(model, piContext, {
          apiKey: getApiKey(model),
          maxTokens: resolved.maxTokens,
          signal: context?.signal,
        });

        const analysis = extractAssistantText(response);
        if (!analysis) {
          return err(`<image_analysis source="${sourceLabel}">\nVision model returned empty response.\n</image_analysis>`);
        }

        return ok(`<image_analysis source="${sourceLabel}">\n${analysis}\n</image_analysis>`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(`<image_analysis source="${sourceLabel}">\nimage tool failed: ${message}\n</image_analysis>`);
      }
    },
  };
}
