import { createServer, createConnection, type Socket, type Server } from "node:net";
import { unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { IpcRequest, IpcResponse } from "./types.js";
import { isTerminalResponse } from "./types.js";

const ENCODING = "utf-8";
const DELIMITER = "\n";

/**
 * Handler signature for IPC requests.
 *
 * The optional `send` callback lets the handler stream intermediate
 * `turn-event` frames before returning the terminal response. Non-streaming
 * handlers simply ignore `send` and return a single response.
 *
 * The server writes each `send` call to the socket as a separate line,
 * then writes the returned terminal response as the final line.
 */
export type IpcHandler = (
  req: IpcRequest,
  send?: (resp: IpcResponse) => void,
) => Promise<IpcResponse>;

/**
 * Creates and starts a Unix socket server.
 *
 * Wire protocol: newline-delimited JSON. Each message is a single JSON
 * object followed by \n. Responses are similarly framed.
 *
 * @param socketPath  Path to the Unix socket file.
 * @param handler     Called for each incoming request. Must return a terminal response.
 *                    May call `send` for intermediate streaming events.
 */
export async function startIpcServer(
  socketPath: string,
  handler: IpcHandler,
): Promise<Server> {
  // Clean up any stale socket file from a previous crash
  await unlink(socketPath).catch(() => {});
  await mkdir(dirname(socketPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      let buffer = "";

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString(ENCODING);
        const lines = buffer.split(DELIMITER);
        // Keep the last (possibly incomplete) fragment in buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          void handleRequest(socket, trimmed, handler);
        }
      });

      socket.on("error", () => {
        // Client disconnected abruptly — ignore
      });
    });

    server.on("error", (err) => {
      reject(err);
    });

    server.listen(socketPath, () => {
      resolve(server);
    });
  });
}

async function handleRequest(
  socket: Socket,
  rawLine: string,
  handler: IpcHandler,
): Promise<void> {
  // `send` writes intermediate streaming events to the socket.
  const send = (resp: IpcResponse): void => {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(resp) + DELIMITER, ENCODING);
    }
  };

  let response: IpcResponse;
  try {
    const req = JSON.parse(rawLine) as IpcRequest;
    response = await handler(req, send);
  } catch (err) {
    response = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!socket.destroyed) {
    socket.write(JSON.stringify(response) + DELIMITER, ENCODING);
  }
}

/**
 * Sends a single request to the daemon via Unix socket and waits
 * for the terminal response. Intermediate `turn-event` frames are
 * silently skipped — use `sendIpcStreaming` if you need them.
 *
 * @throws Error if the socket cannot be connected or the response is an error.
 */
export async function sendIpcRequest(
  socketPath: string,
  req: IpcRequest,
  timeoutMs = 30_000,
): Promise<IpcResponse> {
  return sendIpcStreaming(socketPath, req, undefined, timeoutMs);
}

/**
 * Sends a request and reads all response frames until the terminal
 * response. Each intermediate frame is passed to `onEvent`. Returns
 * the terminal response.
 *
 * @throws Error if the socket cannot be connected or the timeout fires.
 */
export async function sendIpcStreaming(
  socketPath: string,
  req: IpcRequest,
  onEvent?: (resp: IpcResponse) => void,
  timeoutMs = 120_000,
): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`IPC request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(JSON.stringify(req) + DELIMITER, ENCODING);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString(ENCODING);
      const lines = buffer.split(DELIMITER);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (settled) return;

        let resp: IpcResponse;
        try {
          resp = JSON.parse(trimmed) as IpcResponse;
        } catch (err) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          reject(
            new Error(
              `Failed to parse IPC response: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
          return;
        }

        // Terminal response — resolve.
        // Anything that isn't `turn-event` is terminal, including
        // unknown types from older daemon versions.
        if (isTerminalResponse(resp)) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(resp);
          return;
        }

        // Intermediate event — forward to callback.
        onEvent?.(resp);
      }
    });

    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Cannot connect to daemon at ${socketPath}. Is it running?\n${err.message}`,
        ),
      );
    });
  });
}

/**
 * Gracefully stops the IPC server and removes the socket file.
 */
export async function stopIpcServer(
  server: Server,
  socketPath: string,
): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await unlink(socketPath).catch(() => {});
}
