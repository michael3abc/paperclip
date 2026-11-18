import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import { buildAgentMentionHref } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import {
  MENTION_SUBTASK_CANCELLED_KEY_PREFIX,
  MENTION_SUBTASK_ORIGIN_KIND,
  MENTION_SUBTASK_RESULT_KEY_PREFIX,
  MENTION_SUBTASK_RESULT_MAX_CHARS,
  mentionSubtaskService,
  mentionSubtaskTitle,
  registerMentionSubtaskResultWork,
} from "../services/mention-subtasks.js";
import { issueService } from "../services/issues.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MENTION_SUBTASKS_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const OWNER_USER_ID = "owner-user";

const mention = (agent: { id: string; name: string }) => `[@${agent.name}](${buildAgentMentionHref(agent.id)})`;

(support.supported ? describe : describe.skip)("mention subtasks", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else database = await startEmbeddedPostgresTestDatabase("mention-subtasks-");
  }, 120_000);
  beforeEach(async () => {
    db = createDb(external ?? database!.connectionString);
    await db.execute(sql`truncate companies cascade`);
  });
  afterEach(async () => { await db?.$client.end({ timeout: 1 }); });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const prefix = `M${randomUUID().replace(/[^a-f0-9]/g, "").slice(0, 5).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name: "Mentions", issuePrefix: prefix }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Career" }).returning();
    const agent = async (name: string, status = "idle") => (await db.insert(agents).values({
      companyId: company.id, name, status, adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning())[0]!;
    const career = await agent("Career");
    const michael = await agent("michael");
    const momo = await agent("momo");
    const paused = await agent("Sleeper", "paused");
    const terminated = await agent("Retired", "terminated");
    const svc = issueService(db);
    const parent = await svc.create(company.id, {
      title: "Prepare 104 resume", status: "todo", projectId: project.id, assigneeAgentId: career.id,
    });
    const wakeup = vi.fn(async () => null);
    const mentions = mentionSubtaskService(db, { wakeup, createRetryDelaysMs: [] });
    const addComment = async (body: string, extra: Partial<typeof issueComments.$inferInsert> = {}) =>
      (await db.insert(issueComments).values({
        companyId: company.id, issueId: parent.id, authorUserId: OWNER_USER_ID, authorType: "user", body, ...extra,
      }).returning())[0]!;
    const children = () => db.select().from(issues).where(and(
      eq(issues.companyId, company.id), eq(issues.originKind, MENTION_SUBTASK_ORIGIN_KIND)));
    const parentComments = () => db.select().from(issueComments)
      .where(eq(issueComments.issueId, parent.id)).orderBy(issueComments.createdAt);
    const agentReply = async (issueId: string, agentId: string, body: string, at: Date) =>
      (await db.insert(issueComments).values({
        companyId: company.id, issueId, authorAgentId: agentId, authorType: "agent", body, createdAt: at, updatedAt: at,
      }).returning())[0]!;
    const setStatus = (issueId: string, status: string) => svc.update(issueId, { status });
    return {
      company, project, career, michael, momo, paused, terminated, parent, svc, wakeup, mentions,
      addComment, children, parentComments, agentReply, setStatus,
    };
  }

  it("creates one linked, assigned todo subtask for a mentioned agent and starts it", async () => {
    const f = await fixture();
    const comment = await f.addComment(`${mention(f.michael)} 幫我看一下履歷標題要怎麼改\n\n細節：第二段。`);

    const result = await f.mentions.createForComment(comment);

    expect(result.created).toHaveLength(1);
    const [child] = await f.children();
    expect(child).toMatchObject({
      parentId: f.parent.id,
      projectId: f.project.id,
      companyId: f.company.id,
      assigneeAgentId: f.michael.id,
      status: "todo",
      originKind: MENTION_SUBTASK_ORIGIN_KIND,
      originId: `${comment.id}:${f.michael.id}`,
      createdByUserId: OWNER_USER_ID,
      responsibleUserId: OWNER_USER_ID,
    });
    expect(child!.title).toBe(`來自 ${f.parent.identifier} 的提問：幫我看一下履歷標題要怎麼改`);
    expect(child!.description).toContain(comment.body);
    expect(child!.description).toContain(`#comment-${comment.id}`);
    expect(child!.description).toContain("最後一則留言");
    expect(child!.description).toContain("done");
    expect(f.wakeup).toHaveBeenCalledTimes(1);
    expect(f.wakeup).toHaveBeenCalledWith(f.michael.id, expect.objectContaining({
      reason: "issue_assigned",
      payload: expect.objectContaining({ issueId: child!.id }),
      requestedByActorType: "user",
      requestedByActorId: OWNER_USER_ID,
    }));
  });

  it("never creates a second subtask for the same comment and agent across retries and edits", async () => {
    const f = await fixture();
    const comment = await f.addComment(`${mention(f.michael)} 請確認`);

    const concurrent = await Promise.all([f.mentions.createForComment(comment), f.mentions.createForComment(comment)]);
    const again = await f.mentions.createForComment(comment);

    expect(concurrent.flatMap((result) => result.created)).toHaveLength(1);
    expect(again.created).toHaveLength(0);
    expect(again.existing).toHaveLength(1);
    expect(await f.children()).toHaveLength(1);
    expect(f.wakeup).toHaveBeenCalledTimes(1);

    // An edit that adds momo creates momo's subtask only.
    await db.update(issueComments).set({ body: `${mention(f.michael)} ${mention(f.momo)} 請確認` })
      .where(eq(issueComments.id, comment.id));
    const edited = await f.mentions.createForCommentId(comment.id);

    expect(edited.created.map((child) => child.assigneeAgentId)).toEqual([f.momo.id]);
    expect(edited.existing.map((child) => child.assigneeAgentId)).toEqual([f.michael.id]);
    expect((await f.children()).map((child) => child.assigneeAgentId).sort())
      .toEqual([f.michael.id, f.momo.id].sort());
  });

  it("ignores agent-authored and run-authored comments", async () => {
    const f = await fixture();
    const byAgent = await f.addComment(`${mention(f.michael)} from an agent`, {
      authorUserId: null, authorAgentId: f.career.id, authorType: "agent",
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: f.company.id, agentId: f.career.id, status: "running", issueId: f.parent.id,
    }).returning();
    const byRun = await f.addComment(`${mention(f.michael)} from a run under board auth`, { createdByRunId: run!.id });

    expect((await f.mentions.createForComment(byAgent)).created).toHaveLength(0);
    expect((await f.mentions.createForComment(byRun)).created).toHaveLength(0);
    expect(await f.children()).toHaveLength(0);
    expect(f.wakeup).not.toHaveBeenCalled();
  });

  it("skips the assignee and paused, terminated or unknown agents without failing", async () => {
    const f = await fixture();
    const unknownId = randomUUID();
    const comment = await f.addComment([
      mention(f.career), mention(f.paused), mention(f.terminated),
      `[@ghost](${buildAgentMentionHref(unknownId)})`, "請看一下",
    ].join(" "));

    const result = await f.mentions.createForComment(comment);

    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { agentId: f.career.id, reason: "issue_assignee" },
      { agentId: f.paused.id, reason: "agent_paused" },
      { agentId: f.terminated.id, reason: "agent_terminated" },
      { agentId: unknownId, reason: "unknown_agent" },
    ]));
    expect(await f.children()).toHaveLength(0);
    expect(f.wakeup).not.toHaveBeenCalled();
  });

  it("posts the subtask assignee's last comment back once and wakes the original assignee", async () => {
    const f = await fixture();
    const comment = await f.addComment(`${mention(f.michael)} 標題要改成什麼？`);
    const [child] = (await f.mentions.createForComment(comment)).created;
    f.wakeup.mockClear();
    await f.agentReply(child!.id, f.michael.id, "先查一下", new Date(Date.now() - 2_000));
    await f.agentReply(child!.id, f.michael.id, "建議改成「資深後端工程師」", new Date(Date.now() - 1_000));
    // A later automatic acknowledgement is not the answer.
    await db.insert(issueComments).values({
      companyId: f.company.id, issueId: child!.id, authorAgentId: f.michael.id, authorType: "agent",
      body: "收到，處理中", origin: "fast_response",
    });

    // The status change itself signals the delivery queue through issueService.update.
    await f.setStatus(child!.id, "done");
    expect(await f.mentions.hasPendingResults()).toBe(true);
    const first = await f.mentions.sweepPendingResults();

    expect(first).toEqual([{ issueId: child!.id, outcome: "posted_result" }]);
    const posted = (await f.parentComments()).filter((row) => row.id !== comment.id);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      authorAgentId: f.michael.id,
      authorType: "agent",
      clientRequestId: `${MENTION_SUBTASK_RESULT_KEY_PREFIX}${child!.id}`,
    });
    expect(posted[0]!.body).toContain("**michael**");
    expect(posted[0]!.body).toContain(`[${child!.identifier}](`);
    expect(posted[0]!.body).toContain("建議改成「資深後端工程師」");
    expect(posted[0]!.body).not.toContain("先查一下");
    expect(posted[0]!.body).not.toContain("收到，處理中");
    expect(f.wakeup).toHaveBeenCalledTimes(1);
    expect(f.wakeup).toHaveBeenCalledWith(f.career.id, expect.objectContaining({
      reason: "issue_commented",
      requestedByActorType: "agent",
      requestedByActorId: f.michael.id,
      contextSnapshot: expect.objectContaining({ issueId: f.parent.id, wakeCommentId: posted[0]!.id }),
    }));

    // Retries, direct settles and reopen/close never post it again.
    expect(await f.mentions.hasPendingResults()).toBe(false);
    expect(await f.mentions.sweepPendingResults()).toEqual([]);
    expect(await f.mentions.settleSubtask(child!.id)).toBe("already_posted");
    await f.setStatus(child!.id, "todo");
    await f.agentReply(child!.id, f.michael.id, "補充：也可以加年資", new Date());
    await f.setStatus(child!.id, "done");
    await f.mentions.sweepPendingResults();
    expect((await f.parentComments()).filter((row) => row.id !== comment.id)).toHaveLength(1);
    expect(f.wakeup).toHaveBeenCalledTimes(1);
  });

  it("runs the result-back from the delivery queue when the status change commits", async () => {
    const f = await fixture();
    const comment = await f.addComment(`${mention(f.michael)} 幫忙確認`);
    const [child] = (await f.mentions.createForComment(comment)).created;
    await f.agentReply(child!.id, f.michael.id, "確認完成", new Date());
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: (err) => errors.push(err) });
    const sweep = vi.spyOn(f.mentions, "sweepPendingResults");
    try {
      const worker = registerMentionSubtaskResultWork(coordinator, f.mentions, 60_000);
      await worker.ready;
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(coordinator.nextWakeAt()).toBeNull();

      await f.setStatus(child!.id, "done");

      await vi.waitFor(async () => {
        const posted = (await f.parentComments()).filter((row) => row.id !== comment.id);
        expect(posted.map((row) => row.body)).toEqual([expect.stringContaining("確認完成")]);
      }, { timeout: 10_000, interval: 50 });
      expect(sweep).toHaveBeenCalledTimes(2);
    } finally {
      await coordinator.stop();
    }
    expect(errors).toEqual([]);
  });

  it("bounds a long answer and links to the full comment", async () => {
    const f = await fixture();
    const comment = await f.addComment(`${mention(f.michael)} 寫一份長報告`);
    const [child] = (await f.mentions.createForComment(comment)).created;
    const answer = await f.agentReply(child!.id, f.michael.id, `${"長".repeat(MENTION_SUBTASK_RESULT_MAX_CHARS + 50)}`, new Date());
    await f.setStatus(child!.id, "done");

    expect(await f.mentions.settleSubtask(child!.id)).toBe("posted_result");
    const [posted] = (await f.parentComments()).filter((row) => row.id !== comment.id);
    expect(posted!.body).not.toContain("長".repeat(MENTION_SUBTASK_RESULT_MAX_CHARS + 1));
    expect(posted!.body).toContain(`#comment-${answer.id}`);
  });

  it("waits for the subtask's running run to finish writing its reply", async () => {
    const f = await fixture();
    const comment = await f.addComment(`${mention(f.michael)} 幫忙確認`);
    const [child] = (await f.mentions.createForComment(comment)).created;
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: f.company.id, agentId: f.michael.id, status: "running", issueId: child!.id,
      contextSnapshot: { issueId: child!.id },
    }).returning();
    await f.setStatus(child!.id, "done");

    expect(await f.mentions.settleSubtask(child!.id)).toBe("waiting_for_run");
    expect(await f.mentions.hasPendingResults()).toBe(true);
    await f.agentReply(child!.id, f.michael.id, "最後的答覆", new Date());
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run!.id));

    expect(await f.mentions.sweepPendingResults()).toEqual([{ issueId: child!.id, outcome: "posted_result" }]);
    const [posted] = (await f.parentComments()).filter((row) => row.id !== comment.id);
    expect(posted!.body).toContain("最後的答覆");
  });

  it("posts a short system note for a cancelled subtask, once, and still posts a later answer", async () => {
    const f = await fixture();
    const comment = await f.addComment(`${mention(f.michael)} 幫忙確認`);
    const [child] = (await f.mentions.createForComment(comment)).created;
    f.wakeup.mockClear();

    await f.setStatus(child!.id, "cancelled");
    expect(await f.mentions.sweepPendingResults()).toEqual([{ issueId: child!.id, outcome: "posted_cancelled_note" }]);
    expect(await f.mentions.sweepPendingResults()).toEqual([]);
    const notes = (await f.parentComments()).filter((row) => row.id !== comment.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      authorAgentId: null,
      authorType: "system",
      clientRequestId: `${MENTION_SUBTASK_CANCELLED_KEY_PREFIX}${child!.id}`,
    });
    expect(notes[0]!.body).toContain("已取消");
    expect(notes[0]!.body).toContain(`[${child!.identifier}](`);
    expect(f.wakeup).not.toHaveBeenCalled();

    // Reopened and answered after all: the answer still reaches the parent once.
    await f.setStatus(child!.id, "todo");
    await f.agentReply(child!.id, f.michael.id, "後來還是回覆了", new Date());
    await f.setStatus(child!.id, "done");
    await f.mentions.sweepPendingResults();
    await f.setStatus(child!.id, "cancelled");
    await f.mentions.sweepPendingResults();
    const all = (await f.parentComments()).filter((row) => row.id !== comment.id);
    expect(all.map((row) => row.clientRequestId)).toEqual([
      `${MENTION_SUBTASK_CANCELLED_KEY_PREFIX}${child!.id}`,
      `${MENTION_SUBTASK_RESULT_KEY_PREFIX}${child!.id}`,
    ]);
  });

  it("derives a short title from the first meaningful line", () => {
    const parent = { identifier: "HOM-332", id: randomUUID() };
    const agent = { id: randomUUID(), name: "michael" };
    expect(mentionSubtaskTitle(parent, `${mention(agent)}\n\n## 請幫我看 **HOM-331** 的結果`))
      .toBe("來自 HOM-332 的提問：請幫我看 HOM-331 的結果");
    expect(mentionSubtaskTitle(parent, mention(agent))).toBe("來自 HOM-332 的提問");
    expect(mentionSubtaskTitle(parent, "長".repeat(80))).toBe(`來自 HOM-332 的提問：${"長".repeat(60)}…`);
  });
});
