import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, chatConversations, chatDeliveries, chatEndpoints, chatPublications, chatVoiceConfirmations,
  chatVoiceOperations, chatVoiceReplies, chatVoiceSessions, chatVoiceToolCalls, companies, companyMemberships, connectionGrants, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, issueComments, issueThreadInteractions, issues, projects, toolApplications, toolConnectionInstalls, toolConnections,
} from "@paperclipai/db";
import { chatChannelService } from "../services/chat-channels.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { voiceSessionService } from "../services/voice/voice-session-service.js";
import { voiceSessionStore } from "../services/voice/voice-session-store.js";
import { LocalVoiceProtocolError } from "../services/voice/local-voice-protocol.js";
import type { InternalSetupState } from "../services/chat-channels/runtime-types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const support = await getEmbeddedPostgresTestSupport();

/**
 * Phase-1 local_voice control plane. Media and agent publication are fake:
 * tool messages are posted directly to the service and publications are
 * inserted as rows. Each run uses its own embedded Postgres and synthetic
 * company, user, agent and voice task.
 */
(support.supported ? describe : describe.skip)("local_voice phase-1 control plane", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const services: ReturnType<typeof voiceSessionService>[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-local-voice-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { for (const service of services) service.unregisterAgentTools(); await database?.cleanup(); });
  beforeEach(async () => { await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true, enableLocalVoice: true }); });

  async function fixture(options: { status?: string } = {}) {
    const companyId = randomUUID(), endpointId = randomUUID(), agentId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID(),
      issueId = randomUUID(), projectId = randomUUID(), callerId = `user-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Local voice test", issuePrefix: `L${companyId.slice(0, 7).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: callerId, status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Local voice test agent", role: "operator", status: "idle", adapterType: "paperclip_runner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Voice project", status: "in_progress" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Voice task", assigneeAgentId: agentId, status: options.status ?? "todo" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `chat:local_voice:${endpointId}`, name: "Local voice", type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Local voice", uid: endpointId, connectionPurpose: "channel", transport: "voice", config: { provider: "local_voice" }, status: "active", enabled: true });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "local_voice", publicId: randomUUID(), assignedAgentId: agentId, status: "active", setup: { step: "complete", runtimeGeneration: 1 } as InternalSetupState });
    const onQuestionAnswered = vi.fn();
    const credentials = vi.fn(async () => { throw new Error("local voice must never resolve provider credentials"); });
    const provider = vi.fn(() => { throw new Error("local voice must never construct a provider client"); });
    const service = voiceSessionService(db, { allowLocalBoard: false, credentials, provider: provider as never, onQuestionAnswered });
    services.push(service);
    const caller = { id: callerId, authority: "member" as const };
    const startInput = { companyId, endpointId, issueId, caller, idempotencyKey: randomUUID(), maxDurationSeconds: 600, bindingMode: "voice_task" as const };
    const started = await service.local.start(startInput);
    if (!started.media) throw new Error("expected local media");
    const sessionId = started.session.id, token = started.media.transportToken;
    const [session] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, sessionId));
    const conversationId = session.conversationId;
    const send = (message: unknown, opts: { token?: string; sessionId?: string; companyId?: string; caller?: typeof caller } = {}) =>
      service.local.tool(opts.companyId ?? companyId, opts.sessionId ?? sessionId, opts.caller ?? caller,
        Buffer.from(typeof message === "string" ? message : JSON.stringify(message)), opts.token ?? token);
    const sendRaw = (body: string) => service.local.tool(companyId, sessionId, caller, Buffer.from(body), token);
    const confirm = (draftId: string, revision: number, text: string) => service.local.confirm(companyId, sessionId, caller, { draftId, revision, text });
    const submit = (input: { text: string; draftId: string; revision: number; operationId?: string; toolCallId?: string }) => send({
      v: 1, type: "tool", toolCallId: input.toolCallId ?? `call_${randomUUID()}`, tool: "submit_request", operationId: input.operationId ?? randomUUID(),
      confirmation: { draftId: input.draftId, revision: input.revision }, args: { text: input.text } });
    const updates = (cursor: number, extra: { repeat?: boolean; toolCallId?: string } = {}) => send({
      v: 1, type: "tool", toolCallId: extra.toolCallId ?? `call_${randomUUID()}`, tool: "get_updates", args: { cursor, ...(extra.repeat ? { repeat: true } : {}) } });
    const answer = (interactionId: string, operationId = randomUUID(), optionIds = ["cobalt"]) => send({
      v: 1, type: "tool", toolCallId: `call_${randomUUID()}`, tool: "answer_question", operationId,
      args: { interactionId, answers: [{ questionId: "color", optionIds }] } });
    async function publication(payload: Record<string, unknown>, state: "streaming" | "published" | "pending" = "published") {
      const [row] = await db.insert(chatPublications).values({ companyId, endpointId, conversationId, issueId, idempotencyKey: randomUUID(), state, payload: payload as never }).returning();
      return row;
    }
    const store = voiceSessionStore(db, { allowLocalBoard: false });
    const counts = async () => ({
      deliveries: (await db.select({ id: chatDeliveries.id }).from(chatDeliveries).where(eq(chatDeliveries.companyId, companyId))).length,
      operations: (await db.select({ id: chatVoiceOperations.id }).from(chatVoiceOperations).where(eq(chatVoiceOperations.companyId, companyId))).length,
      toolCalls: (await db.select({ id: chatVoiceToolCalls.id }).from(chatVoiceToolCalls).where(eq(chatVoiceToolCalls.companyId, companyId))).length,
      wakeups: (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).length,
      comments: (await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.companyId, companyId))).length,
    });
    return { companyId, endpointId, agentId, connectionId, issueId, projectId, callerId, caller, service, store, started, sessionId, token, conversationId,
      send, sendRaw, confirm, submit, updates, answer, publication, counts, onQuestionAnswered, credentials, provider, startInput };
  }

  function wakeupMock() {
    return vi.fn(async (agentId: string, opts: any) => {
      const request = opts.durableChatRequest;
      if (!request) throw new Error("Voice requires a durable wakeup");
      await db.transaction(async (tx) => {
        await request.authorize(tx);
        await tx.insert(agentWakeupRequests).values({ id: request.id, companyId: request.companyId, agentId, source: opts.source ?? "assignment", triggerDetail: opts.triggerDetail, reason: opts.reason, payload: opts.payload, requestedByActorType: opts.requestedByActorType, requestedByActorId: opts.requestedByActorId, idempotencyKey: request.idempotencyKey, requestedAt: request.requestedAt, status: "queued" }).onConflictDoNothing();
      });
      return { accepted: true };
    });
  }
  async function drain(deliveryId: string) {
    const wakeup = wakeupMock();
    const chat = chatChannelService(db, { heartbeat: { wakeup: wakeup as never }, deferWebhookProcessing: true });
    try {
      await expect.poll(async () => {
        await chat.processPendingDeliveries(25, deliveryId);
        const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, deliveryId));
        return delivery?.state;
      }, { timeout: 15_000 }).toBe("processed");
    } finally { await chat.shutdown(); }
    return wakeup;
  }
  async function questionInteraction(f: Awaited<ReturnType<typeof fixture>>, kind: "ask_user_questions" | "request_confirmation" = "ask_user_questions") {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({ id, companyId: f.companyId, issueId: f.issueId, kind, status: "pending",
      createdByAgentId: f.agentId, addresseeUserId: f.callerId, effectiveResolverPolicy: "human_only",
      payload: kind === "ask_user_questions"
        ? { version: 1, questions: [{ id: "color", prompt: "Which color?", selectionMode: "single", required: true, allowOther: false, options: [{ id: "cobalt", label: "Cobalt" }] }] }
        : { version: 1, prompt: "Approve the purchase?" } as never });
    const pub = await f.publication({ text: kind === "ask_user_questions" ? "Which color?" : "Approve the purchase?", interactionId: id, progressState: "waiting_for_input" });
    await f.store.enqueuePublication(f.companyId, pub.id);
    return { id, publicationId: pub.id };
  }

  describe("session start and binding", () => {
    it("starts a browser-only voice_task session with a local:<uuid> provider session id and no provider contact", async () => {
      const f = await fixture();
      expect(f.started.media).toMatchObject({ provider: "local_voice", protocol: "voice.control.v1", bindingMode: "voice_task", sessionId: f.sessionId, generation: 1,
        controlUrl: `/api/companies/${f.companyId}/voice-sessions/${f.sessionId}/local-tools` });
      expect(f.started.media!.transportToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [session] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.sessionId));
      expect(session).toMatchObject({ mode: "browser", state: "connecting", bindingMode: "voice_task", bindingProjectId: f.projectId, issueId: f.issueId, assignedAgentId: f.agentId });
      expect(session.providerSessionId).toMatch(/^local:[0-9a-f-]{36}$/);
      const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, session.conversationId));
      expect(conversation.externalThreadId).toBe(`local_voice:${session.conversationId}`);
      expect(f.credentials).not.toHaveBeenCalled();
      expect(f.provider).not.toHaveBeenCalled();
      // The same key returns the session without reissuing the control token.
      const again = await f.service.local.start(f.startInput);
      expect(again).toEqual({ session: f.started.session });
    });
    it("rejects phone modes and missing binding mode with a clear failure instead of imitating a phone", async () => {
      const f = await fixture();
      await expect(f.service.local.start({ ...f.startInput, idempotencyKey: randomUUID(), mode: "outbound_phone", phoneNumber: "+12015551234" })).rejects.toMatchObject({ status: 409, details: { code: "local_voice_phone_unsupported" } });
      await expect(f.service.local.start({ ...f.startInput, idempotencyKey: randomUUID(), bindingMode: undefined })).rejects.toMatchObject({ status: 409, details: { code: "voice_binding_mode_invalid" } });
    });
    it("is default-off: with the flag off, start, tools, confirmations and operation lookups all fail with local_voice_disabled", async () => {
      const f = await fixture();
      await instanceSettingsService(db).updateExperimental({ enableLocalVoice: false });
      const draftId = randomUUID();
      await expect(f.service.local.start({ ...f.startInput, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403, details: { code: "local_voice_disabled" } });
      await expect(f.updates(0)).rejects.toMatchObject({ status: 403, details: { code: "local_voice_disabled" } });
      await expect(f.confirm(draftId, 1, "hello")).rejects.toMatchObject({ status: 403, details: { code: "local_voice_disabled" } });
      await expect(f.service.local.operation(f.companyId, f.sessionId, f.caller, randomUUID())).rejects.toMatchObject({ status: 403 });
      expect(await f.counts()).toMatchObject({ deliveries: 0, toolCalls: 0, operations: 0 });
      expect(await db.select().from(chatVoiceConfirmations).where(eq(chatVoiceConfirmations.sessionId, f.sessionId))).toHaveLength(0);
    });
    it("a local endpoint is invisible to the Speko start path and a Speko-style start never reaches a local endpoint", async () => {
      const f = await fixture();
      await expect(f.service.start({ companyId: f.companyId, endpointId: f.endpointId, issueId: f.issueId, caller: f.caller, idempotencyKey: randomUUID(), maxDurationSeconds: 600 })).rejects.toMatchObject({ status: 404 });
      await expect(f.service.ports.speko.endpointFor(f.companyId, f.endpointId)).rejects.toMatchObject({ status: 404 });
      await expect(f.service.ports.local_voice.endpointFor(f.companyId, f.endpointId)).resolves.toMatchObject({ provider: "local_voice" });
      expect(f.service.ports.local_voice.capabilities).toMatchObject({ browser: true, outboundPhone: false, inboundPhone: false, providerMedia: false, replyPush: false, signedWebhooks: false });
    });
  });

  describe("original text and empty input", () => {
    it("never confirms or submits an empty draft", async () => {
      const f = await fixture();
      for (const text of ["", "   ", "\n\t "]) await expect(f.confirm(randomUUID(), 1, text)).rejects.toMatchObject({ status: 409, details: { code: "voice_confirmation_empty" } });
      for (const text of ["", "   "]) await expect(f.submit({ text, draftId: randomUUID(), revision: 1 })).rejects.toBeInstanceOf(LocalVoiceProtocolError);
      expect(await db.select().from(chatVoiceConfirmations).where(eq(chatVoiceConfirmations.sessionId, f.sessionId))).toHaveLength(0);
      expect(await f.counts()).toMatchObject({ deliveries: 0, operations: 0, toolCalls: 0 });
    });
    it("delivers exactly the confirmed text: the confirmed hash equals the hash of the comment the agent receives", async () => {
      const f = await fixture();
      const draftId = randomUUID(), text = "Compare the Résumé drafts — 日本語 too.\r\n  Keep  line two.\n\n\t– end";
      // Only the canonical form (no outer whitespace) can be confirmed, because the work queue trims the comment.
      await expect(f.confirm(draftId, 1, `  ${text}\n`)).rejects.toMatchObject({ status: 409, details: { code: "voice_confirmation_not_canonical" } });
      const receipt = await f.confirm(draftId, 1, text);
      expect(receipt).toMatchObject({ draftId, revision: 1, state: "confirmed", textSha256: sha256(text), textLength: text.length });
      const { result } = await f.submit({ text, draftId, revision: 1 });
      expect(result).toMatchObject({ status: "accepted", receipt: { state: "accepted", tool: "submit_request", textSha256: receipt.textSha256 } });
      const deliveryId = (result as { requestId: string }).requestId;
      const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, deliveryId));
      expect(sha256((delivery.normalizedEvent as { message: { text: string } }).message.text)).toBe(receipt.textSha256);
      await drain(deliveryId);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(comments).toHaveLength(1);
      expect(sha256(comments[0].body)).toBe(receipt.textSha256);
      expect(comments[0].authorUserId).toBe(f.callerId);
      const [confirmation] = await db.select().from(chatVoiceConfirmations).where(eq(chatVoiceConfirmations.sessionId, f.sessionId));
      expect(confirmation).toMatchObject({ state: "consumed", operationId: (result as { operationId: string }).operationId });
    });
    it("never dispatches truncated, changed or unconfirmed text", async () => {
      const f = await fixture();
      const draftId = randomUUID(), text = "Book the 9:40 train and email the receipt";
      await f.confirm(draftId, 1, text);
      await expect(f.submit({ text: text.slice(0, -12), draftId, revision: 1 })).rejects.toMatchObject({ status: 409, details: { code: "voice_confirmation_mismatch" } });
      await expect(f.submit({ text: `${text}!`, draftId, revision: 1 })).rejects.toMatchObject({ status: 409, details: { code: "voice_confirmation_mismatch" } });
      await expect(f.submit({ text, draftId: randomUUID(), revision: 1 })).rejects.toMatchObject({ status: 409, details: { code: "voice_confirmation_required" } });
      await expect(f.submit({ text, draftId, revision: 2 })).rejects.toMatchObject({ status: 409, details: { code: "voice_confirmation_required" } });
      expect(await f.counts()).toMatchObject({ deliveries: 0, operations: 0, toolCalls: 0 });
    });
    it("a newer revision invalidates older ones; stale, conflicting and post-submit confirmations are rejected", async () => {
      const f = await fixture();
      const draftId = randomUUID();
      await f.confirm(draftId, 1, "Order paper");
      await f.confirm(draftId, 2, "Order paper and toner");
      expect(await f.confirm(draftId, 2, "Order paper and toner")).toMatchObject({ revision: 2, state: "confirmed" });
      await expect(f.confirm(draftId, 2, "Order toner")).rejects.toMatchObject({ status: 409, details: { code: "voice_confirmation_conflict" } });
      await expect(f.confirm(draftId, 1, "Order something")).rejects.toMatchObject({ status: 409, details: { code: "voice_confirmation_conflict" } });
      const otherDraft = randomUUID();
      await f.confirm(otherDraft, 3, "Later");
      await expect(f.confirm(otherDraft, 2, "Earlier")).rejects.toMatchObject({ status: 409, details: { code: "voice_confirmation_stale" } });
      await expect(f.submit({ text: "Order paper", draftId, revision: 1 })).rejects.toMatchObject({ status: 409, details: { code: "voice_confirmation_superseded" } });
      expect(await f.counts()).toMatchObject({ deliveries: 0 });
      await f.submit({ text: "Order paper and toner", draftId, revision: 2 });
      await expect(f.confirm(draftId, 3, "Order paper, toner and pens")).rejects.toMatchObject({ status: 409, details: { code: "voice_draft_submitted" } });
      await expect(f.submit({ text: "Order paper and toner", draftId, revision: 2 })).rejects.toMatchObject({ status: 409, details: { code: "voice_confirmation_consumed" } });
      const rows = await db.select().from(chatVoiceConfirmations).where(and(eq(chatVoiceConfirmations.sessionId, f.sessionId), eq(chatVoiceConfirmations.draftId, draftId)));
      expect(Object.fromEntries(rows.map((row) => [row.revision, row.state]))).toEqual({ 1: "superseded", 2: "consumed" });
      expect(await f.counts()).toMatchObject({ deliveries: 1, operations: 1 });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.sessionId), eq(activityLog.action, "voice.confirmation.created")))).toHaveLength(3);
    });
  });

  describe("tool reliability", () => {
    it("rejects non-JSON, unknown tools, wrong versions and extra identity fields with zero deliveries and zero wakeups", async () => {
      const f = await fixture();
      const draftId = randomUUID(), text = "Valid request";
      await f.confirm(draftId, 1, text);
      const valid = { v: 1, type: "tool", toolCallId: "call_1", tool: "submit_request", operationId: randomUUID(), confirmation: { draftId, revision: 1 }, args: { text } };
      const cases: [string, string, string][] = [
        ["non-JSON", "{not json", "invalid_json"],
        ["trailing garbage", `${JSON.stringify(valid)}x`, "invalid_json"],
        ["JSON array", "[]", "invalid_message"],
        ["unknown tool", JSON.stringify({ ...valid, tool: "cancel_work" }), "invalid_message"],
        ["fourth tool", JSON.stringify({ v: 1, type: "tool", toolCallId: "c", tool: "list_tasks", args: {} }), "invalid_message"],
        ["wrong version", JSON.stringify({ ...valid, v: 2 }), "invalid_message"],
        ["extra companyId", JSON.stringify({ ...valid, companyId: randomUUID() }), "invalid_message"],
        ["extra agentId", JSON.stringify({ ...valid, agentId: randomUUID() }), "invalid_message"],
        ["extra args.issueId", JSON.stringify({ ...valid, args: { text, issueId: randomUUID() } }), "invalid_message"],
        ["extra confirmation field", JSON.stringify({ ...valid, confirmation: { draftId, revision: 1, textSha256: sha256(text) } }), "invalid_message"],
        ["missing operationId", JSON.stringify({ ...valid, operationId: undefined }), "invalid_message"],
        ["non-uuid interaction", JSON.stringify({ v: 1, type: "tool", toolCallId: "c", tool: "answer_question", operationId: randomUUID(), args: { interactionId: "not-a-uuid", answers: [{ questionId: "q", optionIds: ["a"] }] } }), "invalid_message"],
        ["oversized", JSON.stringify({ ...valid, args: { text: "x".repeat(70_000) } }), "body_too_large"],
      ];
      for (const [label, body, code] of cases) {
        await expect(f.sendRaw(body), label).rejects.toMatchObject({ code });
      }
      // A well-formed answer for an interaction never presented to this session.
      await expect(f.answer(randomUUID())).rejects.toMatchObject({ status: 403 });
      expect(await f.counts()).toMatchObject({ deliveries: 0, operations: 0, toolCalls: 0, wakeups: 0, comments: 0 });
      const [confirmation] = await db.select().from(chatVoiceConfirmations).where(eq(chatVoiceConfirmations.sessionId, f.sessionId));
      expect(confirmation.state).toBe("confirmed");
    });
    it("rejects a wrong control token and a token from another session", async () => {
      const f = await fixture(), g = await fixture();
      await expect(f.updates(0).then(() => f.send({ v: 1, type: "tool", toolCallId: "x", tool: "get_updates", args: { cursor: 0 } }, { token: g.token }))).rejects.toMatchObject({ status: 403 });
      await expect(f.send({ v: 1, type: "tool", toolCallId: "y", tool: "get_updates", args: { cursor: 0 } }, { token: "A".repeat(43) })).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("idempotency and unknown submit", () => {
    it("one operation, one delivery and one durable wakeup; same key returns the original receipt; changed text is 409", async () => {
      const f = await fixture();
      const draftId = randomUUID(), operationId = randomUUID(), text = "Draft the vendor email";
      await f.confirm(draftId, 1, text);
      const first = await f.submit({ text, draftId, revision: 1, operationId });
      const firstReceipt = (first.result as { receipt: Record<string, unknown> }).receipt;
      expect(firstReceipt).toMatchObject({ operationId, state: "accepted", sessionId: f.sessionId, textSha256: sha256(text) });
      expect(typeof firstReceipt.deliveryId).toBe("string");
      // Retries with new tool call ids (e.g. after a reconnect) and concurrent duplicates.
      const retries = await Promise.all([1, 2, 3].map(() => f.submit({ text, draftId, revision: 1, operationId })));
      for (const retry of retries) expect(retry.result).toEqual(first.result);
      // Same tool call id, same body: the stored response.
      await expect(f.submit({ text: `${text} now`, draftId, revision: 1, operationId })).rejects.toMatchObject({ status: 409, details: { code: "voice_operation_conflict", operationId } });
      expect(await f.counts()).toMatchObject({ deliveries: 1, operations: 1 });
      const wakeup = await drain(firstReceipt.deliveryId as string);
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(await f.counts()).toMatchObject({ deliveries: 1, operations: 1, wakeups: 1, comments: 1 });
      // After the drain a further retry still returns the same receipt and never re-dispatches.
      expect((await f.submit({ text, draftId, revision: 1, operationId })).result).toEqual(first.result);
      expect(await f.counts()).toMatchObject({ deliveries: 1, operations: 1, wakeups: 1, comments: 1 });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.sessionId), eq(activityLog.action, "voice.operation.accepted")))).toHaveLength(1);
    });
    it("concurrent first submits with one key create exactly one operation and delivery", async () => {
      const f = await fixture();
      const draftId = randomUUID(), operationId = randomUUID(), text = "Concurrent submit";
      await f.confirm(draftId, 1, text);
      const settled = await Promise.allSettled([1, 2, 3, 4].map(() => f.submit({ text, draftId, revision: 1, operationId })));
      const ok = settled.filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof f.submit>>> => s.status === "fulfilled");
      expect(ok).toHaveLength(4);
      for (const s of ok) expect(s.value.result).toEqual(ok[0].value.result);
      expect(await f.counts()).toMatchObject({ deliveries: 1, operations: 1 });
    });
    it("an unknown outcome keeps its key: lookup returns not_found before acceptance and the stored receipt after", async () => {
      const f = await fixture();
      const draftId = randomUUID(), operationId = randomUUID(), text = "Unknown outcome request";
      expect(await f.service.local.operation(f.companyId, f.sessionId, f.caller, operationId)).toEqual({ operationId, state: "not_found" });
      // A failed attempt (no confirmation yet) leaves no row; the key stays usable.
      await expect(f.submit({ text, draftId, revision: 1, operationId })).rejects.toMatchObject({ status: 409, details: { code: "voice_confirmation_required" } });
      expect(await f.service.local.operation(f.companyId, f.sessionId, f.caller, operationId)).toEqual({ operationId, state: "not_found" });
      await f.confirm(draftId, 1, text);
      const accepted = await f.submit({ text, draftId, revision: 1, operationId });
      // The client lost the response: lookup with the SAME key returns the original receipt.
      const status = await f.service.local.operation(f.companyId, f.sessionId, f.caller, operationId);
      expect(status).toEqual((accepted.result as { receipt: unknown }).receipt);
      expect((await f.submit({ text, draftId, revision: 1, operationId })).result).toEqual(accepted.result);
      expect(await f.counts()).toMatchObject({ deliveries: 1, operations: 1 });
      // Another caller cannot read the receipt.
      await expect(f.service.local.operation(f.companyId, f.sessionId, { id: "user-other", authority: "member" }, operationId)).rejects.toMatchObject({ status: 403 });
    });
    it("shows 'saved' only together with a durable receipt", async () => {
      const f = await fixture();
      const draftId = randomUUID(), text = "Saved check";
      await expect(f.submit({ text, draftId, revision: 1 })).rejects.toMatchObject({ status: 409 });
      await f.confirm(draftId, 1, text);
      const { result } = await f.submit({ text, draftId, revision: 1 });
      const body = result as { message: string; receipt: { deliveryId: string; operationId: string } };
      expect(body.message).toMatch(/saved/i);
      const [row] = await db.select().from(chatVoiceOperations).where(eq(chatVoiceOperations.operationId, body.receipt.operationId));
      expect(row).toMatchObject({ deliveryId: body.receipt.deliveryId, state: "accepted", tool: "submit_request" });
      const toolCalls = await db.select().from(chatVoiceToolCalls).where(eq(chatVoiceToolCalls.sessionId, f.sessionId));
      for (const call of toolCalls) {
        if (typeof call.response.message === "string" && /saved/i.test(call.response.message)) expect(call.response.receipt).toBeTruthy();
      }
    });
  });

  describe("ordering and replay", () => {
    it("a later publication completing first, a behind or ahead cursor and duplicate hints lose nothing and re-dispatch nothing", async () => {
      const f = await fixture();
      await f.updates(0); // connects the session
      const early = await f.publication({ text: "First answer (still streaming)" }, "streaming");
      const late = await f.publication({ text: "Second answer" });
      await f.store.enqueuePublication(f.companyId, early.id);
      await f.store.enqueuePublication(f.companyId, late.id);
      // Duplicate hint: no second reply row.
      await f.store.enqueuePublication(f.companyId, late.id);
      expect(await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, f.sessionId))).toHaveLength(2);
      const first = (await f.updates(0)).result as { cursor: number; updates: { publicationId: string; text: string }[]; status: string };
      // Unpublished output is never returned.
      expect(first.updates.map((u) => u.publicationId)).toEqual([late.id]);
      expect(first.cursor).toBe(2);
      // Behind cursor: the delivered marker is authoritative, so no redelivery.
      expect((await f.updates(0)).result).toMatchObject({ status: "pending", updates: [] });
      // The earlier stream publishes after the client cursor passed it; it is still delivered once.
      await db.update(chatPublications).set({ state: "published" }).where(eq(chatPublications.id, early.id));
      const second = (await f.updates(2)).result as typeof first;
      expect(second.updates.map((u) => u.publicationId)).toEqual([early.id]);
      expect((await f.updates(2)).result).toMatchObject({ status: "pending", updates: [] });
      // Ahead cursor is a conflict, not silent loss.
      await expect(f.updates(99)).rejects.toMatchObject({ status: 409 });
      // Replaying the same tool call returns its stored response; it never re-dispatches.
      const toolCallId = `call_${randomUUID()}`;
      const third = await f.updates(2, { toolCallId });
      expect((await f.updates(2, { toolCallId })).result).toEqual(third.result);
      const replies = await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, f.sessionId));
      expect(replies.every((r) => r.deliveredAt)).toBe(true);
      expect(await f.counts()).toMatchObject({ deliveries: 0 });
    });
    it("progress never poses as a final answer", async () => {
      const f = await fixture();
      const progress = await f.publication({ text: "Working on it", progressState: "working" });
      await f.store.enqueuePublication(f.companyId, progress.id);
      const result = (await f.updates(0)).result as { status: string; updates: unknown[]; work: { state: string } };
      expect(result.status).toBe("pending");
      expect(result.updates).toEqual([]);
      expect(result.work.state).not.toMatch(/complete|final|done/i);
      expect(await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, f.sessionId))).toHaveLength(0);
    });
    it("local publications are pull-only: a pending get_updates response carries no phone push promise", async () => {
      const f = await fixture();
      const result = (await f.updates(0)).result as Record<string, unknown>;
      expect(result).not.toHaveProperty("delivery");
    });
  });

  describe("identity isolation", () => {
    it("rejects changed company, user, agent, project or assignee", async () => {
      const f = await fixture(), other = await fixture();
      const ok = () => f.updates(0);
      await ok();
      await expect(f.send({ v: 1, type: "tool", toolCallId: "c1", tool: "get_updates", args: { cursor: 0 } }, { companyId: other.companyId })).rejects.toMatchObject({ status: 404 });
      await expect(f.send({ v: 1, type: "tool", toolCallId: "c2", tool: "get_updates", args: { cursor: 0 } }, { caller: other.caller })).rejects.toMatchObject({ status: 403 });
      await expect(f.send({ v: 1, type: "tool", toolCallId: "c3", tool: "get_updates", args: { cursor: 0 } }, { caller: { ...f.caller, authority: "instance_admin" as never } })).rejects.toMatchObject({ status: 403 });
      const otherAgent = randomUUID();
      await db.insert(agents).values({ id: otherAgent, companyId: f.companyId, name: "Other agent", role: "operator", status: "idle", adapterType: "paperclip_runner" });
      await db.update(issues).set({ assigneeAgentId: otherAgent }).where(eq(issues.id, f.issueId));
      await expect(ok()).rejects.toMatchObject({ status: 403 });
      await db.update(issues).set({ assigneeAgentId: f.agentId }).where(eq(issues.id, f.issueId));
      await ok();
      await db.update(chatEndpoints).set({ assignedAgentId: otherAgent }).where(eq(chatEndpoints.id, f.endpointId));
      await expect(ok()).rejects.toMatchObject({ status: 403 });
      await db.update(chatEndpoints).set({ assignedAgentId: f.agentId }).where(eq(chatEndpoints.id, f.endpointId));
      await ok();
      const otherProject = randomUUID();
      await db.insert(projects).values({ id: otherProject, companyId: f.companyId, name: "Other project", status: "in_progress" });
      await db.update(issues).set({ projectId: otherProject }).where(eq(issues.id, f.issueId));
      await expect(ok()).rejects.toMatchObject({ status: 403 });
      await db.update(issues).set({ projectId: f.projectId }).where(eq(issues.id, f.issueId));
      await ok();
      // Session rows cannot be re-pointed at another task.
      const [moved] = await db.insert(issues).values({ companyId: f.companyId, projectId: f.projectId, title: "Other task", assigneeAgentId: f.agentId, status: "todo" }).returning();
      await db.update(chatVoiceSessions).set({ issueId: moved.id }).where(eq(chatVoiceSessions.id, f.sessionId));
      await expect(ok()).rejects.toMatchObject({ status: 403 });
      await db.update(chatVoiceSessions).set({ issueId: f.issueId }).where(eq(chatVoiceSessions.id, f.sessionId));
      await ok();
      expect(await f.counts()).toMatchObject({ deliveries: 0 });
    });
    it("a second session for the same caller and task returns 409 without preempting the first", async () => {
      const f = await fixture();
      await f.updates(0);
      await expect(f.service.local.start({ ...f.startInput, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409, details: { code: "voice_call_already_active", sessionId: f.sessionId } });
      const [session] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.sessionId));
      expect(session.state).toBe("active");
      await expect(f.updates(0)).resolves.toMatchObject({ result: { status: "pending" } });
      expect(await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.companyId, f.companyId))).toHaveLength(1);
    });
    it("local:<uuid> and speko threads are validated separately by the voice runtime", async () => {
      const { createVoiceRuntime } = await import("../services/voice/voice-runtime.js");
      const persistence = {} as never;
      const speko = createVoiceRuntime({ companyId: randomUUID(), endpointId: randomUUID(), userName: "agent", persistence });
      const local = createVoiceRuntime({ companyId: randomUUID(), endpointId: randomUUID(), userName: "agent", persistence, provider: "local_voice" });
      const id = randomUUID();
      expect(speko.provider).toBe("speko");
      expect(local.provider).toBe("local_voice");
      expect(() => speko.thread(`local_voice:${id}`)).toThrow("Invalid voice conversation identity");
      expect(() => local.thread(`speko:${id}`)).toThrow("Invalid voice conversation identity");
      expect(speko.thread(`speko:${id}`).id).toBe(`speko:${id}`);
      expect(local.thread(`local_voice:${id}`).id).toBe(`local_voice:${id}`);
    });
  });

  describe("revocation", () => {
    it("rejects tool calls after the flag is turned off, and reconcile ends the live session", async () => {
      const f = await fixture();
      await f.updates(0);
      await instanceSettingsService(db).updateExperimental({ enableLocalVoice: false });
      await expect(f.updates(0)).rejects.toMatchObject({ status: 403, details: { code: "local_voice_disabled" } });
      await f.service.local.reconcile(100);
      const [session] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.sessionId));
      expect(session).toMatchObject({ state: "ended", errorCode: "local_voice_revoked" });
      await instanceSettingsService(db).updateExperimental({ enableLocalVoice: true });
      await expect(f.updates(0)).rejects.toMatchObject({ status: 403 });
    });
    it("rejects tool calls when chat connectors are turned off", async () => {
      const f = await fixture();
      await instanceSettingsService(db).updateExperimental({ enableChatConnectors: false });
      await expect(f.updates(0)).rejects.toMatchObject({ status: 403, details: { code: "local_voice_disabled" } });
    });
    it("rejects tool calls after a grant is revoked or the install is removed", async () => {
      const f = await fixture();
      const [grant] = await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.connectionId, kind: "organization", isDefault: true }).returning();
      const [install] = await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: f.connectionId, targetType: "agent", targetId: f.agentId }).returning();
      await f.updates(0);
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, grant.id));
      await expect(f.updates(0)).rejects.toMatchObject({ status: 403 });
      await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, grant.id));
      await f.updates(0);
      await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.id, install.id));
      await expect(f.updates(0)).rejects.toMatchObject({ status: 403 });
      const draftId = randomUUID();
      await expect(f.confirm(draftId, 1, "after uninstall")).rejects.toMatchObject({ status: 403 });
      expect(await f.counts()).toMatchObject({ deliveries: 0 });
    });
    it("rejects tool calls after membership is removed", async () => {
      const f = await fixture();
      await f.updates(0);
      await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, f.companyId));
      await expect(f.updates(0)).rejects.toMatchObject({ status: 403 });
    });
    it("never returns a withdrawn publication and cannot answer its question", async () => {
      const f = await fixture();
      const pub = await f.publication({ text: "Approved then withdrawn" });
      await f.store.enqueuePublication(f.companyId, pub.id);
      await db.update(chatPublications).set({ state: "cancelled" }).where(eq(chatPublications.id, pub.id));
      expect((await f.updates(0)).result).toMatchObject({ status: "pending", updates: [] });
      const q = await questionInteraction(f);
      expect(((await f.updates(0)).result as { updates: unknown[] }).updates).toHaveLength(1);
      await db.update(chatPublications).set({ state: "cancelled" }).where(eq(chatPublications.id, q.publicationId));
      await expect(f.answer(q.id)).rejects.toMatchObject({ status: 403 });
      const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, q.id));
      expect(interaction.status).toBe("pending");
    });
    it("rejects tool calls after the session expires, and reconcile marks it expired", async () => {
      const f = await fixture();
      await f.updates(0);
      await db.update(chatVoiceSessions).set({ createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 1000) }).where(eq(chatVoiceSessions.id, f.sessionId));
      await expect(f.updates(0)).rejects.toMatchObject({ status: 403 });
      await f.service.local.reconcile(100);
      const [session] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.sessionId));
      expect(session.state).toBe("expired");
    });
    it("rejects tool calls after the session ends", async () => {
      const f = await fixture();
      await f.updates(0);
      const ended = await f.service.local.end(f.companyId, f.sessionId, f.caller);
      expect(ended.state).toBe("ended");
      expect(f.provider).not.toHaveBeenCalled();
      await expect(f.updates(0)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("pending question", () => {
    it("writes only to a presented, pending ask_user_questions interaction", async () => {
      const f = await fixture();
      const q = await questionInteraction(f);
      const operationId = randomUUID();
      // Not yet presented to this session.
      await expect(f.answer(q.id, operationId)).rejects.toMatchObject({ status: 403 });
      const presented = (await f.updates(0)).result as { updates: { question?: { interactionId: string } }[]; work: { state: string } };
      expect(presented.updates[0].question?.interactionId).toBe(q.id);
      expect(presented.work.state).toBe("waiting_for_input");
      const answered = await f.answer(q.id, operationId);
      expect(answered.result).toMatchObject({ status: "answered", interactionId: q.id, receipt: { operationId, state: "accepted", tool: "answer_question" } });
      expect(f.onQuestionAnswered).toHaveBeenCalledWith(q.id);
      // Same key returns the same receipt; a different answer on the same key is a conflict.
      expect((await f.answer(q.id, operationId)).result).toEqual(answered.result);
      await expect(f.answer(q.id, operationId, ["other"])).rejects.toMatchObject({ status: 409, details: { code: "voice_operation_conflict" } });
      // A resolved question takes no further writes under a new key.
      await expect(f.answer(q.id)).rejects.toMatchObject({ status: 409, details: { code: "voice_question_not_pending" } });
      const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, q.id));
      expect(interaction).toMatchObject({ status: "answered", resolvedByUserId: f.callerId });
      expect(await f.counts()).toMatchObject({ operations: 1, deliveries: 0 });
    });
    it("request_confirmation gets zero writes even when presented", async () => {
      const f = await fixture();
      const q = await questionInteraction(f, "request_confirmation");
      const before = (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, q.id)))[0];
      await f.updates(0);
      await expect(f.answer(q.id)).rejects.toMatchObject({ status: 409, details: { code: "voice_question_not_pending" } });
      const after = (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, q.id)))[0];
      expect(after).toEqual(before);
      expect(f.onQuestionAnswered).not.toHaveBeenCalled();
      expect(await f.counts()).toMatchObject({ operations: 0, deliveries: 0 });
    });
  });

  describe("drain through the real chat work queue", () => {
    it("a local_voice delivery becomes one issue comment and one durable wakeup; follow-ups stay on the same task", async () => {
      const f = await fixture();
      const texts = ["Research the shipping options", "Also compare the delivery dates"];
      let wakeups = 0;
      for (const [index, text] of texts.entries()) {
        const draftId = randomUUID();
        await f.confirm(draftId, 1, text);
        const { result } = await f.submit({ text, draftId, revision: 1 });
        const wakeup = await drain((result as { requestId: string }).requestId);
        wakeups += wakeup.mock.calls.length;
        expect(wakeups).toBe(index + 1);
      }
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(comments.map((c) => c.body).sort()).toEqual([...texts].sort());
      expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
      expect(await f.counts()).toMatchObject({ deliveries: 2, operations: 2, wakeups: 2 });
    });
  });
});
