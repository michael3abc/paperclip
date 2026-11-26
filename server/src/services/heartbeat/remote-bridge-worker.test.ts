import { describe, expect, it } from "vitest";
import { remoteBridgeWorkerHost, selectRemoteWorkerSource } from "./remote-bridge-worker.js";

const worker = (adapterConfig: Record<string, unknown>, runtimeConfig: Record<string, unknown> = {}) =>
  ({ adapterType: "ccpocket_bridge", adapterConfig, runtimeConfig });

describe("remote Bridge workers", () => {
  it("identifies only plain shared Bridge workers on a host other than the controller", () => {
    expect(remoteBridgeWorkerHost(worker({ provider: "codex", hostId: "remote-host-a" }))).toBe("remote-host-a");
    expect(remoteBridgeWorkerHost(worker({ provider: "claude", hostId: "remote-host-b" }))).toBe("remote-host-b");
    expect(remoteBridgeWorkerHost(worker({ provider: "claude", hostId: "michael-server" }))).toBeNull();
    expect(remoteBridgeWorkerHost(worker({ provider: "claude" }))).toBeNull();
    // Main agents, fixed bindings and other adapters keep their own workspace paths.
    expect(remoteBridgeWorkerHost(worker({ provider: "codex", hostId: "remote-host-a", role: "main" }))).toBeNull();
    expect(remoteBridgeWorkerHost(worker({ provider: "codex", hostId: "remote-host-a" }, { workspaceBinding: { mode: "fixed" } }))).toBeNull();
    expect(remoteBridgeWorkerHost({ adapterType: "codex_local", adapterConfig: { hostId: "remote-host-a" } })).toBeNull();
  });

  const source = (id: string, overrides: Record<string, unknown> = {}) => ({ id, projectId: "project", isPrimary: false,
    sourceType: "remote_managed", cwd: `/home/worker/Projects/${id}`, metadata: { hostId: "remote-host-a" }, ...overrides });

  it("selects the preferred, primary or only source registered on the worker's host", () => {
    const rows = [source("a"), source("b", { isPrimary: true })];
    expect(selectRemoteWorkerSource(rows, "a", "remote-host-a")).toMatchObject({ ok: true, cwd: "/home/worker/Projects/a" });
    expect(selectRemoteWorkerSource(rows, null, "remote-host-a")).toMatchObject({ ok: true, row: { id: "b" } });
    expect(selectRemoteWorkerSource([source("only")], null, "remote-host-a")).toMatchObject({ ok: true, row: { id: "only" } });
    expect(selectRemoteWorkerSource([source("a"), source("c")], null, "remote-host-a")).toMatchObject({ ok: false, reason: "configured_workspace_unavailable" });
    expect(selectRemoteWorkerSource(rows, "missing", "remote-host-a")).toMatchObject({ ok: false, reason: "configured_workspace_unavailable" });
  });

  it("rejects sources on another host, local or unhosted sources and non-canonical paths", () => {
    expect(selectRemoteWorkerSource([source("a")], "a", "remote-host-b")).toMatchObject({ ok: false, reason: "remote_worker_host_mismatch" });
    expect(selectRemoteWorkerSource([source("a", { sourceType: "local_path" })], "a", "remote-host-a")).toMatchObject({ ok: false, reason: "remote_worker_host_mismatch" });
    expect(selectRemoteWorkerSource([source("a", { metadata: null })], "a", "remote-host-a")).toMatchObject({ ok: false, reason: "remote_worker_host_mismatch" });
    for (const cwd of [null, "relative/a", "/home/worker/../etc", "/home/worker/Projects/a/"]) {
      expect(selectRemoteWorkerSource([source("a", { cwd })], "a", "remote-host-a")).toMatchObject({ ok: false, reason: "remote_worker_path_invalid" });
    }
  });
});
