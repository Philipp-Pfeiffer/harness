/**
 * request_restart Tool — schedule a graceful daemon self-restart.
 *
 * The daemon injects the `requestRestart` capability through the run's
 * ToolCallContext (same pattern as channelFileSender for send_file). The
 * tool just forwards { reason }; the daemon writes the restart marker and
 * defers the actual exit until the current turn has finished and its
 * response was sent.
 *
 * Without the capability (e.g. TUI in-process, no daemon) the tool
 * returns a clean error — it never falls back to systemctl/kill.
 */

import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.js";
import { ok, err } from "./types.js";

export const RequestRestartArgs = Type.Object({
  reason: Type.String({
    description: "Short human-readable reason for the restart (e.g. 'new API key in ~/harness/.env').",
  }),
});

export const requestRestartTool: Tool<typeof RequestRestartArgs> = {
  name: "request_restart",
  description:
    "Restart the harness daemon gracefully AFTER the current turn completes. " +
    "Use ONLY after config changes that require a restart (e.g. new API keys in ~/harness/.env). " +
    "Never use systemctl/kill directly. The user gets a confirmation message before restart and a 'Back online' ping after.",
  parameters: RequestRestartArgs,
  conflictKey() {
    return "request_restart";
  },
  async execute(args, context) {
    if (context?.postRestartFollowUp) {
      return err(
        "Restart not allowed during post-restart follow-up — the daemon just restarted.",
      );
    }

    if (!context?.requestRestart) {
      return err(
        "Kein Daemon-Kontext für einen Restart verfügbar (requestRestart-Capability fehlt). " +
          "Dieses Tool funktioniert nur, wenn der Daemon die Session ausführt.",
      );
    }

    const result = await context.requestRestart(args.reason);
    if (!result.ok) {
      return err(result.error ?? "Restart request rejected.");
    }
    return ok("Restart scheduled — the daemon will restart after this turn completes.");
  },
};
