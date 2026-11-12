import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
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
    await expect(operation(f.request("inspect", { cwd: f.source, parentDir: f.root }))).rejects.toMatchObject({ code: "worktree_path_outside_parent" });
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
