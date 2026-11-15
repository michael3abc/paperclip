import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { issueService } from "../issues.js";
import { CHAT_INPUT_DISPATCH_KEY, declaredVoiceReplyOperations, recordChatInputDispatch, verifiedVoiceReplyProvenance } from "./chat-input-provenance.js";

describe("voice response source declarations", () => {
  it("requires one complete explicit machine line rather than mentions or guessed IDs", () => {
    const first = randomUUID(), second = randomUUID();
    expect(declaredVoiceReplyOperations(`回答\n語音回覆來源：${first}, ${second}, ${first}`)).toEqual([first, second]);
    for (const body of [first, `語音回覆來源：${first} unknown`, `語音回覆來源：${first}\n語音回覆來源：${second}`,
      `請依語音回覆來源：${first} 回答`, `語音回覆來源：${first}, invalid`]) expect(declaredVoiceReplyOperations(body)).toEqual([]);
  });
});

(support.supported ? describe : describe.skip)("immutable voice answer provenance", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startRecoveryPostgres("voice-answer-provenance-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const scope = { companyId: randomUUID(), issueId: randomUUID(), agentId: randomUUID(), runId: randomUUID() };
    const userId = randomUUID(), sessionId = randomUUID();
    await db.insert(companies).values({ id: scope.companyId, name: "Voice input boundary", issuePrefix: `V${scope.companyId.slice(0, 8).toUpperCase()}` });
    await db.insert(agents).values({ id: scope.agentId, companyId: scope.companyId, name: "Main", role: "engineer", adapterType: "process", status: "idle" });
    await db.insert(issues).values({ id: scope.issueId, companyId: scope.companyId, title: "Voice fixture", status: "in_progress",
      conversationAgentId: scope.agentId, conversationUserId: userId, conversationSessionGeneration: 1, assigneeAgentId: scope.agentId });
    const context = { issueId: scope.issueId, conversationSessionGeneration: 1 };
    await db.insert(heartbeatRuns).values({ id: scope.runId, companyId: scope.companyId, agentId: scope.agentId, status: "running",
      startedAt: new Date(), contextSnapshot: context, runnerProfileJson: { preserved: "runtime profile" } });
    async function input(voice = true) {
      const operationId = randomUUID();
      const [comment] = await db.insert(issueComments).values({ companyId: scope.companyId, issueId: scope.issueId,
        authorUserId: userId, authorType: "user", body: "A harmless fixture question", clientRequestId: operationId,
        ...(voice ? { metadata: { version: 1, voiceInput: { sessionId },
          sections: [{ rows: [{ type: "text", text: "Voice" }] }] } } : {}) }).returning();
      return { id: comment!.id, operationId };
    }
    const first = await input();
    const body = (...operations: string[]) => `測試回答\n語音回覆來源：${operations.join(", ")}\n語音摘要：這是測試回答。`;
    return { scope, context, first, input, body,
      launch: () => recordChatInputDispatch(db, scope, { ...context, wakeCommentIds: [first.id] }),
      resolve: (text: string) => verifiedVoiceReplyProvenance(db, scope, text),
      run: () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId)).then(rows => rows[0]!),
    };
  }

  it("binds a declared initial source and preserves the original launch envelope through coalescence", async () => {
    const f = await fixture(), second = await f.input();
    await f.launch();
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.context, wakeCommentIds: [f.first.id, second.id] } }).where(eq(heartbeatRuns.id, f.scope.runId));
    await recordChatInputDispatch(db, f.scope, { ...f.context, wakeCommentIds: [f.first.id, second.id] });
    expect((await f.run()).runnerProfileJson).toMatchObject({ preserved: "runtime profile", [CHAT_INPUT_DISPATCH_KEY]: { sourceCommentIds: [f.first.id] } });
    expect(await f.resolve(f.body(f.first.operationId))).toEqual({ version: 1, runId: f.scope.runId, sourceCommentIds: [f.first.id] });
    expect(await f.resolve(f.body(second.operationId))).toBeNull();
    expect(await f.resolve(f.body(f.first.operationId, second.operationId))).toBeNull();
  });

  it("only accepts acknowledged same-run supplements and never expands a saved earlier answer", async () => {
    const f = await fixture(), second = await f.input();
    await f.launch();
    const svc = issueService(db);
    const original = await svc.addComment(f.scope.issueId, f.body(f.first.operationId), { agentId: f.scope.agentId, runId: f.scope.runId },
      { metadata: { version: 1, sections: [{ title: "Retained", rows: [{ type: "text", text: "Existing metadata" }] }] } });
    expect(original.metadata).toMatchObject({ voiceReply: { sourceCommentIds: [f.first.id] }, sections: [{ title: "Retained" }] });
    for (const status of ["sending", "uncertain", "rejected", "acknowledged"]) {
      await db.update(heartbeatRuns).set({ resultJson: { queuedSteeringAcknowledgements: { [second.id]: { status, queueId: randomUUID(), turnId: "native-turn" } } },
        contextSnapshot: { ...f.context, wakeCommentIds: [f.first.id, second.id] } }).where(eq(heartbeatRuns.id, f.scope.runId));
      const proof = await f.resolve(f.body(second.operationId));
      if (status === "acknowledged") expect(proof?.sourceCommentIds).toEqual([second.id]);
      else expect(proof).toBeNull();
    }
    const later = await svc.addComment(f.scope.issueId, f.body(f.first.operationId, second.operationId), { agentId: f.scope.agentId, runId: f.scope.runId });
    expect(later.metadata).toMatchObject({ voiceReply: { sourceCommentIds: [f.first.id, second.id] } });
    const duplicate = await svc.addComment(f.scope.issueId, f.body(f.first.operationId), { agentId: f.scope.agentId, runId: f.scope.runId });
    expect(duplicate.id).toBe(original.id);
    const [saved] = await db.select().from(issueComments).where(eq(issueComments.id, original.id));
    expect(saved?.metadata).toMatchObject({ voiceReply: { sourceCommentIds: [f.first.id] } });
  });

  it("requires dispatch, an authenticated running scope, voice input and an explicit source", async () => {
    const f = await fixture();
    expect(await f.resolve(f.body(f.first.operationId))).toBeNull();
    await f.launch();
    expect(await f.resolve("語音摘要：沒有來源的答案")).toBeNull();
    expect(await verifiedVoiceReplyProvenance(db, { ...f.scope, companyId: randomUUID() }, f.body(f.first.operationId))).toBeNull();
    expect(await verifiedVoiceReplyProvenance(db, { ...f.scope, agentId: randomUUID() }, f.body(f.first.operationId))).toBeNull();
    expect(await verifiedVoiceReplyProvenance(db, { ...f.scope, issueId: randomUUID() }, f.body(f.first.operationId))).toBeNull();
    const text = await f.input(false);
    await db.update(heartbeatRuns).set({ resultJson: { queuedSteeringAcknowledgements: { [text.id]: { status: "acknowledged", queueId: randomUUID(), turnId: "turn" } } } }).where(eq(heartbeatRuns.id, f.scope.runId));
    expect(await f.resolve(f.body(text.operationId))).toBeNull();
    for (const patch of [{ status: "queued", startedAt: null }, { status: "cancelled", startedAt: new Date() },
      { status: "running", contextSnapshot: { ...f.context, conversationSessionGeneration: 2 } }]) {
      await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, f.scope.runId));
      expect(await f.resolve(f.body(f.first.operationId))).toBeNull();
    }
  });

  it("does not backfill a missing proof during a later publication upgrade", async () => {
    const f = await fixture(), second = await f.input();
    await f.launch();
    const svc = issueService(db), actor = { agentId: f.scope.agentId, runId: f.scope.runId };
    const first = await svc.addComment(f.scope.issueId, f.body(second.operationId), actor);
    expect(first.metadata).not.toHaveProperty("voiceReply");
    await db.update(heartbeatRuns).set({ resultJson: { queuedSteeringAcknowledgements: { [second.id]: {
      status: "acknowledged", queueId: randomUUID(), turnId: "turn",
    } } } }).where(eq(heartbeatRuns.id, f.scope.runId));
    const upgraded = await svc.addComment(f.scope.issueId, f.body(second.operationId), actor, { authorizationReason: "allow_chat_run_presentation" });
    expect(upgraded.id).toBe(first.id);
    expect(upgraded.metadata?.voiceReply).toBeUndefined();
  });

  it("does not accept forged metadata or an operation belonging to another conversation", async () => {
    const f = await fixture(), other = await fixture();
    await f.launch();
    await db.update(heartbeatRuns).set({ resultJson: { queuedSteeringAcknowledgements: { [other.first.id]: { status: "acknowledged", queueId: randomUUID(), turnId: "turn" } } } }).where(eq(heartbeatRuns.id, f.scope.runId));
    expect(await f.resolve(f.body(other.first.operationId))).toBeNull();
    await expect(issueService(db).addComment(f.scope.issueId, f.body(f.first.operationId), { agentId: f.scope.agentId, runId: f.scope.runId },
      { metadata: { version: 1, voiceReply: { version: 1, runId: f.scope.runId, sourceCommentIds: [other.first.id] },
        sections: [{ rows: [{ type: "text", text: "Forged" }] }] } })).rejects.toThrow("Voice reply provenance is server-owned");
  });
});
