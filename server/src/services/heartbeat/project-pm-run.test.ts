import type { Db } from "@paperclipai/db";
import type { PaperclipPmWorkspaceContext } from "@paperclipai/shared";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { ProjectPmRunWorkspace } from "../agent-workspace-binding.js";

// Each test installs a fresh resolver spy; the module export only delegates to it.
const resolver = vi.hoisted(() => ({ current: undefined as undefined | Mock<(...args: unknown[]) => Promise<unknown>> }));
vi.mock("../agent-workspace-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-workspace-binding.js")>()),
  resolveProjectPmRunWorkspace: (...args: unknown[]) => resolver.current!(...args),
}));

const { admitProjectPmRun } = await import("./project-pm-run.js");

const issueId = "11111111-1111-4111-8111-111111111111";
const otherIssueId = "22222222-2222-4222-8222-222222222222";
const run = { id: "run-1", wakeupRequestId: "wake-1" };
const agent = { id: "agent-1", companyId: "company-1", runtimeConfig: { workspaceBinding: { mode: "project_pm" } } };
const workspace = (role: "pm" | "worker", forIssue: string | null = issueId): PaperclipPmWorkspaceContext => ({
  version: 1, role, agentHome: "/agents/pm", projectId: "project-1", workerRoot: "/work/project",
  workerIsolation: "shared", workerSlots: 2, cwd: role === "worker" ? "/work/project" : "/agents/pm",
  issueId: forIssue, inboxIssueId: null,
});

function harness(resolved: ProjectPmRunWorkspace, rejectedRun: Record<string, unknown> | null = { id: run.id, companyId: agent.companyId }) {
  resolver.current = vi.fn(async () => resolved);
  const calls: Array<[string, ...unknown[]]> = [];
  const persisted: Array<Record<string, unknown>> = [];
  const db = {
    update: vi.fn(() => ({
      set: (patch: { contextSnapshot: Record<string, unknown> }) => ({
        where: async () => { persisted.push(structuredClone(patch.contextSnapshot)); },
      }),
    })),
  } as unknown as Db;
  const record = (name: string, result?: unknown) => vi.fn(async (...args: unknown[]) => { calls.push([name, ...args]); return result; });
  const settlement = {
    setRunStatus: record("setRunStatus"),
    setWakeupStatus: record("setWakeupStatus"),
    getRun: record("getRun", rejectedRun),
    appendRunEvent: record("appendRunEvent"),
    releaseIssueExecutionAndPromote: record("releaseIssueExecutionAndPromote"),
  };
  return { db, calls, persisted, settlement: settlement as unknown as Parameters<typeof admitProjectPmRun>[2] };
}

describe("admitProjectPmRun", () => {
  it("settles an out-of-bounds run in the order persist status, append event, release and reports it cancelled", async () => {
    const message = `Issue ${issueId} is outside the PM agent's project.`;
    const { db, calls, persisted, settlement } = harness({ outcome: "out_of_bounds", issueId, message });
    const context: Record<string, unknown> = { issueId, paperclipPmWorkspace: workspace("worker") };

    await expect(admitProjectPmRun(db, { run, agent, context, claimedByQueue: true }, settlement))
      .resolves.toEqual({ outcome: "cancelled" });
    expect(calls).toEqual([
      ["setRunStatus", run.id, "cancelled", { finishedAt: expect.any(Date), error: message, errorCode: "project_pm_out_of_bounds" }],
      ["setWakeupStatus", run.wakeupRequestId, "cancelled", { finishedAt: expect.any(Date), error: message }],
      ["getRun", run.id],
      ["appendRunEvent", { id: run.id, companyId: agent.companyId }, {
        eventType: "lifecycle", stream: "system", level: "warn", message,
        payload: { errorCode: "project_pm_out_of_bounds", issueId },
      }],
      ["releaseIssueExecutionAndPromote", { id: run.id, companyId: agent.companyId }, { suppressImmediateRecovery: true }],
    ]);
    expect(context).not.toHaveProperty("paperclipPmWorkspace");
    expect(persisted).toEqual([]);
  });

  it("still cancels when the settled run row is gone, without an event or a release", async () => {
    const { db, calls, settlement } = harness({ outcome: "out_of_bounds", issueId: null, message: "gone" }, null);
    await expect(admitProjectPmRun(db, { run, agent, context: {}, claimedByQueue: false }, settlement))
      .resolves.toEqual({ outcome: "cancelled" });
    expect(calls.map(([name]) => name)).toEqual(["setRunStatus", "setWakeupStatus", "getRun"]);
  });

  it("stores and persists the rebuilt PM workspace on the run context", async () => {
    const rebuilt = workspace("pm");
    const { db, calls, persisted, settlement } = harness({ outcome: "workspace", workspace: rebuilt });
    const context: Record<string, unknown> = { issueId, paperclipPmWorkspace: { ...workspace("worker"), cwd: "/forged" } };

    await expect(admitProjectPmRun(db, { run, agent, context, claimedByQueue: false }, settlement))
      .resolves.toEqual({ outcome: "admitted", workspace: rebuilt });
    expect(context.paperclipPmWorkspace).toEqual(rebuilt);
    expect(persisted).toEqual([{ issueId, paperclipPmWorkspace: rebuilt }]);
    expect(calls).toEqual([]);
  });

  it("drops a supplied PM workspace for a non-PM agent without writing the run", async () => {
    const { db, calls, persisted, settlement } = harness({ outcome: "none" });
    const context: Record<string, unknown> = { issueId, paperclipPmWorkspace: workspace("pm") };
    await expect(admitProjectPmRun(db, { run, agent, context, claimedByQueue: true }, settlement))
      .resolves.toEqual({ outcome: "admitted", workspace: null });
    expect(context).toEqual({ issueId });
    expect(persisted).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    { name: "claimed for the same issue", claimedByQueue: true, stored: workspace("worker", issueId), role: "worker" },
    { name: "claimed for another issue", claimedByQueue: true, stored: workspace("worker", otherIssueId), role: null },
    { name: "supplied by a wake payload", claimedByQueue: false, stored: workspace("worker", issueId), role: null },
    { name: "malformed", claimedByQueue: true, stored: { ...workspace("worker", issueId), version: 2 }, role: null },
  ])("keeps the claim-time role only when $name gives it", async ({ claimedByQueue, stored, role }) => {
    const { db, settlement } = harness({ outcome: "none" });
    await admitProjectPmRun(db, { run, agent, context: { issueId, paperclipPmWorkspace: stored }, claimedByQueue }, settlement);
    expect(resolver.current).toHaveBeenCalledWith(db, {
      agent, context: { issueId }, claimedRole: role,
    });
  });

  it("propagates a binding configuration error without settling the run", async () => {
    const { db, calls, settlement } = harness({ outcome: "none" });
    const failure = Object.assign(new Error("invalid binding"), { code: "workspace_validation_failed" });
    resolver.current = vi.fn(async () => { throw failure; });
    await expect(admitProjectPmRun(db, { run, agent, context: { issueId }, claimedByQueue: false }, settlement))
      .rejects.toBe(failure);
    expect(calls).toEqual([]);
  });
});
