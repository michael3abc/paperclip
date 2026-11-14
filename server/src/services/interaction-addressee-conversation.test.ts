import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { deliverInteractionToAddresseeConversation, findAddresseeConversation } from "./interaction-addressee-conversation.js";
import { getConversationOwnershipBlocker } from "./conversation-continuation.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ADDRESSEE_CONVERSATION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("worker cards addressed to the project main", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("addressee-conversation-");
    db = createDb(external ?? database!.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), mainId = randomUUID(), workerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Addressee fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values([{ id: mainId, companyId, name: "Main", adapterType: "ccpocket_bridge" },
      { id: workerId, companyId, name: "Shared Codex worker", adapterType: "codex_local" }]);
    const [chat] = await db.insert(issues).values({ companyId, title: "Chat with Main", status: "in_review",
      assigneeAgentId: mainId, conversationAgentId: mainId, conversationUserId: "owner", conversationState: "active" }).returning();
    const [origin] = await db.insert(heartbeatRuns).values({ companyId, agentId: mainId, status: "succeeded",
      contextSnapshot: { issueId: chat!.id } }).returning();
    const [task] = await db.insert(issues).values({ companyId, title: "Worker task", status: "in_progress",
      assigneeAgentId: workerId, createdByAgentId: mainId, originRunId: origin!.id }).returning();
    return { companyId, mainId, workerId, chat: chat!, task: task! };
  }

  it("delivers the card to the main's original Chat and wakes it there", async () => {
    const f = await fixture();
    const wakeup = vi.fn(async () => ({}));
    const delivered = await deliverInteractionToAddresseeConversation(db, wakeup, {
      issue: f.task, requestedByActorType: "agent", requestedByActorId: f.workerId,
      interaction: { id: randomUUID(), kind: "ask_user_questions", addresseeAgentId: f.mainId, createdByAgentId: f.workerId,
        payload: { questions: [{ id: "q", prompt: "Which transport should the push use?" }] } },
    });
    expect(delivered?.conversationIssueId).toBe(f.chat.id);
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, delivered!.commentId));
    expect(comment).toMatchObject({ issueId: f.chat.id, authorType: "system" });
    expect(comment!.body).toContain("Shared Codex worker");
    expect(comment!.body).toContain("Which transport should the push use?");
    expect(wakeup).toHaveBeenCalledWith(f.mainId, expect.objectContaining({ reason: "interaction_pending",
      contextSnapshot: expect.objectContaining({ issueId: f.chat.id, wakeCommentIds: [delivered!.commentId], interactionIssueId: f.task.id }) }));
  });

  it("keeps the direct wake when the addressee owns the task or has no active Chat", async () => {
    const f = await fixture();
    expect(await findAddresseeConversation(db, { ...f.task, assigneeAgentId: f.mainId }, f.mainId)).toBeNull();
    const [other] = await db.insert(agents).values({ companyId: f.companyId, name: "Reviewer", adapterType: "codex_local" }).returning();
    expect(await findAddresseeConversation(db, f.task, other!.id)).toBeNull();
  });

  it("a local lease still being released never holds the next run; a remote one does", async () => {
    const f = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.workerId, status: "cancelled",
      runtimeMode: "legacy", nativeIssueId: f.task.id, contextSnapshot: { issueId: f.task.id, source: "chat:fixture" },
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      finishedAt: new Date() }).returning();
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: run!.id, issueId: f.task.id,
      provider: "local", status: "active" });
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.task.id)).toBeNull();
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: run!.id, issueId: f.task.id,
      provider: "daytona", providerLeaseId: "fixture-remote", status: "active" });
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.task.id)).toMatchObject({ runId: run!.id, cause: "execution_owner_active" });
  });
});
