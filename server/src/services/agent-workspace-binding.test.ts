import { mkdtemp, rm, symlink, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentRuntimeConfigSchema } from "@paperclipai/shared";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { appliedFixedWorkspaceStrategies, bridgeFixedBindingConflict, assertFixedProjectWorkspace, assertFixedWorkspacePolicy, assertRemoteFixedBinding, controllerLocalCwd, fixedBindingOnlyRevision, fixedWorkspaceMatchesRun, readWorkspaceBinding, validateFixedLocalDirectory } from "./agent-workspace-binding.js";

describe("fixed workspace binding", () => {
  const binding = { mode: "fixed" as const, cwd: "/projects/example" };
  it("validates typed API data while retaining other runtime settings", () => {
    expect(agentRuntimeConfigSchema.parse({ workspaceBinding: binding, heartbeat: { enabled: false } }).workspaceBinding).toEqual(binding);
    for (const value of [{ mode: "copy", cwd: "/project" }, { mode: "fixed", cwd: "relative" }, { mode: "fixed", cwd: "" }, { ...binding, cwd: "/project\0x" }, { ...binding, clone: true }, null]) {
      expect(() => agentRuntimeConfigSchema.parse({ workspaceBinding: value })).toThrow();
    }
    expect(readWorkspaceBinding({})).toBeNull();
    expect(readWorkspaceBinding({ workspaceBinding: { ...binding, cwd: " /projects/example " } })).toEqual(binding);
  });
  it("checks project conflicts without silently choosing another workspace", () => {
    expect(() => assertFixedProjectWorkspace(binding, { cwd: "/projects/example/" }, true)).not.toThrow();
    expect(() => assertFixedProjectWorkspace(binding, null, false)).not.toThrow();
    for (const row of [null, { cwd: null }, { cwd: "/other" }]) expect(() => assertFixedProjectWorkspace(binding, row, true)).toThrow(/differs/);
  });
  it("rejects low trust, external chat, isolation, provisioning and unsupported environments", () => {
    const input = { binding, environment: { driver: "local", config: {} }, trustPreset: "standard", mode: "shared_workspace", external: false, isDot: false, strategies: [] };
    expect(() => assertFixedWorkspacePolicy(input)).not.toThrow();
    for (const patch of [{ trustPreset: "low_trust_review" }, { external: true }, { mode: "isolated_workspace" }, { mode: "operator_branch" }, { isDot: true }, { environment: null }, { environment: { driver: "sandbox", config: {} } }, { environment: { driver: "ssh", config: {} } }, { strategies: [{ type: "git_worktree" }] }, { strategies: [{ provisionCommand: "mkdir project" }] }]) {
      expect(() => assertFixedWorkspacePolicy({ ...input, ...patch })).toThrow();
    }
    expect(() => assertFixedWorkspacePolicy({ ...input, environment: { driver: "ssh", config: { workspaceMode: "in_place", remoteWorkspacePath: binding.cwd } } })).not.toThrow();
  });
  it("rejects only the strategies that would actually shape a fixed run", () => {
    const input = { binding, environment: { driver: "local", config: {} }, trustPreset: "standard", mode: "shared_workspace", external: false, isDot: false };
    const workerDefault = { type: "git_worktree", branchTemplate: "paperclip/{{issue.id}}" };
    // A project's worker worktree default is unused by a shared fixed run.
    const shared = appliedFixedWorkspaceStrategies({ mode: "shared_workspace", mergedConfig: {}, configSnapshot: {},
      projectPolicy: { workspaceStrategy: workerDefault }, issueStrategy: { type: "project_primary" }, environmentStrategy: undefined });
    expect(shared).not.toContain(workerDefault);
    expect(() => assertFixedWorkspacePolicy({ ...input, strategies: shared })).not.toThrow();
    // Applied strategies still reject: merged, explicit task, environment or a storage provider's project strategy.
    for (const strategies of [
      appliedFixedWorkspaceStrategies({ mode: "shared_workspace", mergedConfig: { workspaceStrategy: workerDefault }, configSnapshot: {}, projectPolicy: null, issueStrategy: undefined, environmentStrategy: undefined }),
      appliedFixedWorkspaceStrategies({ mode: "shared_workspace", mergedConfig: {}, configSnapshot: {}, projectPolicy: null, issueStrategy: workerDefault, environmentStrategy: undefined }),
      appliedFixedWorkspaceStrategies({ mode: "shared_workspace", mergedConfig: {}, configSnapshot: {}, projectPolicy: null, issueStrategy: undefined, environmentStrategy: workerDefault }),
      appliedFixedWorkspaceStrategies({ mode: "shared_workspace", mergedConfig: {}, configSnapshot: {}, projectPolicy: { workspaceStrategy: workerDefault, storageProviderPluginId: "p" }, issueStrategy: undefined, environmentStrategy: undefined }),
      appliedFixedWorkspaceStrategies({ mode: "shared_workspace", mergedConfig: { provisionCommand: "make" }, configSnapshot: {}, projectPolicy: null, issueStrategy: undefined, environmentStrategy: undefined }),
    ]) expect(() => assertFixedWorkspacePolicy({ ...input, strategies })).toThrow(/provisioning/);
    expect(appliedFixedWorkspaceStrategies({ mode: "isolated_workspace", mergedConfig: {}, configSnapshot: {},
      projectPolicy: { workspaceStrategy: workerDefault }, issueStrategy: undefined, environmentStrategy: undefined })).toContain(workerDefault);
  });
  it("requires a CC Pocket session cwd to have the same server-side fixed binding", () => {
    const agent = { adapterType: "ccpocket_bridge", adapterConfig: { cwd: "/projects/example" } };
    expect(bridgeFixedBindingConflict({ ...agent, runtimeConfig: { workspaceBinding: binding } })).toBeNull();
    expect(bridgeFixedBindingConflict({ ...agent, runtimeConfig: { workspaceBinding: { ...binding, cwd: "/projects/example/" } } })).toBeNull();
    expect(bridgeFixedBindingConflict({ ...agent, runtimeConfig: { workspaceBinding: { ...binding, hostId: "shopee-e" } } })).toBeNull();
    expect(bridgeFixedBindingConflict({ ...agent, runtimeConfig: {} })).toMatchObject({ reason: "missing", cwd: "/projects/example" });
    expect(bridgeFixedBindingConflict({ ...agent, runtimeConfig: null })).toMatchObject({ reason: "missing" });
    expect(bridgeFixedBindingConflict({ ...agent, runtimeConfig: { workspaceBinding: { ...binding, cwd: "/projects/other" } } }))
      .toMatchObject({ reason: "cwd_mismatch" });
    // Project PMs keep their own role rules; workers without a session cwd and other adapters are not fixed sessions.
    expect(bridgeFixedBindingConflict({ ...agent, runtimeConfig: { workspaceBinding: { mode: "project_pm" } } })).toBeNull();
    expect(bridgeFixedBindingConflict({ adapterType: "ccpocket_bridge", adapterConfig: {}, runtimeConfig: {} })).toBeNull();
    expect(bridgeFixedBindingConflict({ adapterType: "ccpocket_bridge", adapterConfig: { cwd: "  " }, runtimeConfig: {} })).toBeNull();
    expect(bridgeFixedBindingConflict({ adapterType: "codex_local", adapterConfig: { cwd: "/projects/example" }, runtimeConfig: {} })).toBeNull();
  });
  it("validates existing directories without creating missing paths or accepting files and aliases", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fixed-cwd-"));
    try {
      await validateFixedLocalDirectory({ ...binding, cwd: root });
      await expect(validateFixedLocalDirectory({ ...binding, cwd: path.join(root, "missing") })).rejects.toThrow(/No directory was created/);
      await expect(access(path.join(root, "missing"))).rejects.toThrow();
      await writeFile(path.join(root, "file"), "fixture");
      await expect(validateFixedLocalDirectory({ ...binding, cwd: path.join(root, "file") })).rejects.toThrow();
      await symlink(root, path.join(root, "alias"));
      await expect(validateFixedLocalDirectory({ ...binding, cwd: path.join(root, "alias") })).rejects.toThrow(/canonical/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps a remote-host fixed directory off the controller and on its CC Pocket host", () => {
    const remote = { mode: "fixed" as const, cwd: "/home/yoyo/Projects/Product_Matching", hostId: "shopee-e" };
    expect(agentRuntimeConfigSchema.parse({ workspaceBinding: remote }).workspaceBinding).toEqual(remote);
    for (const hostId of ["", "Shopee-E", "../x", "a".repeat(65)]) expect(() => agentRuntimeConfigSchema.parse({ workspaceBinding: { ...remote, hostId } })).toThrow();
    // The controller never probes the remote path; it uses the agent home.
    expect(controllerLocalCwd(remote, remote.cwd, "agent-1")).toBe(resolveDefaultAgentWorkspaceDir("agent-1"));
    expect(controllerLocalCwd(binding, binding.cwd, "agent-1")).toBe(binding.cwd);
    // Only the remote project's own remote-managed source matches.
    expect(() => assertFixedProjectWorkspace(remote, { cwd: remote.cwd, sourceType: "remote_managed" }, true)).not.toThrow();
    expect(() => assertFixedProjectWorkspace(remote, null, false)).not.toThrow();
    for (const sourceType of ["local_path", undefined, null]) expect(() => assertFixedProjectWorkspace(remote, { cwd: remote.cwd, sourceType }, true)).toThrow(/remote-managed/);
    expect(() => assertFixedProjectWorkspace(remote, { cwd: "/home/yoyo/other", sourceType: "remote_managed" }, true)).toThrow(/differs/);
    // The run uses the local environment; the adapter reaches the host.
    const input = { binding: remote, environment: { driver: "local", config: {} }, trustPreset: "standard", mode: "shared_workspace", external: false, isDot: false, strategies: [] };
    expect(() => assertFixedWorkspacePolicy(input)).not.toThrow();
    expect(() => assertFixedWorkspacePolicy({ ...input, environment: { driver: "ssh", config: { workspaceMode: "in_place", remoteWorkspacePath: remote.cwd } } })).toThrow(/local environment/);
    // Only a CC Pocket agent on the same host, with a canonical path.
    const agent = { adapterType: "ccpocket_bridge", adapterConfig: { hostId: "shopee-e" } };
    expect(() => assertRemoteFixedBinding(remote, agent)).not.toThrow();
    expect(() => assertRemoteFixedBinding(binding, { adapterType: "codex_local", adapterConfig: {} })).not.toThrow();
    expect(() => assertRemoteFixedBinding(remote, { ...agent, adapterType: "codex_local" })).toThrow(/CC Pocket adapter/);
    expect(() => assertRemoteFixedBinding(remote, { ...agent, adapterConfig: { hostId: "shopee-d" } })).toThrow(/host differs/);
    expect(() => assertRemoteFixedBinding({ ...remote, cwd: "/home/yoyo/Projects/../Projects/Product_Matching" }, agent)).toThrow(/canonical/);
  });
  it("matches the actual prior host and cwd, never just an environment ID", () => {
    const environment = { driver: "ssh", config: { host: "host", port: 22, username: "worker" } };
    const run = { contextSnapshot: { paperclipEnvironment: { driver: "ssh", remoteCwd: binding.cwd, ...environment.config } }, runnerProfileJson: {} };
    expect(fixedWorkspaceMatchesRun({ binding, environment, run })).toBe(true);
    for (const config of [{ host: "another" }, { port: 2222 }, { username: "other" }]) expect(fixedWorkspaceMatchesRun({ binding, environment: { ...environment, config: { ...environment.config, ...config } }, run })).toBe(false);
    expect(fixedWorkspaceMatchesRun({ binding: { ...binding, cwd: "/other" }, environment, run })).toBe(false);
    expect(fixedWorkspaceMatchesRun({ binding, environment, run: { contextSnapshot: {}, runnerProfileJson: {} } })).toBe(false);
    const before = { runtimeConfig: { heartbeat: { enabled: false } }, adapterConfig: { model: "model" } };
    const after = { ...before, runtimeConfig: { ...before.runtimeConfig, workspaceBinding: binding } };
    expect(fixedBindingOnlyRevision(before, after)).toBe(true);
    expect(fixedBindingOnlyRevision(before, { ...after, adapterConfig: { model: "other" } })).toBe(false);
  });
});
