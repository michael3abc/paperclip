import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues, issueTreeHolds, projects, type Db } from "@paperclipai/db";
import { startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { workerInstructionDelivery, inspectWorkerInstructionDelivery } from "../services/worker-instruction-delivery.js";

const hook = vi.hoisted(() => ({ state: vi.fn(), send: vi.fn(), receipt: vi.fn() }));
vi.mock("../adapters/index.js", async original => ({ ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ chatSteering: hook }) }));

describe("main worker supplementary instruction receipts (owned PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db;
  beforeAll(async () => { database = await startRecoveryPostgres("worker-instructions-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  beforeEach(() => {
    hook.state.mockReset().mockResolvedValue({ disposition: "available", turnId: "turn-original", nativeSessionId: "native-original", bridgeSessionId: "bridge-original" });
    hook.send.mockReset().mockResolvedValue({ status: "acknowledged", turnId: "turn-original" });
  });
  async function fixture() {
    const companyId = randomUUID(), projectId = randomUUID(), actorId = randomUUID(), workerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Owned worker input", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values([
      { id: actorId, companyId, name: "Main", role: "engineer", status: "running", adapterType: "ccpocket_bridge", adapterConfig: { role: "main", projectId } },
      { id: workerId, companyId, name: "Worker", role: "engineer", status: "running", adapterType: "ccpocket_bridge" },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Owned project", leadAgentId: actorId });
    const [issue] = await db.insert(issues).values({ companyId, projectId, title: "Busy worker", status: "in_progress", assigneeAgentId: workerId }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: actorId, status: "running", invocationSource: "on_demand" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: workerId, issueId: issue.id, status: "running", invocationSource: "on_demand",
      contextSnapshot: { issueId: issue.id }, runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge", adapterConfig: { role: "worker", provider: "codex" } } } as never }).returning();
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issue.id));
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: issue.id, authorAgentId: actorId, body: "Inspect the new constraint now" }).returning();
    return { companyId, actorId, workerId, issue, run, source,
      input: { companyId, actorId, issueId: issue.id, actorRunId: source.id, commentId: comment.id, message: comment.body } };
  }
  const receipts = (companyId: string) => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
  it("sends immediately to the exact original turn and never creates runnable work", async () => {
    const f = await fixture();
    expect(await workerInstructionDelivery(db)(f.input)).toBe(true);
    expect(hook.send).toHaveBeenCalledWith(expect.objectContaining({ runId: f.run.id, turnId: "turn-original", nativeSessionId: "native-original", bridgeSessionId: "bridge-original" }));
    expect(await workerInstructionDelivery(db)(f.input)).toBe(true);
    expect(hook.send).toHaveBeenCalledTimes(1);
    expect(await receipts(f.companyId)).toEqual([expect.objectContaining({ status: "skipped", runId: f.run.id, payload: expect.objectContaining({ deliveryStatus: "acknowledged" }) })]);
  });
  it.each(["queue", "idle"])("preserves %s delivery", async mode => {
    const f = await fixture();
    if (mode === "idle") await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await workerInstructionDelivery(db)({ ...f.input, ...(mode === "queue" ? { deliveryMode: "queue" as const } : {}) })).toBe(false);
    expect(hook.send).not.toHaveBeenCalled(); expect(await receipts(f.companyId)).toHaveLength(0);
  });
  it.each([false, true])("preserves a pre-existing queued comment (coalesced=%s)", async coalesced => {
    const f = await fixture();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.workerId, source: "automation", status: "deferred_issue_execution", payload: { issueId: f.issue.id, ...(coalesced ? { _paperclipWakeContext: { wakeCommentIds: [f.input.commentId] } } : { commentId: f.input.commentId }) } });
    expect(await workerInstructionDelivery(db)(f.input)).toBe(false); expect(hook.send).not.toHaveBeenCalled();
    expect(await receipts(f.companyId)).toHaveLength(1);
  });
  it("does not inject input the active run already consumed", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id, wakeCommentIds: [f.input.commentId] } }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await workerInstructionDelivery(db)(f.input)).toBe(false); expect(hook.send).not.toHaveBeenCalled();
  });
  it.each(["steering_rejected", "bridge_timeout"])("does not resend or enqueue after %s, even if the caller changes mode", async code => {
    const f = await fixture(); hook.send.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    await expect(workerInstructionDelivery(db)(f.input)).rejects.toMatchObject({ status: 409 });
    await expect(workerInstructionDelivery(db)({ ...f.input, deliveryMode: "queue" })).rejects.toMatchObject({ status: 409 });
    expect(hook.send).toHaveBeenCalledTimes(1);
    const saved = await receipts(f.companyId); expect(saved).toHaveLength(1); expect(saved[0].status).toBe("skipped");
    expect(saved[0].payload?.deliveryStatus).toBe(code === "steering_rejected" ? "rejected" : "uncertain");
  });
  it("returns an explicit unavailable result without a queue fallback", async () => {
    const f = await fixture(); hook.state.mockResolvedValueOnce({ disposition: "unsupported" });
    await expect(workerInstructionDelivery(db)(f.input)).rejects.toMatchObject({ details: { code: "worker_instruction_rejected" } });
    expect(hook.send).not.toHaveBeenCalled(); expect((await receipts(f.companyId))[0].status).toBe("skipped");
  });
  it("does not steer a foreign project or an ordinary worker's message", async () => {
    const f = await fixture();
    await db.update(projects).set({ leadAgentId: f.workerId }).where(and(eq(projects.id, f.issue.projectId!), eq(projects.companyId, f.companyId)));
    expect(await workerInstructionDelivery(db)(f.input)).toBe(false);
    expect(await workerInstructionDelivery(db)({ ...f.input, actorId: f.workerId })).toBe(false);
    expect(hook.send).not.toHaveBeenCalled();
  });
  it("reconciles a late acknowledgement by reading only the original native receipt", async () => {
    const f = await fixture(); hook.send.mockRejectedValueOnce(Object.assign(new Error("lost ack"), { code: "bridge_timeout" }));
    await expect(workerInstructionDelivery(db)(f.input)).rejects.toMatchObject({ status: 409 });
    const [receipt] = await receipts(f.companyId);
    hook.receipt.mockResolvedValueOnce({ status: "acknowledged", turnId: "wrong-turn" });
    expect((await inspectWorkerInstructionDelivery(db, f.companyId, f.issue.id, receipt.id)).status).toBe("uncertain");
    hook.receipt.mockResolvedValueOnce({ status: "acknowledged", turnId: "turn-original" });
    expect(await inspectWorkerInstructionDelivery(db, f.companyId, f.issue.id, receipt.id)).toMatchObject({ status: "acknowledged", targetRunId: f.run.id });
    expect(await workerInstructionDelivery(db)(f.input)).toBe(true); expect(hook.send).toHaveBeenCalledTimes(1);
    await expect(inspectWorkerInstructionDelivery(db, f.companyId, randomUUID(), receipt.id)).rejects.toMatchObject({ status: 404 });
  });
  it("honors the Owner pause hold without touching the active turn", async () => {
    const f = await fixture();
    await db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: f.issue.id, mode: "pause", createdByActorType: "user" });
    await expect(workerInstructionDelivery(db)(f.input)).rejects.toMatchObject({ details: { code: "worker_instruction_held" } });
    expect(hook.send).not.toHaveBeenCalled(); expect(await receipts(f.companyId)).toHaveLength(0);
  });
  it("uses the saved dispatch after the worker's configuration changes", async () => {
    const f = await fixture();
    await db.update(agents).set({ adapterType: "process", adapterConfig: { model: "different-provider" } }).where(eq(agents.id, f.workerId));
    expect(await workerInstructionDelivery(db)(f.input)).toBe(true);
    expect(hook.send).toHaveBeenCalledWith(expect.objectContaining({ runId: f.run.id, nativeSessionId: "native-original" }));
  });
  it("keeps concurrent attempts on one original receipt", async () => {
    const f = await fixture();
    await Promise.allSettled([workerInstructionDelivery(db)(f.input), workerInstructionDelivery(db)(f.input)]);
    expect(hook.send).toHaveBeenCalledTimes(1); expect(await receipts(f.companyId)).toHaveLength(1);
  });
});
