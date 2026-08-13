/**
 * call_user Tool — place an outbound WhatsApp voice call.
 *
 * The actual call is placed by the daemon: it injects the `voiceCallStarter`
 * capability into the ToolCallContext (same pattern as `channelFileSender`
 * for send_file). The daemon enforces the fail-closed registry gate and the
 * per-number rate limit before sending `start_call` over the voice IPC.
 *
 * Without the capability (no voice channel active) the tool returns a clean
 * error — it never falls back to a direct VoIP call.
 */

import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.js";
import { ok, err } from "./types.js";

export const CallUserArgs = Type.Object({
  number: Type.String({
    description:
      "Phone number to call in international format (e.g. \"+49 151 10619636\"). " +
      "Must be listed in the voice registry (~/harness/voice-registry.json).",
  }),
  briefing: Type.String({
    description:
      "Briefing the voice agent receives as its first instruction. Orient the callee immediately: " +
      "who is calling, why, and what the call is about. May reference file paths the voice agent can read with tools.",
  }),
});

/** Strips every non-digit character: "+49 151 10619636" → "4915110619636". */
export function normalizeCallNumber(raw: string): string {
  return raw.replace(/\D/g, "");
}

export const callUserTool: Tool<typeof CallUserArgs> = {
  name: "call_user",
  description:
    "Place a WhatsApp voice call to a person and have the voice agent handle it. " +
    "The callee is spoken to with TTS and can answer with speech (STT). " +
    "Only numbers listed in the voice registry (~/harness/voice-registry.json) are allowed (fail-closed), " +
    "and each number may be called at most once per 10 minutes. " +
    "The briefing is the voice agent's opening instruction — it greets and reports without waiting for user input. " +
    "Write the briefing so the callee is immediately oriented: who is calling, why, and what the call is about.",
  parameters: CallUserArgs,
  conflictKey() {
    return "call_user";
  },
  async execute(args, context) {
    if (!context?.voiceCallStarter) {
      return err(
        "Kein Voice-Channel aktiv — call_user funktioniert nur, wenn der Daemon einen Voice-Channel bereitstellt.",
      );
    }
    if (!context.sessionId) {
      return err("Keine aktive Session — call_user erfordert eine Channel-Session.");
    }

    const number = normalizeCallNumber(args.number);
    if (!number) {
      return err(`Ungültige Rufnummer: "${args.number}" enthält keine Ziffern.`);
    }
    const briefing = args.briefing.trim();
    if (!briefing) {
      return err("Briefing darf nicht leer sein.");
    }

    const result = await context.voiceCallStarter(context.sessionId, { number, briefing });
    if (!result.ok) {
      return err(result.error ?? "Anruf konnte nicht gestartet werden.");
    }
    return ok(`Anruf gestartet (${number}, callId ${result.callId ?? "unbekannt"}).`);
  },
};
