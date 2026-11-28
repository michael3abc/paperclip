/** Inbound chat wake identity. This leaf must not import runtime services: the
 * heartbeat dispatcher constructs its person-origin reason set at module load.
 */
export const EXTERNAL_CHAT_MESSAGE_WAKE_REASON = "External chat message received";
