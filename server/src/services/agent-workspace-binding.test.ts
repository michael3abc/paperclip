import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentRuntimeConfigSchema } from "@paperclipai/shared";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { appliedFixedWorkspaceStrategies, bridgeFixedBindingConflict, assertFixedProjectWorkspace, assertFixedWorkspacePolicy, assertRemoteFixedBinding, controllerLocalCwd, ensureFixedLocalDirectory, fixedBindingOnlyRevision, fixedWorkspaceMatchesRun, readWorkspaceBinding, workspaceBindingConflict } from "./agent-workspace-binding.js";

describe("fixed workspace binding", () => {
  const binding = { mode: "fixed" as const, cwd: "/projects/example" };
  it("validates typed API data while retaining other runtime settings", () => {
    expect(agentRuntimeConfigSchema.parse({ workspaceBinding: binding, heartbeat: { enabled: false } }).workspaceBinding).toEqual(binding);
    for (const value of [{ mode: "copy", cwd: "/project" }, { mode: "fixed", cwd: "relative" }, { mode: "fixed", cwd: "" }, { ...binding, cwd: "/project\0x" }, { ...binding, clone: true }, null]) {
      expect(() => agentRuntimeConfigSchema.parse({ workspaceBinding: value })).toThrow();
    }
    expect(readWorkspaceBinding({})).toBeNull();
    expect(readWorkspaceBinding({ workspaceBinding: { ...binding, cwd: " /projects/example " } })).toEqual(binding);
    // Liveness-first: an unusable fixed binding is skipped (logged), so the run falls back to the next directory.
    expect(readWorkspaceBinding({ workspaceBinding: { mode: "fixed", cwd: "relative" } })).toBeNull();
  });
  it("logs a workspace mismatch and returns its reason instead of failing the run", () => {
    expect(() => workspaceBindingConflict("project_conflict", "differs")).not.toThrow();
    expect(workspaceBindingConflict("project_conflict", "differs", { cwd: binding.cwd })).toBe("fixed_workspace_project_conflict");
  });
  it("reports project conflicts as advisory mismatches and keeps the fixed directory", () => {
    expect(assertFixedProjectWorkspace(binding, { cwd: "/projects/example/" }, true)).toEqual([]);
    expect(assertFixedProjectWorkspace(binding, null, false)).toEqual([]);
    for (const row of [null, { cwd: null }, { cwd: "/other" }]) {
      expect(() => assertFixedProjectWorkspace(binding, row, true)).not.toThrow();
      expect(assertFixedProjectWorkspace(binding, row, true)).toEqual(["fixed_workspace_project_conflict"]);
    }
  });
  it("logs low trust, external chat, isolation, provisioning and environment mismatches without throwing", () => {
    type PolicyInput = Parameters<typeof assertFixedWorkspacePolicy>[0];
    const input: PolicyInput = { binding, environment: { driver: "local", config: {} }, trustPreset: "standard", mode: "shared_workspace", external: false, isDot: false, strategies: [] };
    expect(assertFixedWorkspacePolicy(input)).toEqual([]);
    const cases: Array<[Partial<PolicyInput>, string]> = [
      [{ trustPreset: "low_trust_review" }, "fixed_workspace_isolation_required"], [{ external: true }, "fixed_workspace_isolation_required"],
      [{ mode: "isolated_workspace" }, "fixed_workspace_policy_conflict"], [{ mode: "operator_branch" }, "fixed_workspace_policy_conflict"],
      [{ isDot: true }, "fixed_workspace_environment_conflict"], [{ environment: null }, "fixed_workspace_environment_conflict"],
      [{ environment: { driver: "sandbox", config: {} } }, "fixed_workspace_environment_conflict"], [{ environment: { driver: "ssh", config: {} } }, "fixed_workspace_environment_conflict"],
      [{ strategies: [{ type: "git_worktree" }] }, "fixed_workspace_provisioning_conflict"], [{ strategies: [{ provisionCommand: "mkdir project" }] }, "fixed_workspace_provisioning_conflict"],
    ];
    for (const [patch, reason] of cases) {
      expect(() => assertFixedWorkspacePolicy({ ...input, ...patch })).not.toThrow();
      expect(assertFixedWorkspacePolicy({ ...input, ...patch })).toContain(reason);
    }
    expect(assertFixedWorkspacePolicy({ ...input, environment: { driver: "ssh", config: { workspaceMode: "in_place", remoteWorkspacePath: binding.cwd } } })).toEqual([]);
  });
  it("flags only the strategies that would actually shape a fixed run", () => {
    const input = { binding, environment: { driver: "local", config: {} }, trustPreset: "standard", mode: "shared_workspace", external: false, isDot: false };
    const workerDefault = { type: "git_worktree", branchTemplate: "paperclip/{{issue.id}}" };
    // A project's worker worktree default is unused by a shared fixed run.
    const shared = appliedFixedWorkspaceStrategies({ mode: "shared_workspace", mergedConfig: {}, configSnapshot: {},
      projectPolicy: { workspaceStrategy: workerDefault }, issueStrategy: { type: "project_primary" }, environmentStrategy: undefined });
    expect(shared).not.toContain(workerDefault);
    expect(assertFixedWorkspacePolicy({ ...input, strategies: shared })).toEqual([]);
    // Applied strategies are still reported (logged only): merged, explicit task, environment or a storage provider's project strategy.
    for (const strategies of [
      appliedFixedWorkspaceStrategies({ mode: "shared_workspace", mergedConfig: { workspaceStrategy: workerDefault }, configSnapshot: {}, projectPolicy: null, issueStrategy: undefined, environmentStrategy: undefined }),
      appliedFixedWorkspaceStrategies({ mode: "shared_workspace", mergedConfig: {}, configSnapshot: {}, projectPolicy: null, issueStrategy: workerDefault, environmentStrategy: undefined }),
      appliedFixedWorkspaceStrategies({ mode: "shared_workspace", mergedConfig: {}, configSnapshot: {}, projectPolicy: null, issueStrategy: undefined, environmentStrategy: workerDefault }),
      appliedFixedWorkspaceStrategies({ mode: "shared_workspace", mergedConfig: {}, configSnapshot: {}, projectPolicy: { workspaceStrategy: workerDefault, storageProviderPluginId: "p" }, issueStrategy: undefined, environmentStrategy: undefined }),
      appliedFixedWorkspaceStrategies({ mode: "shared_workspace", mergedConfig: { provisionCommand: "make" }, configSnapshot: {}, projectPolicy: null, issueStrategy: undefined, environmentStrategy: undefined }),
    ]) expect(assertFixedWorkspacePolicy({ ...input, strategies })).toEqual(["fixed_workspace_provisioning_conflict"]);
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
  it("creates a missing fixed directory with mkdir -p and falls back only when the path is unusable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fixed-cwd-"));
    try {
      await expect(ensureFixedLocalDirectory({ ...binding, cwd: root })).resolves.toBe(true);
      const missing = path.join(root, "missing", "nested");
      await expect(ensureFixedLocalDirectory({ ...binding, cwd: missing })).resolves.toBe(true);
      expect((await stat(missing)).isDirectory()).toBe(true);
      await writeFile(path.join(root, "file"), "fixture");
      // A file cannot be a working directory: the caller falls back to the next directory.
      await expect(ensureFixedLocalDirectory({ ...binding, cwd: path.join(root, "file") })).resolves.toBe(false);
      await expect(ensureFixedLocalDirectory({ ...binding, cwd: "relative" })).resolves.toBe(false);
      // A symbolic alias is logged and still used.
      await symlink(root, path.join(root, "alias"));
      await expect(ensureFixedLocalDirectory({ ...binding, cwd: path.join(root, "alias") })).resolves.toBe(true);
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
    expect(assertFixedProjectWorkspace(remote, { cwd: remote.cwd, sourceType: "remote_managed" }, true)).toEqual([]);
    expect(assertFixedProjectWorkspace(remote, null, false)).toEqual([]);
    // Mismatches are logged only; the remote fixed directory is still used.
    for (const sourceType of ["local_path", undefined, null]) expect(assertFixedProjectWorkspace(remote, { cwd: remote.cwd, sourceType }, true)).toEqual(["fixed_workspace_project_conflict"]);
    expect(assertFixedProjectWorkspace(remote, { cwd: "/home/yoyo/other", sourceType: "remote_managed" }, true)).toEqual(["fixed_workspace_project_conflict"]);
    // The run uses the local environment; the adapter reaches the host.
    const input = { binding: remote, environment: { driver: "local", config: {} }, trustPreset: "standard", mode: "shared_workspace", external: false, isDot: false, strategies: [] };
    expect(assertFixedWorkspacePolicy(input)).toEqual([]);
    expect(assertFixedWorkspacePolicy({ ...input, environment: { driver: "ssh", config: { workspaceMode: "in_place", remoteWorkspacePath: remote.cwd } } })).toEqual(["fixed_workspace_environment_conflict"]);
    // A CC Pocket agent on the same host with a canonical path matches; anything else is logged, never thrown.
    const agent = { adapterType: "ccpocket_bridge", adapterConfig: { hostId: "shopee-e" } };
    expect(assertRemoteFixedBinding(remote, agent)).toEqual([]);
    expect(assertRemoteFixedBinding(binding, { adapterType: "codex_local", adapterConfig: {} })).toEqual([]);
    expect(() => assertRemoteFixedBinding(remote, { ...agent, adapterType: "codex_local" })).not.toThrow();
    expect(assertRemoteFixedBinding(remote, { ...agent, adapterType: "codex_local" })).toContain("fixed_workspace_environment_conflict");
    expect(assertRemoteFixedBinding(remote, { ...agent, adapterConfig: { hostId: "shopee-d" } })).toEqual(["fixed_workspace_environment_conflict"]);
    expect(assertRemoteFixedBinding({ ...remote, cwd: "/home/yoyo/Projects/../Projects/Product_Matching" }, agent)).toEqual(["fixed_workspace_path_alias"]);
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
