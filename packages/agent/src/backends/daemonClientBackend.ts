import { resolveHarnessPaths, type HarnessPaths } from "@harness/core";
import { sendIpcRequest, sendIpcStreaming, SUBMIT_TURN_IPC_TIMEOUT_MS } from "../daemon/ipc.js";
import type {
  IpcResponse,
  SessionSummary,
  TurnStreamEvent,
} from "../daemon/types.js";
import { loadSession } from "../core/session.js";
import type {
  AgentBackend,
  BackendEvent,
  CreateSessionOpts,
  SessionData,
  TurnResult,
  RunTurnOpts,
} from "./types.js";

/**
 * AgentBackend that delegates all execution to the daemon via IPC.
 * The daemon maintains the session context, runs the agent loop, and
 * streams events back over the Unix socket.
 *
 * Session history for display is loaded from disk via loadSession(),
 * which reads the same transcript files the daemon writes to.
 */
export class DaemonClientBackend implements AgentBackend {
  readonly name = "daemon";
  readonly supportsModelSwitching = true;

  private readonly socketPath: string;
  private readonly paths: HarnessPaths;

  constructor(opts?: { socketPath?: string; paths?: HarnessPaths }) {
    this.paths = opts?.paths ?? resolveHarnessPaths();
    this.socketPath = opts?.socketPath ?? this.paths.socketFile;
  }

  async createSession(opts?: CreateSessionOpts): Promise<{ sessionId: string }> {
    const resp = await sendIpcRequest(this.socketPath, {
      type: "create-session",
      origin: "tui",
      title: opts?.title,
      model: opts?.model,
    }, 10_000);

    if (resp.type === "session-created") {
      return { sessionId: resp.sessionId };
    }
    throw new Error(
      resp.type === "error"
        ? resp.message
        : `Unexpected response: ${resp.type}`,
    );
  }

  async resumeSession(sessionId: string): Promise<SessionData> {
    // Tell the daemon to load the session into memory
    const resp = await sendIpcRequest(this.socketPath, {
      type: "resume-session",
      sessionId,
    }, 10_000);

    if (resp.type === "error") {
      throw new Error(resp.message);
    }
    if (resp.type !== "session-resumed") {
      throw new Error(`Unexpected response: ${resp.type}`);
    }

    // Load turn history from disk for display
    const loaded = await loadSession(sessionId, this.paths);
    if (!loaded) {
      // Session exists in daemon memory but not on disk — return empty
      return {
        sessionId,
        turns: [],
        tokenEstimate: 0,
      };
    }

    return {
      sessionId,
      turns: loaded.turns,
      tokenEstimate: loaded.tokenEstimate,
      model: loaded.session.model,
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
    const resp = await sendIpcRequest(this.socketPath, {
      type: "list-sessions",
    });

    if (resp.type === "sessions-listed") {
      return resp.sessions;
    }
    throw new Error(
      resp.type === "error"
        ? resp.message
        : `Unexpected response: ${resp.type}`,
    );
  }

  async endSession(sessionId: string): Promise<void> {
    const resp = await sendIpcRequest(this.socketPath, {
      type: "end-session",
      sessionId,
    });

    if (resp.type === "session-ended") return;
    if (resp.type === "error") {
      throw new Error(resp.message);
    }
    // Ignore unexpected responses — session may have already ended
  }

  async runTurn(
    text: string,
    sessionId: string,
    onEvent: (event: BackendEvent) => void,
    signal?: AbortSignal,
    opts?: RunTurnOpts,
  ): Promise<TurnResult> {
    return this.doRunTurn(text, sessionId, onEvent, signal, opts);
  }

  private async doRunTurn(
    text: string,
    sessionId: string,
    onEvent: (event: BackendEvent) => void,
    signal?: AbortSignal,
    opts?: RunTurnOpts,
  ): Promise<TurnResult> {
    try {
      const resp = await sendIpcStreaming(
        this.socketPath,
        { type: "submit-turn", text, sessionId, model: opts?.model },
        (ipcResp: IpcResponse) => {
          if (ipcResp.type !== "turn-event") return;
          const ev = ipcResp.event as TurnStreamEvent;
          const backendEvent = translateStreamEvent(ev);
          if (backendEvent) {
            onEvent(backendEvent);
          }
        },
        SUBMIT_TURN_IPC_TIMEOUT_MS,
        signal,
      );

      if (resp.type === "turn-complete") {
        // Emit synthetic turn_end + usage events
        onEvent({ type: "turn_end" });
        if (resp.usage) {
          onEvent({
            type: "usage",
            inputTokens: resp.usage.inputTokens,
            outputTokens: resp.usage.outputTokens,
            totalTokens: resp.usage.totalTokens,
            cacheRead: resp.usage.cacheRead,
            cacheWrite: resp.usage.cacheWrite,
          });
        }
        return {
          finalResponse: resp.finalResponse,
          aborted: resp.aborted ?? false,
          turnsCompleted: resp.turnsCompleted,
          sessionId: resp.sessionId,
          usage: resp.usage,
        };
      }
      if (resp.type === "error") {
        throw new Error(resp.message);
      }
      throw new Error(`Unexpected response: ${resp.type}`);
    } catch (err) {
      if (signal?.aborted) {
        onEvent({ type: "turn_end" });
        return {
          finalResponse: "",
          aborted: true,
          turnsCompleted: 0,
          sessionId,
        };
      }
      throw err;
    }
  }
}

function translateStreamEvent(ev: TurnStreamEvent): BackendEvent | null {
  switch (ev.type) {
    case "token":
      return { type: "token", text: ev.text };
    case "thinking":
      return { type: "thinking", text: ev.text };
    case "tool_call_start":
      return { type: "tool_call_start", name: ev.name, args: ev.args };
    case "tool_call_done":
      return { type: "tool_call_done", name: ev.name, result: ev.result };
    case "tool_call_error":
      return { type: "tool_call_error", name: ev.name, error: ev.error };
    case "status":
      return { type: "status", status: ev.status };
    default:
      return null;
  }
}
