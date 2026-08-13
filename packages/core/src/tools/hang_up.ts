/**
 * hang_up Tool — bot-seitiges Auflegen eines Voice-Calls.
 *
 * Deterministischer Gegenpol zur Farewell-Regex im Adapter: Wenn der Anrufer
 * den Bot bittet aufzulegen (oder der Bot aus anderen Gründen beenden will),
 * sendet dieses Tool `end_call` über den Voice-IPC an den Adapter. Der
 * Adapter führt teardown + voip.endCall aus.
 *
 * Die Daemon-Capability `voiceHangUp` wird NUR in Voice-Sessions (origin
 * "voice") injiziert — wie `voiceReportToMainSession`. In jeder anderen
 * Session gibt das Tool einen klaren Fehler zurück.
 */

import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.js";
import { ok, err } from "./types.js";

export const HangUpArgs = Type.Object({});

export const hangUpTool: Tool<typeof HangUpArgs> = {
  name: "hang_up",
  description:
    "Beendet den aktuellen Voice-Call bot-seitig: verabschiede dich kurz und rufe dieses Tool auf, " +
    "wenn dein Gegenüber dich bittet aufzulegen oder das Gespräch inhaltlich beendet ist. " +
    "Nur in Voice-Calls verfügbar; in jeder anderen Session gibt es einen Fehler zurück.",
  parameters: HangUpArgs,
  conflictKey() {
    return "hang_up";
  },
  async execute(_args, context) {
    if (!context?.voiceHangUp) {
      return err(
        "Kein aktiver Voice-Call — hang_up funktioniert nur in Voice-Sessions.",
      );
    }

    const result = await context.voiceHangUp();
    if (!result.ok) {
      return err(result.error ?? "Auflegen fehlgeschlagen.");
    }
    return ok("Call wird beendet.");
  },
};
