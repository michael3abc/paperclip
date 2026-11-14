import { randomUUID } from "node:crypto";
import { agents, authUsers, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { dotMainChatService } from "./dot-main-chat.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_DOT_MAIN_CHAT_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("Dot talks to main agents through Agent Chat", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("dot-main-chat-");
    db = createDb(external ?? database!.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), mainId = randomUUID(), dotId = randomUUID(), workerId = randomUUID(), owner = `owner-${companyId.slice(0, 8)}`;
    await db.insert(authUsers).values({ id: owner, name: "Owner", email: `${owner}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Dot chat fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values([{ id: mainId, companyId, name: "All-Set", adapterType: "ccpocket_bridge" },
      { id: dotId, companyId, name: "momo", adapterType: "paperclip_runner" },
      { id: workerId, companyId, name: "Shared Codex worker", adapterType: "codex_local" }]);
    const [chat] = await db.insert(issues).values({ companyId, title: "Chat with All-Set", status: "in_review",
      assigneeAgentId: mainId, conversationAgentId: mainId, conversationUserId: owner, conversationState: "active" }).returning();
    await db.insert(issueComments).values([
      { companyId, issueId: chat!.id, authorType: "user", authorUserId: owner, body: "幫我對帳", createdAt: new Date(Date.now() - 60_000) },
      { companyId, issueId: chat!.id, authorType: "agent", authorAgentId: mainId, body: "好，我開了子任務", createdAt: new Date(Date.now() - 30_000) }]);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: mainId, status: "succeeded", issueId: chat!.id,
      contextSnapshot: { issueId: chat!.id } }).returning();
    const [sub] = await db.insert(issues).values({ companyId, title: "三家信用卡對帳", status: "in_progress",
      assigneeAgentId: workerId, createdByAgentId: mainId, originRunId: run!.id }).returning();
    const wake = vi.fn(async () => ({}));
    const service = dotMainChatService(db, async () => wake);
    const binding = { id: randomUUID(), companyId, agentId: dotId, operatorId: owner };
    return { companyId, mainId, dotId, owner, chat: chat!, sub: sub!, wake, service, binding };
  }

  it("lists the person's Chats and reads messages with the tasks a Chat spawned", async () => {
    const f = await fixture();
    const list = await f.service.listChats(f.binding);
    expect(list.chats).toEqual([expect.objectContaining({ chatId: f.chat.id, agentName: "All-Set",
      lastMessage: expect.objectContaining({ author: "All-Set" }) })]);
    const read = await f.service.readChat(f.binding, f.chat.id);
    expect(read.messages.map(m => [m.author, m.body])).toEqual([["owner", "幫我對帳"], ["All-Set", "好，我開了子任務"]]);
    expect(read.tasks).toEqual([expect.objectContaining({ id: f.sub.id, title: "三家信用卡對帳", assignee: "Shared Codex worker" })]);
  });

  it("sends once per request as Dot on behalf of the person and wakes the main in its Chat", async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const sent = await f.service.sendChat(f.binding, f.chat.id, "允許送出對帳需求", requestId);
    const again = await f.service.sendChat(f.binding, f.chat.id, "允許送出對帳需求", requestId);
    expect(again.commentId).toBe(sent.commentId);
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, sent.commentId));
    expect(comment).toMatchObject({ authorType: "agent", authorAgentId: f.dotId, onBehalfOfUserId: f.owner, issueId: f.chat.id });
    expect(f.wake).toHaveBeenCalledWith(f.mainId, expect.objectContaining({ reason: "issue_commented",
      contextSnapshot: expect.objectContaining({ issueId: f.chat.id, wakeCommentIds: [sent.commentId] }) }));
    await expect(f.service.sendChat(f.binding, f.chat.id, "different", requestId)).rejects.toThrow(/reused/);
  });

  it("never exposes another person's Chat", async () => {
    const f = await fixture();
    await expect(f.service.readChat({ ...f.binding, operatorId: "someone-else" }, f.chat.id)).rejects.toThrow(/not found/);
    expect((await f.service.listChats({ ...f.binding, operatorId: "someone-else" })).chats).toEqual([]);
  });
});
