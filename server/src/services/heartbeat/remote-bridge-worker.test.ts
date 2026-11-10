import { describe, expect, it } from "vitest";
import { remoteBridgeWorkerHost, selectRemoteWorkerSource } from "./remote-bridge-worker.js";

const worker = (adapterConfig: Record<string, unknown>, runtimeConfig: Record<string, unknown> = {}) =>
  ({ adapterType: "ccpocket_bridge", adapterConfig, runtimeConfig });

describe("remote Bridge workers", () => {
  it("identifies only plain shared Bridge workers on a host other than the controller", () => {
    expect(remoteBridgeWorkerHost(worker({ provider: "codex", hostId: "shopee-e" }))).toBe("shopee-e");
    expect(remoteBridgeWorkerHost(worker({ provider: "claude", hostId: "shopee-d" }))).toBe("shopee-d");
    expect(remoteBridgeWorkerHost(worker({ provider: "claude", hostId: "michael-server" }))).toBeNull();
    expect(remoteBridgeWorkerHost(worker({ provider: "claude" }))).toBeNull();
    // Main agents, fixed bindings and other adapters keep their own workspace paths.
    expect(remoteBridgeWorkerHost(worker({ provider: "codex", hostId: "shopee-e", role: "main" }))).toBeNull();
    expect(remoteBridgeWorkerHost(worker({ provider: "codex", hostId: "shopee-e" }, { workspaceBinding: { mode: "fixed" } }))).toBeNull();
    expect(remoteBridgeWorkerHost({ adapterType: "codex_local", adapterConfig: { hostId: "shopee-e" } })).toBeNull();
  });

  const source = (id: string, overrides: Record<string, unknown> = {}) => ({ id, projectId: "project", isPrimary: false,
    sourceType: "remote_managed", cwd: `/home/yoyo/Projects/${id}`, metadata: { hostId: "shopee-e" }, ...overrides });

  it("selects the preferred, primary or only source registered on the worker's host", () => {
    const rows = [source("a"), source("b", { isPrimary: true })];
    expect(selectRemoteWorkerSource(rows, "a", "shopee-e")).toMatchObject({ ok: true, cwd: "/home/yoyo/Projects/a" });
    expect(selectRemoteWorkerSource(rows, null, "shopee-e")).toMatchObject({ ok: true, row: { id: "b" } });
    expect(selectRemoteWorkerSource([source("only")], null, "shopee-e")).toMatchObject({ ok: true, row: { id: "only" } });
    expect(selectRemoteWorkerSource([source("a"), source("c")], null, "shopee-e")).toMatchObject({ ok: false, reason: "configured_workspace_unavailable" });
    expect(selectRemoteWorkerSource(rows, "missing", "shopee-e")).toMatchObject({ ok: false, reason: "configured_workspace_unavailable" });
  });

  it("rejects sources on another host, local or unhosted sources and non-canonical paths", () => {
    expect(selectRemoteWorkerSource([source("a")], "a", "shopee-d")).toMatchObject({ ok: false, reason: "remote_worker_host_mismatch" });
    expect(selectRemoteWorkerSource([source("a", { sourceType: "local_path" })], "a", "shopee-e")).toMatchObject({ ok: false, reason: "remote_worker_host_mismatch" });
    expect(selectRemoteWorkerSource([source("a", { metadata: null })], "a", "shopee-e")).toMatchObject({ ok: false, reason: "remote_worker_host_mismatch" });
    for (const cwd of [null, "relative/a", "/home/yoyo/../etc", "/home/yoyo/Projects/a/"]) {
      expect(selectRemoteWorkerSource([source("a", { cwd })], "a", "shopee-e")).toMatchObject({ ok: false, reason: "remote_worker_path_invalid" });
    }
  });
});
