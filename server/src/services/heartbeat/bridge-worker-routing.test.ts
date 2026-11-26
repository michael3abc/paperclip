import { describe, expect, it } from "vitest";
import { MAIN_MANAGED_WORKTREE_KEY, MAIN_MANAGED_WORKTREE_SCHEMA } from "@paperclipai/shared";
import { prepareBridgeWorkerRoute } from "./bridge-worker-routing.js";

const companyId = "company-1";
const worker = {
  id: "worker-1", companyId, adapterType: "ccpocket_bridge",
  adapterConfig: { provider: "codex", hostId: "michael-server", model: "michael-server/codex/default" },
  runtimeConfig: { bridgeWorkerHostCapacity: { "michael-server": 20, "remote-host-c": 4 } },
} as any;

function fakeDb(sources: unknown[]) {
  const chain = (result: unknown) => ({ from: () => ({ where: async () => result }) });
  return {
    select: () => chain(sources),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  } as any;
}

function managed(hostId: string | null) {
  return { [MAIN_MANAGED_WORKTREE_KEY]: { schema: MAIN_MANAGED_WORKTREE_SCHEMA, kind: "linked_worktree", phase: "open",
    sourceCwd: "/repo", parentDir: "/trees", branch: "michael/x", targetBranch: "michael/main", hostId,
    pendingOperationId: null, participants: {} } };
}

describe("prepareBridgeWorkerRoute", () => {
  const localSource = { id: "source-1", sourceType: "local_path", isPrimary: true, metadata: null };
  const run = { id: "run-1", contextSnapshot: {} } as any;
  const overrides = { adapterConfig: { model: "michael-server/codex/family:gpt-6.1-sol" } };

  it("treats a local linked worktree (hostId null) as the default Bridge host", async () => {
    const context: Record<string, unknown> = {};
    const routed = await prepareBridgeWorkerRoute(fakeDb([localSource]), { agent: worker, run, overrides, context,
      projectId: "project-1", workspace: { metadata: managed(null), projectWorkspaceId: "source-1" } });
    expect(routed.adapterConfig).toMatchObject({ hostId: "michael-server", model: "michael-server/codex/family:gpt-6.1-sol" });
    expect(context.bridgeWorkerRoute).toMatchObject({ hostId: "michael-server" });
  });

  it("still rejects a local worktree for a remote-host route", async () => {
    await expect(prepareBridgeWorkerRoute(fakeDb([localSource]), { agent: worker, run, context: {},
      overrides: { adapterConfig: { model: "remote-host-c/codex/family:gpt-6.1-sol" } },
      projectId: "project-1", workspace: { metadata: managed(null), projectWorkspaceId: "source-1" } }))
      .rejects.toMatchObject({ status: 422 });
  });
});
