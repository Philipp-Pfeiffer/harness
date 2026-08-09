import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, RunResult, Model } from "@harness/core";
import { resolveHarnessPaths } from "@harness/core";
import type { Api } from "@mariozechner/pi-ai";
import { DaemonRuntime } from "../../src/daemon/runtime.js";
import { loadSession } from "../../src/core/session.js";
import type { ConfigModel } from "../../src/config.js";
import type { IpcRequest, IpcResponse } from "../../src/daemon/types.js";

const TEST_DIR = join(tmpdir(), `harness-modelref-${process.pid}-${Date.now()}`);

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
  } as unknown as Model<Api>;
}

function createFakeAgent(): Agent {
  return {
    setModel() {},
    setSystemPrompt() {},
    async run(): Promise<RunResult> {
      return {
        aborted: false,
        turns: 0,
        finalMessage: "ok",
        toolCallCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
      };
    },
  } as unknown as Agent;
}

const MODELS: ConfigModel[] = [
  { provider: "openai", model: "gpt-5.2", alias: "GPT 5.2" },
  { provider: "minimax", model: "MiniMax-M2.7", alias: "MiniMax M2.7" },
];

type RuntimeInternals = {
  agent: Agent;
  model: Model<Api>;
  configModels: ConfigModel[];
  memoryService: { degraded: boolean } | null;
  sessions: Map<string, { session: { model: string; modelRef?: string } }>;
  handleIpcRequest(req: IpcRequest, send?: (resp: IpcResponse) => void): Promise<IpcResponse>;
};

describe("modelRef persistence via /model", () => {
  it("writes modelRef to session meta on /model and restores it after a simulated restart", async () => {
    const runtime = new DaemonRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    internals.agent = createFakeAgent();
    internals.model = createFakeModel();
    internals.configModels = MODELS;

    // Create a session via the IPC path (normal daemon flow).
    const created = await internals.handleIpcRequest({ type: "create-session", origin: "api" });
    expect(created.type).toBe("session-created");
    if (created.type !== "session-created") return;
    const sessionId = created.sessionId;

    // /model <ref> — switch the model.
    const result = await runtime.handleChannelSlashCommand(sessionId, "/model MiniMax-M2.7");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("Model switched to");

    // Session meta contains modelRef.
    const entry = internals.sessions.get(sessionId);
    expect(entry?.session.modelRef).toBe("MiniMax-M2.7");

    // Simulated daemon restart: load the session from disk.
    const loaded = await loadSession(sessionId, resolveHarnessPaths());
    expect(loaded).not.toBeNull();
    expect(loaded!.session.modelRef).toBe("MiniMax-M2.7");
  });

  it("/new does not inherit the previous session's modelRef", async () => {
    const runtime = new DaemonRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    internals.agent = createFakeAgent();
    internals.model = createFakeModel();
    internals.configModels = MODELS;

    const created = await internals.handleIpcRequest({ type: "create-session", origin: "whatsapp" });
    expect(created.type).toBe("session-created");
    if (created.type !== "session-created") return;
    const sessionId = created.sessionId;

    await runtime.handleChannelSlashCommand(sessionId, "/model MiniMax-M2.7");
    const entry = internals.sessions.get(sessionId);
    expect(entry?.session.modelRef).toBe("MiniMax-M2.7");

    // /new — fresh session, no model inheritance.
    const fresh = await runtime.handleChannelSlashCommand(sessionId, "/new");
    expect(fresh).not.toBeNull();
    expect(fresh!.newSessionId).toBeDefined();
    const newEntry = internals.sessions.get(fresh!.newSessionId!);
    expect(newEntry?.session.modelRef).toBeUndefined();
  });
});

describe("resolveWhatsAppSession after daemon restart", () => {
  function makeRuntime() {
    const runtime = new DaemonRuntime();
    const internals = runtime as unknown as {
      agent: Agent;
      model: Model<Api>;
      configModels: ConfigModel[];
      sessions: Map<string, unknown>;
      whatsappSessions: Map<string, string>;
      whatsappSessionToSource: Map<string, string>;
      channelPlugins: Map<string, { sendMessage: (t: string, p: unknown) => Promise<void> }>;
    };
    internals.agent = createFakeAgent();
    internals.model = createFakeModel();
    internals.configModels = MODELS;
    return { runtime, internals };
  }

  /** Creates a persisted WhatsApp session via the IPC path and backdates its index entry. */
  async function createPersistedSession(
    runtime: DaemonRuntime,
    phone: string,
    lastActivity: string,
  ): Promise<string> {
    const created = await (runtime as unknown as {
      handleIpcRequest: (r: { type: "create-session"; origin: "whatsapp"; title?: string }) => Promise<{ type: string; sessionId?: string }>;
    }).handleIpcRequest({ type: "create-session", origin: "whatsapp", title: `WhatsApp: ${phone}` });
    if (created.type !== "session-created" || !created.sessionId) {
      throw new Error("session creation failed");
    }
    const sessionId = created.sessionId;

    // Backdate lastActivity in the index so the resolution sees the requested age.
    const indexPath = join(resolveHarnessPaths().sessions, "sessions.json");
    const index = JSON.parse(await readFile(indexPath, "utf-8")) as Array<{ sessionId: string; lastActivity: string }>;
    const entry = index.find((e) => e.sessionId === sessionId);
    if (!entry) throw new Error("session missing from index");
    entry.lastActivity = lastActivity;
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8");

    return sessionId;
  }

  it("returns rotated=true when the persisted session is older than 8h and sends the reset notice", async () => {
    const { runtime } = makeRuntime();
    const phone = "491701234567";
    await createPersistedSession(runtime, phone, new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString());

    // Fresh runtime with empty in-memory maps simulates the daemon restart.
    const { runtime: fresh, internals } = makeRuntime();
    const sendMock = vi.fn().mockResolvedValue(undefined);
    internals.channelPlugins.set("whatsapp", { sendMessage: sendMock });

    const resolved = await (fresh as unknown as {
      resolveWhatsAppSession: (s: string) => Promise<{ sessionId: string; rotated: boolean }>;
    }).resolveWhatsAppSession(phone);

    expect(resolved.rotated).toBe(true);
    expect(resolved.sessionId).not.toBe("");
    // Reset notice was sent for the new session.
    expect(sendMock).toHaveBeenCalledWith(
      `${phone}@s.whatsapp.net`,
      expect.objectContaining({ text: expect.stringContaining("Neue Session gestartet") }),
    );
    // Maps point at the new session.
    expect(internals.whatsappSessions.get(phone)).toBe(resolved.sessionId);
  });

  it("returns rotated=false when the persisted session is recent", async () => {
    const { runtime } = makeRuntime();
    const phone = "491701234567";
    const sessionId = await createPersistedSession(runtime, phone, new Date().toISOString());

    const { runtime: fresh } = makeRuntime();
    const resolved = await (fresh as unknown as {
      resolveWhatsAppSession: (s: string) => Promise<{ sessionId: string; rotated: boolean }>;
    }).resolveWhatsAppSession(phone);

    expect(resolved.rotated).toBe(false);
    expect(resolved.sessionId).toBe(sessionId);
  });
});

// Load the session meta from disk to verify the transcript also carries modelRef.
describe("modelRef in session meta record", () => {
  it("persists modelRef in the transcript meta record", async () => {
    const runtime = new DaemonRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    internals.agent = createFakeAgent();
    internals.model = createFakeModel();
    internals.configModels = MODELS;

    const created = await internals.handleIpcRequest({ type: "create-session", origin: "api" });
    expect(created.type).toBe("session-created");
    if (created.type !== "session-created") return;
    const sessionId = created.sessionId;

    await runtime.handleChannelSlashCommand(sessionId, "/model MiniMax-M2.7");

    const sessionsDir = join(process.env.HARNESS_STATE!, "sessions");
    const dateFolder = sessionId.slice(0, 4) + "-" + sessionId.slice(4, 6) + "-" + sessionId.slice(6, 8);
    const raw = await readFile(join(sessionsDir, dateFolder, `${sessionId}.jsonl`), "utf-8");
    const lines = raw.trim().split("\n");
    const meta = JSON.parse(lines[lines.length - 1]!) as { type?: string; modelRef?: string };
    expect(meta.type).toBe("session-meta");
    expect(meta.modelRef).toBe("MiniMax-M2.7");
  });
});

describe("/status memory display", () => {
  it("reports Memory: ready when the memory service is running and not degraded", async () => {
    const runtime = new DaemonRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    internals.agent = createFakeAgent();
    internals.model = createFakeModel();
    internals.configModels = MODELS;
    internals.memoryService = { degraded: false };

    const created = await internals.handleIpcRequest({ type: "create-session", origin: "api" });
    expect(created.type).toBe("session-created");
    if (created.type !== "session-created") return;

    const result = await runtime.handleChannelSlashCommand(created.sessionId, "/status");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("Memory:       ready");
  });

  it("reports Memory: n/a when the memory service is degraded", async () => {
    const runtime = new DaemonRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    internals.agent = createFakeAgent();
    internals.model = createFakeModel();
    internals.configModels = MODELS;
    internals.memoryService = { degraded: true };

    const created = await internals.handleIpcRequest({ type: "create-session", origin: "api" });
    expect(created.type).toBe("session-created");
    if (created.type !== "session-created") return;

    const result = await runtime.handleChannelSlashCommand(created.sessionId, "/status");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("Memory:       n/a");
  });
});
