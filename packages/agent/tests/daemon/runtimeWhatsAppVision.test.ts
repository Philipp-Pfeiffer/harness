/**
 * WhatsApp Vision Inline-Image Tests.
 *
 * Verifies the per-session vision decision in submitWhatsAppTurn:
 * - A session on a vision-capable model receives inbound images as inline
 *   pi-ai ImageContent blocks ({ type: "image", data, mimeType }).
 * - A session on a non-vision model does NOT get inline blocks; instead the
 *   turn text carries the image-tool fallback hint.
 *
 * The capability comes from the model config (input / supportsVision), not
 * from hardcoded model names.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, RunResult, Model, HarnessPaths } from "@harness/core";
import { DaemonRuntime } from "../../src/daemon/runtime.js";
import { resolveHarnessPaths } from "@harness/core";
import { createSession } from "../../src/core/session.js";

const TEST_DIR = join(tmpdir(), `harness-wa-vision-${process.pid}-${Date.now()}`);

let savedHome: string | undefined;
let savedState: string | undefined;

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(join(TEST_DIR, "state", "logs"), { recursive: true });
  savedHome = process.env.HARNESS_HOME;
  savedState = process.env.HARNESS_STATE;
  process.env.HARNESS_HOME = join(TEST_DIR, "home");
  process.env.HARNESS_STATE = join(TEST_DIR, "state");
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHome;
  if (savedState === undefined) delete process.env.HARNESS_STATE;
  else process.env.HARNESS_STATE = savedState;
  await rm(TEST_DIR, { recursive: true, force: true });
});

function createFakeModel(): Model<Api> {
  return {
    name: "fake-default",
    id: "fake-default-id",
    provider: "fake",
    setApiKey() {},
    input: ["text"],
  } as unknown as Model<Api>;
}

const MODELS: ConfigModel[] = [
  { provider: "openai", model: "deepseek-flash", alias: "DeepSeek Flash", keyword: "flash", input: ["text"] },
  {
    provider: "openrouter",
    model: "@preset/vision",
    alias: "Vision",
    keyword: "vision",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-test",
    input: ["text", "image"],
    supportsVision: true,
  },
];

const IMAGE_BLOCK: InboundImageBlock = {
  mimeType: "image/jpeg",
  data: Buffer.from("fake-image-data"),
  filePath: "/tmp/inbound-media/photo.jpg",
};

const imageBlockFactory = (): InboundImageBlock => ({
  mimeType: "image/jpeg",
  data: Buffer.from("fake-image-data"),
  filePath: "/tmp/inbound-media/photo.jpg",
});

type SessionEntry = {
  session: { id: string; transcriptPath: string; model?: string; modelRef?: string; createdAt?: string; lastActivityAt?: string };
  messages: Message[];
  modelRef?: string;
  turnsCompleted: number;
  metricsRecorder: { recordTurn(): void; recordToolCall(): void; recordRetry(): void };
  origin: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  profile: string;
  mailbox: { push(): void; drainAll(): [] };
  turnQueue: Promise<unknown>;
};

type RuntimeInternals = {
  agent: Agent;
  model: Model<Api>;
  configModels: unknown[];
  paths: HarnessPaths;
  sessions: Map<string, SessionEntry>;
  whatsappSessionToSource: Map<string, string>;
  whatsappSessions: Map<string, string>;
  submitWhatsAppTurn: (sessionId: string, text: string, imageBlocks?: InboundImageBlock[]) => Promise<{ finalResponse: string }>;
};

async function makeRuntime(modelRef: string | undefined): Promise<{ internals: RuntimeInternals; sessionId: string }> {
  const runtime = new DaemonRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  internals.agent = {
    setModel() {},
    setSystemPrompt() {},
    async run(): Promise<RunResult> {
      return {
        aborted: false,
        turns: 1,
        finalMessage: "Finale Antwort",
        toolCallCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
      };
    },
  } as unknown as Agent;
  internals.model = createFakeModel();
  internals.configModels = MODELS;
  internals.paths = resolveHarnessPaths();

  const session = await createSession(internals.paths, {
    model: modelRef ?? "fake-default",
    title: "WhatsApp: 491701234567",
    origin: "whatsapp",
    modelRef,
  });
  internals.sessions.set(session.id, {
    session,
    modelRef,
    messages: [],
    turnsCompleted: 0,
    metricsRecorder: { recordTurn() {}, recordToolCall() {}, recordRetry() {} },
    origin: "whatsapp",
    title: "WhatsApp: 491701234567",
    createdAt: session.createdAt ?? new Date().toISOString(),
    lastActiveAt: session.lastActivityAt ?? new Date().toISOString(),
    profile: "default",
    mailbox: { push() {}, drainAll: () => [] },
    turnQueue: Promise.resolve(),
  });

  const sessionEntry = internals.sessions.get(session.id)!;
  sessionEntry.session.model = "vision";
  sessionEntry.modelRef = modelRef;

  return { internals, sessionId: session.id };
}

describe("WhatsApp vision inline images", () => {
  it("inlines image content blocks when the session model is vision-capable", async () => {
    const { internals, sessionId } = await makeRuntime("vision");

    await internals.submitWhatsAppTurn(sessionId, "Schau dir das an", [imageBlockFactory()]);

    const entry = internals.sessions.get(sessionId)!;
    const userMessage = entry.messages[0]!;
    expect(userMessage.role).toBe("user");
    expect(Array.isArray(userMessage.content)).toBe(true);
    const blocks = userMessage.content as Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
    expect(blocks[0]).toEqual({
      type: "text",
      text: "Schau dir das an\nDu siehst das angehängte Bild direkt — kein image-Tool nötig.",
    });
    expect(blocks[1]).toEqual({
      type: "image",
      data: IMAGE_BLOCK.data.toString("base64"),
      mimeType: "image/jpeg",
    });
  });

  it("does NOT inline image blocks and appends the image-tool hint for non-vision sessions", async () => {
    const { internals, sessionId } = await makeRuntime(undefined);

    await internals.submitWhatsAppTurn(sessionId, "Schau dir das an", [imageBlockFactory()]);

    const entry = internals.sessions.get(sessionId)!;
    const userMessage = entry.messages[0]!;
    expect(userMessage.role).toBe("user");
    expect(typeof userMessage.content).toBe("string");
    const text = userMessage.content as string;
    expect(text).toContain("Schau dir das an");
    expect(text).toContain('image-Tool mit url="/tmp/inbound-media/photo.jpg"');
  });

  it("treats a session explicitly switched to a vision model as vision-capable", async () => {
    const { internals, sessionId } = await makeRuntime("@preset/vision");

    await internals.submitWhatsAppTurn(sessionId, "Was ist drauf?", [imageBlockFactory()]);

    const entry = internals.sessions.get(sessionId)!;
    const blocks = entry.messages[0]!.content as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === "image")).toBe(true);
  });
});
