import type { VoiceProvider } from "@paperclipai/shared";

/**
 * What a voice provider can do. The control plane checks these before any
 * provider call so an unsupported mode fails with a clear error instead of
 * imitating another provider.
 */
export interface VoiceProviderCapabilities {
  browser: boolean;
  outboundPhone: boolean;
  inboundPhone: boolean;
  /** Provider-hosted media room (Speko). Local voice has none in phase 1. */
  providerMedia: boolean;
  /** Server push of approved replies into a live call. */
  replyPush: boolean;
  /** Provider call reports (transcript, cost, duration). */
  callReports: boolean;
  /** Signed provider webhooks. Local voice uses the same-origin board route instead. */
  signedWebhooks: boolean;
}

/**
 * Provider port used by the voice session service. Each provider implements
 * the same lifecycle; the provider-neutral store owns authorization, the
 * operation ledger and result admission.
 *
 * - endpointFor: resolve the company-scoped endpoint for this provider only.
 * - start: reserve a session and create the provider side (if any).
 * - tool: execute one provider-neutral tool command.
 * - end: stop the provider side and mark the session terminal.
 * - reconcile: repair missed lifecycle events for this provider's sessions.
 * - report: fetch provider call reports (no-op when unsupported).
 */
export interface VoiceProviderPort<Endpoint, StartInput, StartResult, ToolResult, Session> {
  readonly provider: VoiceProvider;
  readonly capabilities: VoiceProviderCapabilities;
  endpointFor(companyId: string, endpointId: string): Promise<Endpoint>;
  start(input: StartInput): Promise<StartResult>;
  tool(...args: never[]): Promise<ToolResult>;
  end(companyId: string, sessionId: string, caller: { id: string; authority: string }): Promise<Session>;
  reconcile(limit?: number): Promise<number>;
  report(limit: number): Promise<number>;
}

export const SPEKO_VOICE_CAPABILITIES: VoiceProviderCapabilities = Object.freeze({
  browser: true, outboundPhone: true, inboundPhone: true, providerMedia: true, replyPush: true, callReports: true, signedWebhooks: true,
});

/** Phase 1: browser capability only. No phone imitation, no provider media, no push, no reports. */
export const LOCAL_VOICE_CAPABILITIES: VoiceProviderCapabilities = Object.freeze({
  browser: true, outboundPhone: false, inboundPhone: false, providerMedia: false, replyPush: false, callReports: false, signedWebhooks: false,
});

/** Local provider session ids are minted by Paperclip and never collide with provider ids. */
export const LOCAL_PROVIDER_SESSION_PREFIX = "local:";
