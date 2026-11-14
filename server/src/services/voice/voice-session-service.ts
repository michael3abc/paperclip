import { voiceReplySchedule } from "./voice-reply-schedule.js";
import { registerVoiceReplyWork } from "./voice-reply-work.js";
import { voiceSessionRecovery } from "./voice-session-recovery.js";
import { registerVoiceRecoveryWork } from "./voice-recovery-work.js";
import { notifyVoiceChange, withVoiceSessionChange } from "./voice-recovery-notifications.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { logger } from "../../middleware/logger.js";
import { voiceCallReports } from "./voice-call-reports.js";
import { captureVoiceDeliveryDiagnostics } from "./voice-delivery-diagnostics.js";
import { pushVoiceReplies } from "./voice-reply-push.js";
import { voiceInboundService } from "./voice-inbound-service.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { chatVoiceReports, chatVoiceCallbacks, chatConversations, chatEndpointResources, chatEndpoints, chatVoiceSessions, issues, activityLog, type Db } from "@paperclipai/db";
import { LOCAL_VOICE_CONTROL_PROTOCOL, VOICE_RESULT_NOTIFICATION, VOICE_REPEAT_NOTIFICATION, type LocalVoiceSessionMedia, type VoiceProvider, type VoiceSession, type VoiceSessionMedia, type VoiceCallHistoryEntry, type VoiceCallReport } from "@paperclipai/shared";
import { conflict, forbidden, notFound, HttpError } from "../../errors.js";
import { instanceSettingsService } from "../instance-settings.js";
import { buildChatCommunicationGuidance } from "../chat-communication-guidance.js";
import { issueService } from "../issues.js";
import { createSpekoProvider, SpekoProviderError } from "./speko-provider.js";
import { serializeVoiceSession, voiceSessionStore, type VoiceCaller, type VoiceSessionRow } from "./voice-session-store.js";
import { registerSpekoVoiceRuntime } from "./speko-agent-tools.js";
import { verifySpekoToolRequest } from "./speko-protocol.js";
import { localVoiceCommand, parseLocalVoiceToolMessage } from "./local-voice-protocol.js";
import { LOCAL_PROVIDER_SESSION_PREFIX, LOCAL_VOICE_CAPABILITIES, SPEKO_VOICE_CAPABILITIES } from "./voice-provider-port.js";
import { VOICE_PROMPT, PHONE_VOICE_PROMPT, LOW_TRUST_PHONE_VOICE_PROMPT } from "./voice-prompts.js";

/**
 * Instructions for the assigned agent on a local voice task (HOM-311, Owner decision 4):
 * replies carry a short spoken summary that the relay reads aloud.
 */
export const LOCAL_VOICE_TASK_DESCRIPTION = [
  "這是 Owner 透過 Paperclip 語音介面建立的語音對話任務（voice_task）。Owner 在語音中確認的需求會以留言送到這裡。",
  "",
  "回覆方式：",
  "- 照常在這張任務留言，寫完整內容（表格、指令、連結都可以）。",
  "- 每則回覆的最後一行另外加上 `語音摘要：<兩到三句口語摘要>`。語音介面只會唸這一行，完整內容留在文字面板。",
  "- 語音摘要用台灣繁體中文口語，不要放程式碼、路徑或表格。",
  "- 需要 Owner 簽核、部署或改設定時，在摘要中請 Owner 到 Paperclip 畫面上處理；語音不能代替這些確認。",
].join("\n");

const liveStates = ["reserved", "creating", "creation_unknown", "connecting", "active", "ending"] as const;
const terminalStates = ["ended", "failed", "expired"] as const;

type Endpoint = typeof chatEndpoints.$inferSelect;
export function voiceSessionService(db: Db, options: {
  allowLocalBoard: boolean;
  credentials(endpoint: Endpoint, expectedFingerprint?: string): Promise<Record<string, string>>;
  provider?: typeof createSpekoProvider;
  /** Queue the canonical response delivery after its durable receipt commits. */
  onQuestionAnswered(interactionId: string): void;
}) {
  const store = voiceSessionStore(db, options), issueSvc = issueService(db);
  const provider = options.provider ?? createSpekoProvider;

  /** Provider-scoped endpoint lookup. Omitted providers means Speko, the pre-existing contract. */
  async function endpointFor(companyId: string, endpointId: string, providers: readonly VoiceProvider[] = ["speko"]) {
    const [endpoint] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.companyId, companyId), inArray(chatEndpoints.provider, [...providers])));
    if (!endpoint) throw notFound("Voice connection not found");
    return endpoint;
  }
  async function ownedSession(companyId: string, sessionId: string, caller: VoiceCaller, content = true) {
    return db.transaction(async (tx) => {
      const [session] = await tx.select().from(chatVoiceSessions).where(and(eq(chatVoiceSessions.companyId, companyId), eq(chatVoiceSessions.id, sessionId)));
      if (!session) throw notFound("Voice session not found");
      if (session.callerId !== caller.id) throw forbidden("This voice session belongs to another caller");
      if (content) await store.authorizeTask(tx, companyId, session.issueId, caller, false);
      return session;
    });
  }
  type BindingInput = { companyId: string; endpointId: string; issueId?: string; newConversation?: boolean; caller: VoiceCaller; idempotencyKey: string };
  /** Shared task/conversation binding. The thread id prefix names the provider (`speko:` or `local_voice:`). */
  async function prepareBinding(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], input: BindingInput, endpoint: Endpoint, threadProvider: VoiceProvider) {
      // One lock per task preserves the existing conversation on concurrent resumes.
      if (input.issueId) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`voice-binding:${input.companyId}:${input.endpointId}:${input.issueId}`}, 0))`);
      // Serialize generic starts per authenticated caller/endpoint, including
      // different request keys. Session history is durable ownership evidence;
      // never infer ownership from a provider caller ID or a display name.
      let issueId = input.issueId;
      if (!issueId) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`voice-caller:${input.companyId}:${input.endpointId}:${input.caller.id}`}, 0))`);
        if (!input.newConversation) {
          const candidates = await tx.select({ issueId: chatVoiceSessions.issueId }).from(chatVoiceSessions)
            .innerJoin(issues, and(eq(issues.id, chatVoiceSessions.issueId), eq(issues.companyId, chatVoiceSessions.companyId)))
            .innerJoin(chatConversations, eq(chatConversations.id, chatVoiceSessions.conversationId))
            .where(and(eq(chatVoiceSessions.companyId, input.companyId), eq(chatVoiceSessions.endpointId, input.endpointId),
              eq(chatVoiceSessions.callerId, input.caller.id), eq(issues.originKind, "chat_channel"), eq(issues.originId, input.endpointId),
              eq(issues.assigneeAgentId, endpoint.assignedAgentId), notInArray(issues.status, ["cancelled", "done"]),
              inArray(chatConversations.state, ["active", "waiting"])))
            .orderBy(desc(chatVoiceSessions.createdAt), desc(chatVoiceSessions.id)).limit(20);
          for (const candidate of candidates) {
            try { await store.authorizeTask(tx, input.companyId, candidate.issueId, input.caller); issueId = candidate.issueId; break; }
            catch (error) { if (!(error instanceof HttpError && [403, 404].includes(error.status))) throw error; }
          }
        }
      }
      const task = issueId
        ? await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId))).then((rows) => rows[0])
        : await issueSvc.create(input.companyId, { ...(threadProvider === "local_voice" ? { title: "語音對話", description: LOCAL_VOICE_TASK_DESCRIPTION } : { title: "Voice conversation" }), status: "todo", priority: "medium", assigneeAgentId: endpoint.assignedAgentId, createdByUserId: input.caller.id, responsibleUserId: input.caller.id, originKind: "chat_channel", originId: endpoint.id, idempotencyKey: `voice:${input.caller.id}:${input.idempotencyKey}` }, tx);
      if (!task) throw notFound("Task not found");
      if (task.assigneeAgentId !== endpoint.assignedAgentId) throw conflict("Choose a voice connection for this task's assigned agent");
      const existing = await tx.select().from(chatConversations).where(and(eq(chatConversations.companyId, input.companyId), eq(chatConversations.endpointId, input.endpointId), eq(chatConversations.issueId, task.id))).limit(1).then((rows) => rows[0]);
      if (existing) {
        if (!["active", "waiting"].includes(existing.state)) throw conflict("This voice conversation is no longer available");
        return { issueId: task.id, conversationId: existing.id };
      }
      const conversationId = randomUUID(), threadId = `${threadProvider}:${conversationId}`;
      const [resource] = await tx.insert(chatEndpointResources).values({ companyId: input.companyId, endpointId: input.endpointId, type: "direct_message", providerResourceId: threadId, label: "Voice conversation", enabled: true, availability: "available" }).returning();
      await tx.insert(chatConversations).values({ id: conversationId, companyId: input.companyId, endpointId: input.endpointId, resourceId: resource.id, issueId: task.id, externalConversationId: threadId, externalThreadId: threadId, externalLabel: "Voice conversation", communicationGuidance: buildChatCommunicationGuidance({ provider: threadProvider, isDirectMessage: true, communicationInstructions: endpoint.communicationInstructions }), isDirectMessage: true });
      return { issueId: task.id, conversationId };
  }
  async function start(input: { companyId: string; endpointId: string; issueId?: string; newConversation?: boolean; caller: VoiceCaller; idempotencyKey: string; maxDurationSeconds: number; mode?: "outbound_phone" | "inbound_phone"; phoneNumber?: string; providerSessionId?: string; toolToken?: string }): Promise<{ session: VoiceSession; media?: VoiceSessionMedia }> {
    if (input.mode === "outbound_phone" && !(await instanceSettingsService(db).getExperimental()).enableChatConnectors) throw forbidden("Voice connections are disabled");
    const endpoint = await endpointFor(input.companyId, input.endpointId);
    const requestFingerprint = createHash("sha256").update(JSON.stringify({ endpointId: input.endpointId, issueId: input.issueId ?? null, maxDurationSeconds: input.maxDurationSeconds, ...(input.mode ? { mode: input.mode, phoneNumber: input.phoneNumber, providerSessionId: input.providerSessionId } : {}), ...(input.newConversation ? { newConversation: true } : {}) })).digest("hex");
    const reserved = await store.reserve({ ...input, requestFingerprint, prepareBinding: (tx) => prepareBinding(tx, input, endpoint, "speko") });
    // Media credentials are intentionally not stored or reissued. An uncertain
    // browser response must inspect/end this attempt, never blindly create again.
    if (!reserved.created || input.mode === "inbound_phone") return { session: serializeVoiceSession(reserved.session) };
    const session = reserved.session;
    const [claim] = await withVoiceSessionChange(db, session.id, tx => tx.update(chatVoiceSessions).set({ state: "creating", updatedAt: new Date() }).where(and(eq(chatVoiceSessions.id, session.id), eq(chatVoiceSessions.state, "reserved"))).returning({ id: chatVoiceSessions.id }));
    if (!claim) throw conflict("The call was ended before Speko connected");
    let client: ReturnType<typeof createSpekoProvider> | undefined;
    let created: { sessionId: string; transportToken?: string; transportUrl?: string };
    try {
      const credentials = await options.credentials(endpoint, session.credentialFingerprint);
      if (!credentials.agentId || !credentials.apiKey) throw new SpekoProviderError("credentials_rejected", false);
      await db.transaction((tx) => store.authorizeSession(tx, input.companyId, session.id, ["creating"]));
      client = provider(credentials.apiKey);
      const shared = { agentId: credentials.agentId, bindingId: session.id, toolToken: reserved.token, maxDurationSeconds: input.maxDurationSeconds };
      created = input.mode === "outbound_phone"
        ? await client.createPhoneSession({ ...shared, to: input.phoneNumber!, systemPrompt: PHONE_VOICE_PROMPT })
        : await client.createBrowserSession({ ...shared, systemPrompt: VOICE_PROMPT });
    } catch (error) {
      const known = error instanceof SpekoProviderError && !error.outcomeUnknown || error instanceof HttpError && [403, 404].includes(error.status);
      await withVoiceSessionChange(db, session.id, tx => tx.update(chatVoiceSessions).set({ state: known ? "failed" : "creation_unknown", errorCode: error instanceof SpekoProviderError ? error.code : "provider_unavailable", updatedAt: new Date() }).where(and(eq(chatVoiceSessions.id, session.id), eq(chatVoiceSessions.state, "creating"))));
      if (error instanceof SpekoProviderError && error.code === "insufficient_credits") throw conflict("Speko needs credits before starting a call. Add credits in Speko, then try again.", {code: "voice_credits_required", sessionId: session.id});
      throw conflict(known ? "Speko could not start the call. Check connection status before trying again." : "Speko may have started this call. Inspect this attempt before starting another.", { code: known ? "voice_creation_failed" : "voice_creation_unknown", sessionId: session.id });
    }
    let bound: VoiceSessionRow | undefined;
    try {
    [bound] = await withVoiceSessionChange(db, session.id, tx => tx.update(chatVoiceSessions).set({ providerSessionId: created.sessionId, state: "connecting", updatedAt: new Date() }).where(and(eq(chatVoiceSessions.id, session.id), eq(chatVoiceSessions.state, "creating"))).returning());
    } catch (error) {
      // If the provider started but persistence failed, stop that exact call.
      // Never return media or retry creation on an uncertain database outcome.
      await client!.endSession(created.sessionId).catch(() => undefined);
      throw conflict("The call could not be saved. Inspect this attempt before starting another.", { code: "voice_creation_unknown", sessionId: session.id });
    }
    if (!bound) {
      // A concurrent end must still learn the provider identity for reconciliation.
      await withVoiceSessionChange(db, session.id, tx => tx.update(chatVoiceSessions).set({ providerSessionId: created.sessionId, state: "ending", updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id)));
      await closeProvider({ ...session, providerSessionId: created.sessionId, state: "ending" });
      throw conflict("The call was ended while Speko was connecting");
    }
    try { await db.transaction((tx) => store.authorizeSession(tx, input.companyId, session.id)); }
    catch (error) { await closeProvider(bound).catch(() => undefined); throw error; }
    return { session: serializeVoiceSession(bound), ...(created.transportToken && created.transportUrl ? { media: { sessionId: session.id, generation: session.generation, transportToken: created.transportToken, transportUrl: created.transportUrl } } : {}) };
  }
  const closingSessions = new Map<string, Promise<VoiceSessionRow>>();
  function closeProvider(session: VoiceSessionRow): Promise<VoiceSessionRow> {
    const pending = closingSessions.get(session.id);
    if (pending) return pending;
    const operation = closeProviderOnce(session).finally(() => closingSessions.delete(session.id));
    closingSessions.set(session.id, operation);
    return operation;
  }
  async function closeProviderOnce(session: VoiceSessionRow) {
    if (terminalStates.some(state => state === session.state)) return session;
    await db.transaction(async (tx) => {
      await notifyVoiceChange(tx, { kind: "session", id: session.id });
      const [changed] = await tx.update(chatVoiceSessions).set({ state: "ending", updatedAt: new Date() }).where(and(eq(chatVoiceSessions.id, session.id), inArray(chatVoiceSessions.state, [...liveStates].filter((state) => state !== "ending")))).returning({ id: chatVoiceSessions.id });
      if (changed) await tx.insert(activityLog).values({ companyId: session.companyId, actorType: "system", actorId: "voice-session-service", action: "voice.session.ending", entityType: "voice_session", entityId: session.id, details: { issueId: session.issueId } });
    });
    if (isLocal(session)) {
      // Local voice has no provider room: ending is a durable state change only.
      await withVoiceSessionChange(db, session.id, tx => tx.update(chatVoiceSessions).set({ state: session.expiresAt.getTime() <= Date.now() ? "expired" : "ended", endedAt: new Date(), errorCode: null, updatedAt: new Date() }).where(and(eq(chatVoiceSessions.id, session.id), inArray(chatVoiceSessions.state, [...liveStates]))));
    } else if (session.providerSessionId) {
      const endpoint = await endpointFor(session.companyId, session.endpointId), credentials = await options.credentials(endpoint);
      const client = provider(credentials.apiKey);
      // Closing the SDK room can race the provider end request. Confirm the
      // exact existing call before presenting an ambiguous rejection as failure.
      let confirmed = false;
      try { confirmed = (await client.endSession(session.providerSessionId)).confirmed; }
      catch (error) { if (!(error instanceof SpekoProviderError)) throw error; }
      if (!confirmed) {
        try { confirmed = Boolean((await client.inspectSession(session.providerSessionId)).endedAt); }
        catch (error) { if (!(error instanceof SpekoProviderError)) throw error; }
      }
      await withVoiceSessionChange(db, session.id, tx => tx.update(chatVoiceSessions).set(confirmed
        ? { state: "ended", endedAt: new Date(), errorCode: null, updatedAt: new Date() }
        : { errorCode: "cleanup_pending", updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id)));
    } else if (session.state === "reserved") {
      await withVoiceSessionChange(db, session.id, tx => tx.update(chatVoiceSessions).set({ state: "ended", endedAt: new Date(), updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id)));
    }
    return db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, session.id)).then((rows) => rows[0]);
  }
  async function inspect(companyId: string, sessionId: string, caller: VoiceCaller) {
    let session = await ownedSession(companyId, sessionId, caller);
    if (isLocal(session)) {
      if (!terminalStates.some(state => state === session.state) && session.expiresAt.getTime() <= Date.now()) {
        [session] = await db.update(chatVoiceSessions).set({ state: "expired", endedAt: new Date(), updatedAt: new Date() }).where(eq(chatVoiceSessions.id, sessionId)).returning();
      }
    } else if (session.providerSessionId && !terminalStates.some(state => state === session.state)) {
      const endpoint = await endpointFor(companyId, session.endpointId), credentials = await options.credentials(endpoint);
      const state = await provider(credentials.apiKey).inspectSession(session.providerSessionId);
      if (state.endedAt) {
        [session] = await withVoiceSessionChange(db, sessionId, tx => tx.update(chatVoiceSessions).set({ state: "ended", endedAt: new Date(), updatedAt: new Date() }).where(eq(chatVoiceSessions.id, sessionId)).returning());
      }
    }
    return serializeVoiceSession(session);
  }
  async function end(companyId: string, sessionId: string, caller: VoiceCaller) {
    const session = await ownedSession(companyId, sessionId, caller, false);
    return serializeVoiceSession(await closeProvider(session));
  }
  /** Local voice sessions are the only sessions with a server-owned binding mode. */
  function isLocal(session: Pick<VoiceSessionRow, "bindingMode">) {
    return session.bindingMode === "voice_task";
  }
  async function localEnabled() {
    const settings = await instanceSettingsService(db).getExperimental();
    if (!settings.enableChatConnectors || !settings.enableLocalVoice) throw forbidden("Local voice is disabled", { code: "local_voice_disabled" });
  }
  /**
   * Phase-1 local start: browser capability only. Paperclip mints the
   * provider session id (`local:<uuid>`) and a one-time control token; no
   * provider is contacted and no phone mode is imitated.
   */
  async function startLocal(input: { companyId: string; endpointId: string; issueId?: string; newConversation?: boolean; caller: VoiceCaller; idempotencyKey: string; maxDurationSeconds: number; bindingMode?: "voice_task"; mode?: string; phoneNumber?: string }): Promise<{ session: VoiceSession; media?: LocalVoiceSessionMedia }> {
    await localEnabled();
    if (input.mode !== undefined || input.phoneNumber !== undefined) throw conflict("Local voice supports browser sessions only", { code: "local_voice_phone_unsupported" });
    if (input.bindingMode !== "voice_task") throw conflict("Local voice requires the voice_task binding", { code: "voice_binding_mode_invalid" });
    const endpoint = await endpointFor(input.companyId, input.endpointId, ["local_voice"]);
    const requestFingerprint = createHash("sha256").update(JSON.stringify({ provider: "local_voice", bindingMode: "voice_task", endpointId: input.endpointId, issueId: input.issueId ?? null, maxDurationSeconds: input.maxDurationSeconds, ...(input.newConversation ? { newConversation: true } : {}) })).digest("hex");
    const reserved = await store.reserve({ companyId: input.companyId, endpointId: input.endpointId, caller: input.caller, idempotencyKey: input.idempotencyKey, requestFingerprint,
      maxDurationSeconds: input.maxDurationSeconds, providers: ["local_voice"], bindingMode: "voice_task", providerSessionId: `${LOCAL_PROVIDER_SESSION_PREFIX}${randomUUID()}`,
      prepareBinding: (tx) => prepareBinding(tx, input, endpoint, "local_voice") });
    // Like Speko media credentials, the control token is shown once and never reissued.
    if (!reserved.created) return { session: serializeVoiceSession(reserved.session) };
    const session = reserved.session;
    return { session: serializeVoiceSession(session), media: { provider: "local_voice", protocol: LOCAL_VOICE_CONTROL_PROTOCOL, bindingMode: "voice_task", sessionId: session.id,
      generation: session.generation, transportToken: reserved.token, controlUrl: `/api/companies/${input.companyId}/voice-sessions/${session.id}/local-tools` } };
  }
  async function localOwnedSession(companyId: string, sessionId: string, caller: VoiceCaller) {
    const session = await ownedSession(companyId, sessionId, caller, false);
    if (!isLocal(session)) throw notFound("Voice session not found");
    if (session.callerAuthority !== caller.authority) throw forbidden("This voice session belongs to another caller");
    return session;
  }
  /** Same-origin local tool call. The voice session token travels in its own header, never as a bearer credential. */
  async function localTool(companyId: string, sessionId: string, caller: VoiceCaller, body: Buffer, token: string) {
    await localEnabled();
    const session = await localOwnedSession(companyId, sessionId, caller);
    const message = parseLocalVoiceToolMessage(body);
    const command = localVoiceCommand(message, { sessionId: session.id, providerSessionId: session.providerSessionId ?? "" });
    const result = await store.runCommand({ companyId, endpointId: session.endpointId, sessionId: session.id, token, command, accept: store.stageDelivery });
    if (command.command.tool === "answer_question") options.onQuestionAnswered(command.command.args.interactionId);
    return { toolCallId: message.toolCallId, result };
  }
  async function confirmLocal(companyId: string, sessionId: string, caller: VoiceCaller, input: { draftId: string; revision: number; text: string; via?: "spoken_relay" | "ui_relay" }) {
    await localEnabled();
    await localOwnedSession(companyId, sessionId, caller);
    return store.confirmDraft({ companyId, sessionId, caller, ...input });
  }
  async function localOperation(companyId: string, sessionId: string, caller: VoiceCaller, operationId: string) {
    await localEnabled();
    await localOwnedSession(companyId, sessionId, caller);
    return store.operationStatus({ companyId, sessionId, caller, operationId });
  }
  /** Local sessions end without a provider call when revoked, disabled or expired. */
  async function reconcileLocal(limit = 25) {
    const settings = await instanceSettingsService(db).getExperimental();
    const enabled = settings.enableChatConnectors && settings.enableLocalVoice;
    const rows = await db.select({ session: chatVoiceSessions }).from(chatVoiceSessions)
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatVoiceSessions.endpointId), eq(chatEndpoints.companyId, chatVoiceSessions.companyId)))
      .where(and(eq(chatEndpoints.provider, "local_voice"), inArray(chatVoiceSessions.state, [...liveStates])))
      .orderBy(asc(chatVoiceSessions.updatedAt)).limit(limit);
    for (const { session } of rows) {
      let authorized = false;
      if (enabled) {
        try { await db.transaction((tx) => store.authorizeSession(tx, session.companyId, session.id)); authorized = true; }
        catch (error) { if (!(error instanceof HttpError && [403, 404].includes(error.status))) throw error; }
      }
      if (authorized) continue;
      const expired = session.expiresAt.getTime() <= Date.now();
      await withVoiceSessionChange(db, session.id, tx => tx.update(chatVoiceSessions).set({ state: expired ? "expired" : "ended", endedAt: new Date(), errorCode: expired ? null : "local_voice_revoked", updatedAt: new Date() })
        .where(and(eq(chatVoiceSessions.id, session.id), inArray(chatVoiceSessions.state, [...liveStates]))));
    }
    return rows.length;
  }
  async function tool(publicId: string, body: Buffer, headers: Record<string, string | string[] | undefined>) {
    const endpoint = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.publicId, publicId), eq(chatEndpoints.provider, "speko"))).then((rows) => rows[0]);
    if (!endpoint) throw notFound("Voice endpoint not found");
    const credentials = await options.credentials(endpoint);
    const verified = verifySpekoToolRequest({ body, headers, keys: [{ secret: credentials.signingSecret }] });
    const authorization = headers.authorization;
    if (typeof authorization !== "string" || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw forbidden("Missing voice session credential");
    let session = await db.select({ id: chatVoiceSessions.id, authority: chatVoiceSessions.callerAuthority, mode: chatVoiceSessions.mode }).from(chatVoiceSessions).where(and(eq(chatVoiceSessions.companyId, endpoint.companyId), eq(chatVoiceSessions.endpointId, endpoint.id), eq(chatVoiceSessions.providerSessionId, verified.envelope.session_id))).then((rows) => rows[0]);
    if (!session) {
      const pending = await inbound.pendingTool(endpoint, verified.envelope, authorization.slice(7));
      if (!("sessionId" in pending) || typeof pending.sessionId !== "string") return pending;
      session = await db.select({id: chatVoiceSessions.id, authority: chatVoiceSessions.callerAuthority, mode: chatVoiceSessions.mode}).from(chatVoiceSessions).where(and(eq(chatVoiceSessions.id, pending.sessionId), eq(chatVoiceSessions.companyId, endpoint.companyId), eq(chatVoiceSessions.endpointId, endpoint.id))).then(rows => rows[0]);
      if (!session) throw conflict("Incoming request could not be bound to its task");
    }
    const result = await store.runTool({ ...verified, companyId: endpoint.companyId, endpointId: endpoint.id, sessionId: session.id, token: authorization.slice(7), accept: store.stageDelivery });
    // Do not await execution within Speko's four-second webhook budget. The
    // shared delivery service deduplicates retries; its sweep repairs crashes.
    if (verified.envelope.tool === "answer_question") options.onQuestionAnswered(verified.envelope.args.interactionId);
    return session.mode === "inbound_phone" ? {...result, authorization: session.authority === "guest_intake" ? "guest_intake" : "approved"} : result;
  }
  const replies = voiceReplySchedule(db, {
    store, push: sessionId => pushVoiceReplies(db, { store, credentials: options.credentials, provider, limit: 1, sessionId, recoverDispatches: false }),
  });
  const recovery = voiceSessionRecovery(db, {
    authorize: async session => {
      if (isLocal(session)) await localEnabled();
      await db.transaction(async tx => {
        await store.authorizeSession(tx, session.companyId, session.id);
        await replies.authorityAvailable(tx, session.id);
      });
    },
    inspect: async session => {
      if (isLocal(session)) return null;
      const endpoint = await endpointFor(session.companyId, session.endpointId);
      const credentials = await options.credentials(endpoint);
      return session.providerSessionId ? provider(credentials.apiKey).inspectSession(session.providerSessionId) : null;
    },
    close: closeProvider,
  });
  function registerRecoveryWork(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    return registerVoiceRecoveryWork(coordinator, recovery, canRun);
  }
  function registerReplyWork(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    return registerVoiceReplyWork(coordinator, replies, canRun);
  }
  const reports = voiceCallReports(db, async session => {
    const endpoint = await endpointFor(session.companyId, session.endpointId);
    const credentials = await options.credentials(endpoint, session.credentialFingerprint);
    const client = provider(credentials.apiKey);
    const result = await client.callReport(session.providerSessionId!, [credentials.signingSecret]);
    await captureVoiceDeliveryDiagnostics(db, session, client, result.complete);
    return result;
  });
  function registerReportWork(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    return reports.register(coordinator, canRun);
  }
  /** Explicit one-shot recovery for diagnostics/tests; never register on a recurring lane. */
  async function reconcile(limit = 25) {
    const due = (await recovery.load()).filter(row => row.dueAt <= Date.now()).sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id)).slice(0, limit);
    for (const row of due) await recovery.check(row.id).catch(() => undefined);
    await pushReplies(limit);
    await inbound.reconcile(limit);
    await reports.reconcile(limit);
    const local = await reconcileLocal(limit);
    return due.length + local;
  }
  async function pushReplies(limit = 25, companyId?: string, endpointId?: string) {
    return pushVoiceReplies(db, {store, credentials: options.credentials, provider, limit, companyId, endpointId});
  }
  function reportProjection(row?: typeof chatVoiceReports.$inferSelect): VoiceCallReport {
    return row ? { status: row.status, transcript: row.transcript.filter(turn => turn.speaker !== "caller" || ![VOICE_RESULT_NOTIFICATION, VOICE_REPEAT_NOTIFICATION].includes(turn.text)), costMicroUsd: row.costMicroUsd, durationSeconds: row.durationSeconds, updatedAt: row.updatedAt.toISOString() }
      : { status: "pending", transcript: [], costMicroUsd: null, durationSeconds: null, updatedAt: null };
  }
  async function history(companyId: string, endpointId: string, caller: VoiceCaller): Promise<VoiceCallHistoryEntry[]> {
    await endpointFor(companyId, endpointId);
    return db.transaction(async tx => {
      await store.authorizeCaller(tx, companyId, caller);
      const rows = await tx.select({ session: chatVoiceSessions, report: chatVoiceReports }).from(chatVoiceSessions)
        .leftJoin(chatVoiceReports, and(eq(chatVoiceReports.sessionId, chatVoiceSessions.id), eq(chatVoiceReports.companyId, chatVoiceSessions.companyId)))
        .where(and(eq(chatVoiceSessions.companyId, companyId), eq(chatVoiceSessions.endpointId, endpointId), or(eq(chatVoiceSessions.callerId, caller.id), eq(chatVoiceSessions.callerAuthority, "guest_intake"))))
        .orderBy(desc(chatVoiceSessions.createdAt), desc(chatVoiceSessions.id)).limit(50);
      const result: VoiceCallHistoryEntry[] = [];
      for (const row of rows) {
        try { await store.authorizeTask(tx, companyId, row.session.issueId, caller, false); }
        catch (error) { if (error instanceof HttpError && [403,404].includes(error.status)) continue; throw error; }
        result.push({ session: serializeVoiceSession(row.session), report: reportProjection(row.report ?? undefined) });
      }
      return result;
    });
  }
  async function callDetail(companyId: string, sessionId: string, caller: VoiceCaller): Promise<VoiceCallHistoryEntry> {
    const session = await ownedSession(companyId, sessionId, caller);
    const [report] = await db.select().from(chatVoiceReports).where(and(eq(chatVoiceReports.companyId, companyId), eq(chatVoiceReports.sessionId, session.id)));
    return { session: serializeVoiceSession(session), report: reportProjection(report) };
  }
  async function callbackPreference(companyId: string, endpointId: string, caller: VoiceCaller) {
    await endpointFor(companyId, endpointId);
    await db.transaction(tx => store.authorizeCaller(tx, companyId, caller));
    const [row] = await db.select().from(chatVoiceCallbacks).where(and(eq(chatVoiceCallbacks.companyId, companyId), eq(chatVoiceCallbacks.endpointId, endpointId), eq(chatVoiceCallbacks.userId, caller.id)));
    return row ? { phoneNumber: row.phoneNumber, enabled: row.enabled } : null;
  }
  async function saveCallbackPreference(companyId: string, endpointId: string, caller: VoiceCaller, preference: { phoneNumber: string; enabled: boolean }) {
    await endpointFor(companyId, endpointId);
    await db.transaction(async tx => {
      await store.authorizeCaller(tx, companyId, caller);
      await tx.insert(chatVoiceCallbacks).values({ companyId, endpointId, userId: caller.id, ...preference }).onConflictDoUpdate({ target: [chatVoiceCallbacks.companyId, chatVoiceCallbacks.endpointId, chatVoiceCallbacks.userId], set: { ...preference, updatedAt: new Date() } });
      await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: caller.id, action: "voice.callback.preference_updated", entityType: "chat_endpoint", entityId: endpointId, details: { enabled: preference.enabled } });
    });
    return preference;
  }
  const inbound = voiceInboundService(db, { ...options, start, voicePrompt: PHONE_VOICE_PROMPT, lowTrustVoicePrompt: LOW_TRUST_PHONE_VOICE_PROMPT });
  const unregisterAgentTools = registerSpekoVoiceRuntime(db, async (binding, invocationId) => {
    const preference = await callbackPreference(binding.companyId, binding.endpointId, binding.caller);
    if (!preference?.enabled) throw forbidden("Save and enable your callback number in this Speko connection first");
    const result = await start({ ...binding, mode: "outbound_phone", phoneNumber: preference.phoneNumber, idempotencyKey: invocationId, maxDurationSeconds: 600 });
    return { session: result.session };
  });
  /** Provider ports: endpointFor, start, tool, end, reconcile, report. */
  const ports = {
    speko: { provider: "speko" as const, capabilities: SPEKO_VOICE_CAPABILITIES, endpointFor: (companyId: string, endpointId: string) => endpointFor(companyId, endpointId), start, tool, end, reconcile, report: reports.reconcile },
    local_voice: { provider: "local_voice" as const, capabilities: LOCAL_VOICE_CAPABILITIES, endpointFor: (companyId: string, endpointId: string) => endpointFor(companyId, endpointId, ["local_voice"]), start: startLocal, tool: localTool, end, reconcile: reconcileLocal, report: async () => 0 },
  };
  return { start, inspect, end, tool, reconcile, registerReportWork, registerRecoveryWork, registerReplyWork, pushReplies, inbound, notification: store.notification, callbackPreference, saveCallbackPreference, history, callDetail, unregisterAgentTools,
    ports, local: { start: startLocal, tool: localTool, confirm: confirmLocal, operation: localOperation, end, reconcile: reconcileLocal, assertEnabled: localEnabled } };

}
export type VoiceSessionService = ReturnType<typeof voiceSessionService>;
