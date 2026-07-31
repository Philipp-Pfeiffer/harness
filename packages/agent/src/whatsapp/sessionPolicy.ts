/**
 * Whether to send the WhatsApp "session reset" notice to the user.
 * True when an existing session was replaced after the 8h inactivity boundary
 * (daemon restart or live rotation while the daemon is running).
 */
export function shouldNotifyWhatsAppSessionReset(replacedDueToInactivity: boolean): boolean {
  return replacedDueToInactivity;
}

/**
 * Baileys delivers historical messages as `append` on connect.
 * Only `notify` upserts are realtime inbound messages we should process.
 */
export function isRealtimeInboundUpsert(type: "append" | "notify"): boolean {
  return type === "notify";
}
