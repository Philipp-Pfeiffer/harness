/**
 * report_to_main_session Tool — report back from a voice call to the owner's
 * main WhatsApp session.
 *
 * There is no return channel from a voice call: the voice agent speaks to
 * the callee (TTS) and hears only the callee (STT). When the callee asks the
 * agent to pass something on to the main session, this tool delivers a
 * system event ("[Voice-Call voice-<ts>] <text>") into the owner's WhatsApp
 * chat via the daemon's system event bus.
 *
 * The daemon injects the `voiceReportToMainSession` capability into the
 * ToolCallContext ONLY for voice sessions (origin "voice"). Any other
 * session (WhatsApp chat, TUI, API) gets a clear tool error — the tool
 * never writes into the main session on its own.
 */

import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.js";
import { ok, err } from "./types.js";

export const ReportToMainSessionArgs = Type.Object({
  text: Type.String({
    description:
      "The content to pass on to the main session — e.g. something the callee " +
      "asked to convey, or a compact summary of important results/decisions " +
      "from the call. Plain text, written like a subagent report.",
  }),
});

export const reportToMainSessionTool: Tool<typeof ReportToMainSessionArgs> = {
  name: "report_to_main_session",
  description:
    "Deliver a message from this voice call to the owner's main WhatsApp session. " +
    "Use it when the person on the call asks you to pass something on to the main " +
    "session, and at the end of a call to report important results or decisions " +
    "compactly (like a subagent report). " +
    "Only available inside voice calls; in any other session it returns an error.",
  parameters: ReportToMainSessionArgs,
  conflictKey() {
    return "report_to_main_session";
  },
  async execute(args, context) {
    if (!context?.voiceReportToMainSession) {
      return err(
        "Kein Voice-Call aktiv — report_to_main_session funktioniert nur in Voice-Sessions.",
      );
    }

    const text = args.text.trim();
    if (!text) {
      return err("Text darf nicht leer sein.");
    }

    const result = await context.voiceReportToMainSession(text);
    if (!result.ok) {
      return err(result.error ?? "Report konnte nicht zugestellt werden.");
    }
    return ok("Bericht an die Main-Session zugestellt.");
  },
};
