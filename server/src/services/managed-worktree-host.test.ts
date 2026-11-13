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
  it("creates once and returns only the original receipt after a lost response", async () => {
    const f = await fixture();
    expect(f.created).toMatchObject({ cwd: f.input.cwd, branch: "michael/batch", merged: true, dirty: false });
    await fs.writeFile(path.join(f.input.cwd, "collaborator.txt"), "keep");
    expect(await operation(f.input)).toEqual(f.created);
    await expect(operation({ ...f.input, branch: "michael/other" })).rejects.toMatchObject({ code: "worktree_operation_conflict" });
    expect(await fs.readFile(path.join(f.input.cwd, "collaborator.txt"), "utf8")).toBe("keep");
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
    expect(await operation({ ...request, recheckOnly: true })).toMatchObject({ cwd, head: null });
    expect(await operation({ ...request, action: "inspect" })).toMatchObject({ cwd, head: null });
    await expect(operation({ ...request, operationId: randomUUID() })).rejects.toMatchObject({ code: "repository_initialization_metadata_exists" });
  });

  it.each(["initialize", "create", "merge", "retire"] as const)(
    "retains an unknown %s outcome when recheck cannot find the original receipt", async action => {
      const f = await fixture(), cwd = path.join(f.parent, "existing-unregistered");
      await fs.mkdir(cwd);
      const request = f.request(action, action === "initialize" ? { kind: "repository_root", sourceCwd: cwd, cwd,
        branch: "main", targetBranch: "main", expectedHead: undefined, expectedTargetHead: undefined } : {});
      const before = await git(f.source, "worktree", "list", "--porcelain");
      const error = await operation({ ...request, recheckOnly: true }).catch(error => error);
      expect(error).toMatchObject({ code: "worktree_operation_receipt_missing" });
      // New rule: absence cannot certify no effect or release a pending mutation.
      expect(error.worktreeEffectStarted).toBeUndefined();
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

  it("keeps a started receipt unknown until the original host records a terminal outcome", async () => {
    const f = await fixture(), request = f.request("create", { cwd: path.join(f.parent, "still-starting"), branch: "michael/starting" });
    const directory = path.join(request.receiptRoot, request.operationId);
    await fs.mkdir(directory, { mode: 0o700 });
    const receipt = { digest: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
      state: "started", input: request, effectStarted: false };
    await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt));
    const before = await git(f.source, "worktree", "list", "--porcelain");
    const error = await operation({ ...request, recheckOnly: true }).catch(error => error);
    expect(error).toMatchObject({ code: "worktree_operation_reconciliation_required" });
    expect(error.worktreeEffectStarted).toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8"))).toEqual(receipt);
    await expect(fs.stat(request.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(f.source, "worktree", "list", "--porcelain")).toBe(before);
  });

  it("does not certify a delayed original host request as no-effect before its receipt exists", async () => {
    const f = await fixture(), cwd = path.join(f.parent, "delayed-initialize");
    await fs.mkdir(cwd);
    const request = f.request("initialize", { kind: "repository_root", sourceCwd: cwd, cwd, branch: "main", targetBranch: "main",
      expectedHead: undefined, expectedTargetHead: undefined });
    // A live remote helper can await the original input even after its caller
    // loses the transport. Recheck is neither a stop fence nor permission to retry.
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `process.stdout.write(${JSON.stringify("ready\n")});` + managedWorktreeHostScript()], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    const ready = new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject);
      child.once("close", code => reject(new Error(`Host helper closed before readiness (${code}): ${err}`))); });
    const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    try {
      await ready;
      const missing = await operation({ ...request, recheckOnly: true }).catch(error => error);
      expect(missing).toMatchObject({ code: "worktree_operation_receipt_missing" });
      expect(missing.worktreeEffectStarted).toBeUndefined();
      expect(await fs.readdir(cwd)).toEqual([]);
      child.stdin.end(JSON.stringify(request)); // Deliver the original request exactly once.
      expect(await ended, err + out).toBe(0);
      const result = JSON.parse(out.slice(out.indexOf("\n") + 1));
      expect(result).toMatchObject({ ok: true, result: { action: "initialize", cwd, head: null } });
      expect(await operation({ ...request, recheckOnly: true })).toEqual(result.result);
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
    await expect(operation(request)).rejects.toMatchObject({ code: "worktree_target_dirty", worktreeEffectStarted: false });
    expect(await fs.readFile(path.join(f.source, "base.txt"), "utf8")).toBe("do not overwrite\n");
    expect(await git(f.source, "rev-parse", "HEAD")).toBe(f.created.head);
    await expect(operation(request)).rejects.toMatchObject({ code: "worktree_target_dirty", worktreeEffectStarted: false });
  });

  it("merges divergent commits in a private tree and keeps the candidate branch unchanged", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, "target.txt"), "target\n"); await git(f.source, "add", "."); await git(f.source, "commit", "-m", "target");
    await fs.writeFile(path.join(f.input.cwd, "feature.txt"), "feature\n"); await git(f.input.cwd, "add", "."); await git(f.input.cwd, "commit", "-m", "feature");
    const head = await git(f.input.cwd, "rev-parse", "HEAD"), target = await git(f.source, "rev-parse", "HEAD");
    const merged = await operation(f.request("merge", { expectedHead: head, expectedTargetHead: target }));
    expect(merged.merged).toBe(true);
    expect(await git(f.source, "rev-list", "--parents", "-n", "1", "HEAD")).toContain(target + " " + head);
    expect(await git(f.input.cwd, "rev-parse", "HEAD")).toBe(head);
  });

  it("refuses to overwrite ignored target content before starting a shared effect", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, ".git", "info", "exclude"), "local-data.txt\n");
    await fs.writeFile(path.join(f.source, "local-data.txt"), "private local data\n");
    await fs.writeFile(path.join(f.input.cwd, "local-data.txt"), "incoming\n");
    await git(f.input.cwd, "add", "-f", "local-data.txt"); await git(f.input.cwd, "commit", "-m", "candidate");
    await expect(operation(f.request("merge", { expectedHead: await git(f.input.cwd, "rev-parse", "HEAD") })))
      .rejects.toMatchObject({ code: "worktree_target_dirty", worktreeEffectStarted: false });
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
});
