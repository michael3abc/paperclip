import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { managedWorktreeHostOperation as operation, managedWorktreeHostScript, type ManagedWorktreeHostInput } from "@paperclipai/adapter-utils/managed-worktree-host";

const exec = promisify(execFile);
const roots: string[] = [];
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args], { env: {
  ...process.env, GIT_AUTHOR_NAME: "Workspace Test", GIT_AUTHOR_EMAIL: "workspace@example.invalid",
  GIT_COMMITTER_NAME: "Workspace Test", GIT_COMMITTER_EMAIL: "workspace@example.invalid",
} })).stdout.trim();
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-tree-")); roots.push(root);
  const source = path.join(root, "source"), parent = path.join(root, "trees"), receiptRoot = path.join(root, "receipts");
  await Promise.all([source, parent, receiptRoot].map(p => fs.mkdir(p, { mode: 0o700 })));
  await git(source, "init", "--initial-branch=michael/main");
  await git(source, "config", "user.name", "Workspace Test");
  await git(source, "config", "user.email", "workspace@example.invalid");
  await fs.writeFile(path.join(source, "base.txt"), "base\n");
  await git(source, "add", "base.txt"); await git(source, "commit", "-m", "base");
  const head = await git(source, "rev-parse", "HEAD");
  const input: ManagedWorktreeHostInput = { action: "create", sourceCwd: source, cwd: path.join(parent, "batch"),
    parentDir: parent, branch: "michael/batch", targetBranch: "michael/main", operationId: randomUUID(), receiptRoot,
    expectedHead: head, expectedTargetHead: head };
  const created = await operation(input);
  const request = (action: ManagedWorktreeHostInput["action"], overrides: Partial<ManagedWorktreeHostInput> = {}) =>
    ({ ...input, action, operationId: randomUUID(), ...overrides });
  return { root, source, parent, input, created, request };
}

describe("managed linked Git worktree host operations", () => {
  it("creates once; a repeat (same or new operation) answers from Git and never touches the tree", async () => {
    const f = await fixture();
    expect(f.created).toMatchObject({ cwd: f.input.cwd, branch: "michael/batch", merged: true, dirty: false, outcome: "applied" });
    await fs.writeFile(path.join(f.input.cwd, "collaborator.txt"), "keep");
    const before = await git(f.source, "worktree", "list", "--porcelain");
    // Observed state, not the receipt, decides: the tree is there, so the repeat is done.
    expect(await operation(f.input)).toMatchObject({ head: f.created.head, branch: "michael/batch", dirty: true, outcome: "already_done" });
    expect(await operation({ ...f.input, operationId: randomUUID() })).toMatchObject({ outcome: "already_done" });
    // Another branch at the same path is a conflict, never a rewrite.
    await expect(operation({ ...f.input, operationId: randomUUID(), branch: "michael/other" })).rejects.toMatchObject({ code: "workspace_branch_mismatch" });
    expect(await git(f.source, "worktree", "list", "--porcelain")).toBe(before);
    expect(await fs.readFile(path.join(f.input.cwd, "collaborator.txt"), "utf8")).toBe("keep");
    // The audit log records each attempt but is never consulted.
    expect(JSON.parse(await fs.readFile(path.join(f.input.receiptRoot, f.input.operationId, "receipt.json"), "utf8")))
      .toMatchObject({ state: "complete", attempt: 2, result: { outcome: "already_done" } });
  });

  it("inspects dirty trees without changing HEAD or files", async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.input.cwd, "base.txt"), "collaborator\n");
    expect(await operation(f.request("inspect"))).toMatchObject({ dirty: true, head: f.created.head });
    expect(await git(f.input.cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/michael/batch");
  });

  it("rejects a primary checkout and never initializes an external directory", async () => {
    const f = await fixture();
    await expect(operation(f.request("inspect", { cwd: f.source, parentDir: f.root }))).rejects.toMatchObject({ code: "execution_workspace_requires_linked_worktree" });
    const external = path.join(f.parent, "data"); await fs.mkdir(external);
    await expect(operation(f.request("inspect", { cwd: external }))).rejects.toThrow();
    expect(await fs.readdir(external)).toEqual([]);
  });

  it("rejects aliases, another repository and a changed branch", async () => {
    const f = await fixture(); const alias = path.join(f.parent, "alias"); await fs.symlink(f.input.cwd, alias);
    await expect(operation(f.request("inspect", { cwd: alias }))).rejects.toMatchObject({ code: "worktree_path_not_canonical" });
    await git(f.input.cwd, "switch", "-c", "michael/new");
    await expect(operation(f.request("inspect"))).rejects.toMatchObject({ code: "workspace_branch_mismatch" });
    const g = await fixture();
    await expect(operation(g.request("inspect", { sourceCwd: f.source }))).rejects.toMatchObject({ code: "worktree_repository_mismatch" });
  });

  it.each(["local", "remote-script"])("inspects an existing linked worktree selected as its exact source (%s)", async transport => {
    const f = await fixture(), request = f.request("inspect", { sourceCwd: f.input.cwd });
    await fs.mkdir(path.join(f.input.cwd, ".lmas"));
    await fs.writeFile(path.join(f.input.cwd, ".lmas/result"), "preserve");
    await fs.writeFile(path.join(f.input.cwd, "base.txt"), "collaborator");
    const before = await git(f.source, "worktree", "list", "--porcelain");
    let result;
    if (transport === "local") result = await operation(request);
    else {
      const child = spawn(process.execPath, ["--input-type=module", "-e", managedWorktreeHostScript()], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
      const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      child.stdin.end(JSON.stringify(request));
      expect(await ended, err + out).toBe(0);
      const response = JSON.parse(out); expect(response.ok).toBe(true); result = response.result;
    }
    expect(result).toMatchObject({ action: "inspect", operationId: request.operationId, cwd: f.input.cwd,
      commonDir: path.join(f.source, ".git"), branch: f.input.branch, head: f.created.head, dirty: true });
    expect(await git(f.source, "worktree", "list", "--porcelain")).toBe(before);
    expect(await fs.readFile(path.join(f.input.cwd, ".lmas/result"), "utf8")).toBe("preserve");
    expect(await fs.readFile(path.join(f.input.cwd, "base.txt"), "utf8")).toBe("collaborator");
  });

  it.each(["alias", "foreign-root", "wrong-branch", "create", "merge", "retire"] as const)(
    "exact-source inspection preserves the %s boundary", async boundary => {
      const f = await fixture();
      let request = f.request("inspect", { sourceCwd: f.input.cwd });
      let code = "worktree_path_outside_parent";
      if (boundary === "alias") {
        const alias = path.join(f.parent, "alias"); await fs.symlink(f.input.cwd, alias);
        request = { ...request, cwd: alias, sourceCwd: alias }; code = "worktree_path_not_canonical";
      } else if (boundary === "foreign-root") {
        request.excludedRoots = [f.input.cwd]; code = "worktree_foreign_project_path";
      } else if (boundary === "wrong-branch") {
        request.branch = "michael/other"; code = "workspace_branch_mismatch";
      } else request.action = boundary;
      await expect(operation(request)).rejects.toMatchObject({ code });
      expect(await git(f.input.cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/michael/batch");
    });

  it("registers a repository root without touching dirty ignored or training artifacts", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, ".git/info/exclude"), ".lmas/\n");
    await fs.mkdir(path.join(f.source, ".lmas"));
    await fs.writeFile(path.join(f.source, ".lmas/checkpoint"), "retained");
    await fs.writeFile(path.join(f.source, "base.txt"), "dirty");
    const result = await operation(f.request("inspect", { kind: "repository_root", cwd: f.source, branch: "michael/main" }));
    expect(result).toMatchObject({ head: f.created.head, targetHead: null, merged: false, dirty: true });
    expect(await fs.readFile(path.join(f.source, ".lmas/checkpoint"), "utf8")).toBe("retained");
    expect(await git(f.source, "diff", "--name-only")).toBe("base.txt");
    await expect(operation(f.request("retire", { kind: "repository_root", cwd: f.source })))
      .rejects.toMatchObject({ code: "repository_root_metadata_lifecycle_only" });
  });

  it("explicitly initializes an unborn nested repository with metadata only and rechecks the original receipt", async () => {
    const f = await fixture(), cwd = path.join(f.parent, "paperclip/task-id/original");
    await fs.mkdir(path.join(cwd, ".git/info"), { recursive: true });
    await fs.mkdir(path.join(cwd, ".lmas"));
    await fs.writeFile(path.join(cwd, ".git/info/exclude"), ".lmas/\n");
    await fs.writeFile(path.join(cwd, ".lmas/checkpoint"), "private");
    await fs.writeFile(path.join(cwd, "work.txt"), "uncommitted");
    const request = f.request("initialize", { kind: "repository_root", sourceCwd: cwd, cwd, branch: "main", targetBranch: "main",
      expectedHead: undefined, expectedTargetHead: undefined });
    expect(await operation(request)).toMatchObject({ cwd, head: null, dirty: true, targetHead: null });
    expect(await git(cwd, "ls-files")).toBe("");
    expect(await git(cwd, "remote")).toBe("");
    expect(await fs.readFile(path.join(cwd, ".git/info/exclude"), "utf8")).toBe(".lmas/\n");
    expect(await fs.readFile(path.join(cwd, ".lmas/checkpoint"), "utf8")).toBe("private");
    expect(await operation({ ...request, recheckOnly: true })).toMatchObject({ cwd, head: null, outcome: "already_done" });
    expect(await operation({ ...request, action: "inspect" })).toMatchObject({ cwd, head: null });
    // Idempotent: the same initialization again finds this repository and changes nothing.
    expect(await operation({ ...request, operationId: randomUUID() })).toMatchObject({ cwd, head: null, outcome: "already_done" });
    expect(await git(cwd, "ls-files")).toBe("");
    // Other existing Git metadata is still never overwritten.
    await expect(operation({ ...request, operationId: randomUUID(), branch: "other" })).rejects.toMatchObject({ code: "repository_initialization_metadata_exists" });
  });

  it.each([
    ["initialize", "worktree_operation_not_observed"], ["create", null], ["merge", null], ["retire", "worktree_operation_not_observed"],
  ] as const)("recheck of %s answers from Git without a receipt and without effects", async (action, code) => {
    const f = await fixture(), cwd = path.join(f.parent, "existing-unregistered");
    await fs.mkdir(cwd);
    const request = f.request(action, action === "initialize" ? { kind: "repository_root", sourceCwd: cwd, cwd,
      branch: "main", targetBranch: "main", expectedHead: undefined, expectedTargetHead: undefined } : {});
    const before = await git(f.source, "worktree", "list", "--porcelain");
    const observed = await operation({ ...request, recheckOnly: true }).catch(error => error);
    // The created tree is on its branch and merged: create and merge are done; the
    // plain directory is not a repository and the tree is not retired.
    if (code) expect(observed).toMatchObject({ code });
    else expect(observed).toMatchObject({ action, cwd: f.input.cwd, head: f.created.head, outcome: "already_done" });
    expect(await fs.readdir(cwd)).toEqual([]);
    expect(await git(f.source, "worktree", "list", "--porcelain")).toBe(before);
    await expect(fs.stat(path.join(request.receiptRoot, request.operationId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks an original read-only inspect without a mutation receipt or Git effects", async () => {
    const f = await fixture(), request = f.request("inspect");
    const before = await git(f.source, "worktree", "list", "--porcelain");
    expect(await operation({ ...request, recheckOnly: true })).toMatchObject({ action: "inspect", head: f.created.head });
    await expect(fs.stat(path.join(request.receiptRoot, request.operationId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(f.source, "worktree", "list", "--porcelain")).toBe(before);
  });

  it("treats a started receipt as history only: recheck reads Git and a re-run completes the create", async () => {
    // A host that died after writing "started" (Remote-host-B 2026-11-16 left no receipt at all).
    const f = await fixture(), request = f.request("create", { cwd: path.join(f.parent, "still-starting"), branch: "michael/starting" });
    const directory = path.join(request.receiptRoot, request.operationId);
    await fs.mkdir(directory, { mode: 0o700 });
    const receipt = { digest: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
      state: "started", input: request, effectStarted: false };
    await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt));
    const before = await git(f.source, "worktree", "list", "--porcelain");
    await expect(operation({ ...request, recheckOnly: true })).rejects.toMatchObject({ code: "worktree_operation_not_observed" });
    expect(JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8"))).toEqual(receipt);
    await expect(fs.stat(request.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(f.source, "worktree", "list", "--porcelain")).toBe(before);
    expect(await operation(request)).toMatchObject({ cwd: request.cwd, branch: "michael/starting", outcome: "applied" });
    expect(await operation({ ...request, recheckOnly: true })).toMatchObject({ cwd: request.cwd, outcome: "already_done" });
    expect(JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8"))).toMatchObject({ state: "complete" });
  });

  it("rechecks a delayed original host request from Git before and after it arrives", async () => {
    const f = await fixture(), cwd = path.join(f.parent, "delayed-initialize");
    await fs.mkdir(cwd);
    const request = f.request("initialize", { kind: "repository_root", sourceCwd: cwd, cwd, branch: "main", targetBranch: "main",
      expectedHead: undefined, expectedTargetHead: undefined });
    // A live remote helper can await the original input even after its caller
    // loses the transport. Recheck only reports what Git shows at that moment.
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `process.stdout.write(${JSON.stringify("ready\n")});` + managedWorktreeHostScript()], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    const ready = new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject);
      child.once("close", code => reject(new Error(`Host helper closed before readiness (${code}): ${err}`))); });
    const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    try {
      await ready;
      // Before the original arrives Git shows no repository: not observed, nothing written.
      await expect(operation({ ...request, recheckOnly: true })).rejects.toMatchObject({ code: "worktree_operation_not_observed" });
      expect(await fs.readdir(cwd)).toEqual([]);
      child.stdin.end(JSON.stringify(request)); // Deliver the original request exactly once.
      expect(await ended, err + out).toBe(0);
      const result = JSON.parse(out.slice(out.indexOf("\n") + 1));
      expect(result).toMatchObject({ ok: true, result: { action: "initialize", cwd, head: null } });
      expect(await operation({ ...request, recheckOnly: true })).toEqual({ ...result.result, outcome: "already_done" });
      expect(await fs.readdir(path.join(request.receiptRoot, request.operationId))).toEqual(["receipt.json"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await ended;
    }
  });

  it("initializes repository roots through the remote host script without staging existing content", async () => {
    const f = await fixture(), cwd = path.join(f.parent, "existing-root"); await fs.mkdir(cwd);
    // New contract: ancestor exclude-only metadata is not a repository and must
    // not force a copy/move or an implicit initialization of that ancestor.
    await fs.mkdir(path.join(f.parent, ".git/info"), { recursive: true });
    await fs.writeFile(path.join(f.parent, ".git/info/exclude"), "private/\n");
    await fs.writeFile(path.join(cwd, "result.txt"), "keep");
    const request = f.request("initialize", { kind: "repository_root", cwd, branch: "main", targetBranch: "main" });
    const child = spawn(process.execPath, ["--input-type=module", "-e", managedWorktreeHostScript()], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin.end(JSON.stringify(request));
    expect(await ended, err + out).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, result: { cwd, head: null, dirty: true } });
    expect(await git(cwd, "ls-files")).toBe("");
    expect(await fs.readFile(path.join(cwd, "result.txt"), "utf8")).toBe("keep");
    expect(await fs.readdir(path.join(f.parent, ".git"))).toEqual(["info"]);
  });

  it("refuses creation through a symlinked nested parent and never initializes Git administrative paths", async () => {
    const f = await fixture(), alias = path.join(f.parent, "alias"); await fs.symlink(f.source, alias);
    await expect(operation(f.request("create", { cwd: path.join(alias, "new"), branch: "michael/alias" })))
      .rejects.toMatchObject({ code: "worktree_path_not_canonical" });
    expect(await fs.readdir(f.source)).not.toContain("new");
    await expect(operation(f.request("initialize", { kind: "repository_root", cwd: path.join(f.source, ".git/info"), branch: "main" })))
      .rejects.toMatchObject({ code: "worktree_path_outside_parent" });
  });

  it("preserves full nested linked cwd and rejects foreign roots and aliases", async () => {
    const f = await fixture(), cwd = path.join(f.parent, "paperclip/task-id/original");
    await fs.mkdir(path.dirname(cwd), { recursive: true });
    const created = await operation(f.request("create", { cwd, branch: "michael/nested" }));
    expect(created.cwd).toBe(cwd);
    await expect(operation(f.request("inspect", { cwd, branch: "michael/nested", excludedRoots: [path.dirname(cwd)] })))
      .rejects.toMatchObject({ code: "worktree_foreign_project_path" });
    const alias = path.join(f.parent, "alias-source"); await fs.symlink(f.source, alias);
    await expect(operation(f.request("inspect", { kind: "repository_root", cwd: alias, branch: "michael/main" })))
      .rejects.toMatchObject({ code: "worktree_path_not_canonical" });
  });

  it("fast-forwards a checked-out target while retaining unrelated local changes", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.input.cwd, "feature.txt"), "feature\n");
    await git(f.input.cwd, "add", "feature.txt"); await git(f.input.cwd, "commit", "-m", "feature");
    const head = await git(f.input.cwd, "rev-parse", "HEAD");
    await fs.writeFile(path.join(f.source, "base.txt"), "unrelated dirty\n");
    const merged = await operation(f.request("merge", { expectedHead: head }));
    expect(merged).toMatchObject({ merged: true, targetHead: head });
    expect(await fs.readFile(path.join(f.source, "base.txt"), "utf8")).toBe("unrelated dirty\n");
    expect(await git(f.source, "symbolic-ref", "HEAD")).toBe("refs/heads/michael/main");
  });

  it("preserves overlapping dirty target files and records the failed operation", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.input.cwd, "base.txt"), "feature\n");
    await git(f.input.cwd, "commit", "-am", "feature");
    const request = f.request("merge", { expectedHead: await git(f.input.cwd, "rev-parse", "HEAD") });
    await fs.writeFile(path.join(f.source, "base.txt"), "do not overwrite\n");
    await expect(operation(request)).rejects.toMatchObject({ code: "worktree_target_dirty" });
    expect(await fs.readFile(path.join(f.source, "base.txt"), "utf8")).toBe("do not overwrite\n");
    expect(await git(f.source, "rev-parse", "HEAD")).toBe(f.created.head);
    await expect(operation(request)).rejects.toMatchObject({ code: "worktree_target_dirty" });
    expect(JSON.parse(await fs.readFile(path.join(request.receiptRoot, request.operationId, "receipt.json"), "utf8")))
      .toMatchObject({ state: "failed", code: "worktree_target_dirty", attempt: 2 });
  });

  it("merges divergent commits in a private tree and keeps the candidate branch unchanged", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, "target.txt"), "target\n"); await git(f.source, "add", "."); await git(f.source, "commit", "-m", "target");
    await fs.writeFile(path.join(f.input.cwd, "feature.txt"), "feature\n"); await git(f.input.cwd, "add", "."); await git(f.input.cwd, "commit", "-m", "feature");
    const head = await git(f.input.cwd, "rev-parse", "HEAD"), target = await git(f.source, "rev-parse", "HEAD");
    const request = f.request("merge", { expectedHead: head, expectedTargetHead: target });
    const merged = await operation(request);
    expect(merged).toMatchObject({ merged: true, outcome: "applied" });
    expect(await git(f.source, "rev-list", "--parents", "-n", "1", "HEAD")).toContain(target + " " + head);
    expect(await git(f.input.cwd, "rev-parse", "HEAD")).toBe(head);
    // The private merge tree is removed (non-force) once clean; only the two real trees stay registered.
    expect((await git(f.source, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(2);
    // Merging again (lost reply): the target already contains the candidate.
    const mergeCommit = await git(f.source, "rev-parse", "HEAD");
    expect(await operation(request)).toMatchObject({ merged: true, targetHead: mergeCommit, outcome: "already_done" });
    expect(await git(f.source, "rev-parse", "HEAD")).toBe(mergeCommit);
  });

  it("refuses to overwrite ignored target content before starting a shared effect", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, ".git", "info", "exclude"), "local-data.txt\n");
    await fs.writeFile(path.join(f.source, "local-data.txt"), "private local data\n");
    await fs.writeFile(path.join(f.input.cwd, "local-data.txt"), "incoming\n");
    await git(f.input.cwd, "add", "-f", "local-data.txt"); await git(f.input.cwd, "commit", "-m", "candidate");
    await expect(operation(f.request("merge", { expectedHead: await git(f.input.cwd, "rev-parse", "HEAD") })))
      .rejects.toMatchObject({ code: "worktree_target_dirty" });
    expect(await fs.readFile(path.join(f.source, "local-data.txt"), "utf8")).toBe("private local data\n");
    expect(await git(f.source, "rev-parse", "HEAD")).toBe(f.created.head);
  });

  it("refuses stale heads and newly committed work after merge", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.input.cwd, "feature.txt"), "new\n"); await git(f.input.cwd, "add", "."); await git(f.input.cwd, "commit", "-m", "new");
    await expect(operation(f.request("merge"))).rejects.toMatchObject({ code: "worktree_candidate_moved" });
    await expect(operation(f.request("retire", { expectedHead: await git(f.input.cwd, "rev-parse", "HEAD") })))
      .rejects.toMatchObject({ code: "retire_blocked_unmerged_commits" });
    expect(await fs.readdir(f.input.cwd)).toContain("feature.txt");
    await expect(operation(f.request("merge", { expectedTargetHead: "f".repeat(40) }))).rejects.toMatchObject({ code: "worktree_target_moved" });
  });

  it("executes the identical host script in a separate Node process using stdin only", async () => {
    const f = await fixture();
    const child = spawn(process.execPath, ["--input-type=module", "-e", managedWorktreeHostScript()], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin.end(JSON.stringify(f.request("inspect")));
    expect(await ended, err + out).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, result: { cwd: f.input.cwd, head: f.created.head } });
  });

  async function hostScript(request: ManagedWorktreeHostInput) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", managedWorktreeHostScript()], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin.end(JSON.stringify(request));
    expect(await ended, err + out).toBe(0);
    return JSON.parse(out);
  }

  it("creates a missing parent directory on its own host, repeats idempotently, then retires through the host script", async () => {
    // Remote-host-B 2026-11-16 (op cbdd1528): the configured parent did not exist yet and
    // create failed before writing any receipt. Workspace = directory: create it.
    const f = await fixture(), parentDir = path.join(f.root, "new-host-parent", "trees"), cwd = path.join(parentDir, "nested", "remote");
    const create = f.request("create", { parentDir, cwd, branch: "michael/remote" });
    const created = await hostScript(create);
    expect(created).toMatchObject({ ok: true, result: { action: "create", cwd, branch: "michael/remote", dirty: false, merged: true, outcome: "applied" } });
    expect(await git(cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/michael/remote");
    // A repeat of the same request (lost reply) and a new request both answer from Git.
    expect(await hostScript(create)).toMatchObject({ ok: true, result: { cwd, head: created.result.head, outcome: "already_done" } });
    expect(await hostScript({ ...create, operationId: randomUUID() })).toMatchObject({ ok: true, result: { outcome: "already_done" } });
    const retire = f.request("retire", { parentDir, cwd, branch: "michael/remote", expectedHead: undefined, expectedTargetHead: undefined });
    const retired = await hostScript(retire);
    expect(retired).toMatchObject({ ok: true, result: { action: "retire", cwd, retired: true, outcome: "applied",
      rescuePath: path.join(retire.receiptRoot, retire.operationId, "worktree.tar") } });
    await expect(fs.stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(f.source, "rev-parse", "--verify", "refs/heads/michael/remote")).toBe(f.created.head);
    // Retiring again finds no tree and reports the earlier backup; the branch is kept.
    expect(await hostScript(retire)).toMatchObject({ ok: true, result: { retired: true, outcome: "already_done",
      head: f.created.head, rescuePath: retired.result.rescuePath } });
  });

  it("never creates a missing parent through a symlinked ancestor", async () => {
    const f = await fixture(), alias = path.join(f.root, "alias-parent"); await fs.symlink(f.source, alias);
    const parentDir = path.join(alias, "trees");
    const response = await hostScript(f.request("create", { parentDir, cwd: path.join(parentDir, "batch"), branch: "michael/alias-parent" }));
    expect(response).toMatchObject({ ok: false, code: "worktree_path_not_canonical" });
    expect(await fs.readdir(f.source)).not.toContain("trees");
  });

  it("re-runs an interrupted create: a made parent, a branch without its tree, or a tree without a final receipt", async () => {
    const f = await fixture();
    // 1. Interrupted after mkdir -p of the parent: nothing else exists yet.
    const parentDir = path.join(f.root, "later-parent");
    await fs.mkdir(parentDir);
    const first = f.request("create", { parentDir, cwd: path.join(parentDir, "one"), branch: "michael/one" });
    expect(await operation(first)).toMatchObject({ outcome: "applied", branch: "michael/one" });
    // 2. Git's own add was interrupted after it made the branch (its signal handler
    //    removes the half-made tree): the branch is reused, not refused.
    await git(f.source, "branch", "michael/two", f.created.head!);
    const second = f.request("create", { cwd: path.join(f.parent, "two"), branch: "michael/two" });
    expect(await operation(second)).toMatchObject({ outcome: "applied", head: f.created.head, branch: "michael/two" });
    // 3. The tree was made but the host died before verifying it ("started" receipt).
    const third = f.request("create", { cwd: path.join(f.parent, "three"), branch: "michael/three" });
    await git(f.source, "worktree", "add", "-b", "michael/three", path.join(f.parent, "three"), f.created.head!);
    expect(await operation(third)).toMatchObject({ outcome: "already_done", branch: "michael/three" });
    // A same-named branch that does not contain the requested start commit is not adopted.
    await git(f.source, "switch", "--orphan", "unrelated");
    await git(f.source, "commit", "--allow-empty", "-m", "unrelated");
    await git(f.source, "branch", "michael/foreign");
    await git(f.source, "switch", "michael/main");
    await expect(operation(f.request("create", { cwd: path.join(f.parent, "foreign"), branch: "michael/foreign" })))
      .rejects.toMatchObject({ code: "worktree_branch_exists" });
    await expect(fs.stat(path.join(f.parent, "foreign"))).rejects.toMatchObject({ code: "ENOENT" });
    // A non-empty directory that is not a tree is never reused or overwritten.
    await fs.mkdir(path.join(f.parent, "occupied")); await fs.writeFile(path.join(f.parent, "occupied", "data.txt"), "keep");
    await expect(operation(f.request("create", { cwd: path.join(f.parent, "occupied"), branch: "michael/occupied" })))
      .rejects.toMatchObject({ code: "worktree_path_exists" });
    expect(await fs.readFile(path.join(f.parent, "occupied", "data.txt"), "utf8")).toBe("keep");
  });

  it("merges output far beyond the old 8 MiB buffer and ignored directories in the target checkout", async () => {
    // Home 2026-11-16: merge failed three times with "stdout maxBuffer length exceeded".
    const f = await fixture();
    const deep = path.join("generated", ...Array.from({ length: 15 }, (_, i) => String(i).padStart(2, "0") + "x".repeat(240)));
    await fs.mkdir(path.join(f.input.cwd, deep), { recursive: true });
    await Promise.all(Array.from({ length: 2400 }, (_, i) => fs.writeFile(path.join(f.input.cwd, deep, "f" + i), String(i))));
    await git(f.input.cwd, "add", "generated"); await git(f.input.cwd, "commit", "-q", "-m", "generated");
    const nameBytes = (await exec("git", ["-C", f.input.cwd, "diff", "--name-only", "-z", f.created.head!, "HEAD"], { maxBuffer: Infinity })).stdout.length;
    expect(nameBytes).toBeGreaterThan(8 * 1024 * 1024);
    // Many ignored files in the shared target checkout (a dependency cache).
    await fs.writeFile(path.join(f.source, ".git", "info", "exclude"), "cache/\n");
    await fs.mkdir(path.join(f.source, "cache", "nested"), { recursive: true });
    await Promise.all(Array.from({ length: 500 }, (_, i) => fs.writeFile(path.join(f.source, "cache", "nested", "c" + i), "x")));
    const head = await git(f.input.cwd, "rev-parse", "HEAD");
    expect(await operation(f.request("merge", { expectedHead: head }))).toMatchObject({ merged: true, targetHead: head, outcome: "applied" });
    expect(await git(f.source, "rev-parse", "HEAD")).toBe(head);
    expect(await fs.readdir(path.join(f.source, "cache", "nested"))).toHaveLength(500);
  }, 120_000);

  async function liveProcess(cwd: string, nonDumpable: boolean) {
    // PR_SET_DUMPABLE=0 makes /proc/<pid>/cwd and fd unreadable to the same uid,
    // like user systemd, sd-pam, ssh-agent and sshd-session on the real hosts.
    const script = (nonDumpable ? "import ctypes; ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)\n" : "")
      + "import sys, time\nsys.stdout.write('ready'); sys.stdout.flush()\ntime.sleep(120)\n";
    const child = spawn("python3", ["-c", script], { cwd, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
    return child;
  }

  it.runIf(process.platform === "linux")("retires past unreadable same-uid processes; a readable process inside the tree still blocks", async () => {
    const f = await fixture();
    const unreadable = await liveProcess(f.root, true);
    try {
      await expect(fs.readlink("/proc/" + unreadable.pid + "/cwd")).rejects.toMatchObject({ code: "EACCES" });
      const inside = await liveProcess(f.input.cwd, false);
      try {
        await expect(operation(f.request("retire"))).rejects.toMatchObject({ code: "retire_blocked_live_process" });
        expect(await git(f.input.cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/michael/batch");
      } finally { inside.kill("SIGKILL"); await new Promise(resolve => inside.once("close", resolve)); }
      expect(await operation(f.request("retire"))).toMatchObject({ retired: true, outcome: "applied" });
      await expect(fs.stat(f.input.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { unreadable.kill("SIGKILL"); }
  });

  it("never removes a dirty tree and backs up ignored files privately before non-force removal", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.input.cwd, "base.txt"), "modified");
    await expect(operation(f.request("retire"))).rejects.toMatchObject({ code: "retire_blocked_dirty" });
    await git(f.input.cwd, "checkout", "--", "base.txt");
    await fs.writeFile(path.join(f.input.cwd, "untracked.txt"), "keep");
    await expect(operation(f.request("retire"))).rejects.toMatchObject({ code: "retire_blocked_dirty" });
    expect(await fs.readFile(path.join(f.input.cwd, "untracked.txt"), "utf8")).toBe("keep");
    await fs.rm(path.join(f.input.cwd, "untracked.txt"));
    // Ignored files only: Git calls the tree clean, so they are archived first.
    await fs.writeFile(path.join(f.source, ".git", "info", "exclude"), ".lmas/\nsecret.env\n");
    await fs.mkdir(path.join(f.input.cwd, ".lmas")); await fs.writeFile(path.join(f.input.cwd, ".lmas", "checkpoint"), "weights");
    await fs.writeFile(path.join(f.input.cwd, "secret.env"), "TOKEN=fixture");
    const request = f.request("retire");
    const result = await operation(request);
    expect(result).toMatchObject({ retired: true, rescuePath: path.join(request.receiptRoot, request.operationId, "worktree.tar") });
    expect((await fs.stat(result.rescuePath!)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(result.rescuePath!))).mode & 0o777).toBe(0o700);
    expect((await exec("tar", ["-tf", result.rescuePath!])).stdout.split("\n")).toEqual(expect.arrayContaining(["./.lmas/checkpoint", "./secret.env"]));
    await expect(fs.stat(f.input.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    // A plain directory at a tree path is never deleted.
    const plain = path.join(f.parent, "plain"); await fs.mkdir(plain); await fs.writeFile(path.join(plain, "data"), "keep");
    await expect(operation(f.request("retire", { cwd: plain }))).rejects.toMatchObject({ code: "worktree_not_registered" });
    expect(await fs.readFile(path.join(plain, "data"), "utf8")).toBe("keep");
  });
});
