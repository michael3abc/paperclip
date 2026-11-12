import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

/** Host mechanics only. The server authorizes, records operation intent and owns
 * lifecycle/generation. This function is self-contained so the exact same code
 * can execute on a registered remote host without accessing its files locally. */
export interface ManagedWorktreeHostInput {
  action: "inspect" | "create" | "merge" | "retire";
  sourceCwd: string;
  cwd: string;
  parentDir: string;
  branch: string;
  targetBranch: string;
  operationId: string;
  receiptRoot: string;
  expectedHead?: string;
  expectedTargetHead?: string;
  /** Read/reconcile the original receipt; never submit its Git commands again. */
  recheckOnly?: boolean;
}

export interface ManagedWorktreeHostResult {
  schema: "paperclip.managed-worktree-host.v1";
  action: ManagedWorktreeHostInput["action"];
  operationId: string;
  cwd: string;
  commonDir: string;
  head: string;
  branch: string;
  targetHead: string;
  dirty: boolean;
  merged: boolean;
  retired?: boolean;
  rescuePath?: string;
}

export function managedWorktreeHostOperation(input: ManagedWorktreeHostInput): Promise<ManagedWorktreeHostResult> {
  return executeWorktreeOperation(input, { fs, path, execFile, promisify, createHash });
}

async function executeWorktreeOperation(input: ManagedWorktreeHostInput, { fs, path, execFile, promisify, createHash }: {
  fs: typeof import("node:fs/promises"); path: typeof import("node:path");
  execFile: typeof import("node:child_process").execFile; promisify: typeof import("node:util").promisify;
  createHash: typeof import("node:crypto").createHash;
}): Promise<ManagedWorktreeHostResult> {
  const exec = promisify(execFile);
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  const inside = (root: string, value: string) => {
    const relative = path.relative(root, value);
    return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (!["inspect", "create", "merge", "retire"].includes(input.action) ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(input.operationId)) fail("worktree_operation_invalid");
  if (["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]
    .some(key => process.env[key])) fail("worktree_git_override");
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = async (cwd: string, args: string[]) => (await exec("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args],
    { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...gitEnv, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } })).stdout;
  const exists = async (file: string) => fs.lstat(file).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  const canonical = async (value: string) => {
    if (!path.isAbsolute(value) || path.normalize(value) !== value || await fs.realpath(value) !== value) fail("worktree_path_not_canonical");
    return value;
  };
  const source = await canonical(input.sourceCwd), parent = await canonical(input.parentDir);
  if (!path.isAbsolute(input.cwd) || path.dirname(input.cwd) !== parent || input.cwd === source) fail("worktree_path_outside_parent");
  const sourceRoot = (await git(source, ["rev-parse", "--show-toplevel"])).trim();
  if (await fs.realpath(sourceRoot) !== source) fail("worktree_source_not_root");
  const common = await fs.realpath((await git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
  await git(source, ["check-ref-format", "refs/heads/" + input.branch]);
  await git(source, ["check-ref-format", "refs/heads/" + input.targetBranch]);
  if (input.branch === input.targetBranch) fail("worktree_target_is_candidate");
  const targetRef = "refs/heads/" + input.targetBranch;
  const targetHead = async () => (await git(source, ["rev-parse", "--verify", targetRef + "^{commit}"])).trim();
  const ancestor = async (head: string, target: string) => {
    try { await git(source, ["merge-base", "--is-ancestor", head, target]); return true; }
    catch (error) { if ((error as { code?: unknown }).code === 1) return false; throw error; }
  };
  const trees = async () => (await git(source, ["worktree", "list", "--porcelain", "-z"]))
    .split("\0\0").filter(Boolean).map(record => Object.fromEntries(record.split("\0").filter(Boolean).map(line => {
      const space = line.indexOf(" "); return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)];
    })));
  const inspect = async (): Promise<ManagedWorktreeHostResult> => {
    await canonical(input.cwd);
    if (!(await fs.lstat(path.join(input.cwd, ".git"))).isFile()) fail("execution_workspace_requires_linked_worktree");
    const ownCommon = await fs.realpath((await git(input.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
    const gitDir = await fs.realpath((await git(input.cwd, ["rev-parse", "--absolute-git-dir"])).trim());
    if (ownCommon !== common || gitDir === common || !inside(common, gitDir) ||
        (await git(input.cwd, ["rev-parse", "--show-toplevel"])).trim() !== input.cwd) fail("worktree_repository_mismatch");
    const rows = (await trees()).filter(row => row.worktree === input.cwd);
    if (rows.length !== 1 || rows[0]!.branch !== "refs/heads/" + input.branch) fail("workspace_branch_mismatch");
    const head = (await git(input.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const target = await targetHead();
    return { schema: "paperclip.managed-worktree-host.v1", action: input.action, operationId: input.operationId,
      cwd: input.cwd, commonDir: common, head, branch: input.branch, targetHead: target,
      dirty: (await git(input.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length > 0,
      merged: await ancestor(head, target) };
  };
  if (input.action === "inspect") return inspect();
  if (!input.expectedHead?.match(/^[0-9a-f]{40,64}$/) || !input.expectedTargetHead?.match(/^[0-9a-f]{40,64}$/)) fail("worktree_expected_heads_required");
  // A host receipt is written before any Git mutation. Lost replies consult only
  // this operation; a partial operation is never submitted to Git a second time.
  const root = await canonical(input.receiptRoot);
  const rootStat = await fs.stat(root);
  if (rootStat.uid !== process.getuid?.() || rootStat.mode & 0o077 || inside(source, root) || inside(parent, root)) fail("worktree_private_receipt_root_required");
  const operation = path.join(root, input.operationId);
  const { recheckOnly, ...originalInput } = input;
  const digest = createHash("sha256").update(JSON.stringify(originalInput)).digest("hex");
  try {
    if (recheckOnly) {
      if (!await exists(operation)) fail("worktree_operation_receipt_missing");
      throw Object.assign(new Error("read original"), { code: "EEXIST" });
    }
    await fs.mkdir(operation, { mode: 0o700 });
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const receipt = JSON.parse(await fs.readFile(path.join(operation, "receipt.json"), "utf8"));
    if (receipt.digest !== digest) fail("worktree_operation_conflict");
    if (receipt.state === "complete") return receipt.result;
    if (receipt.effectStarted === false) throw Object.assign(new Error(receipt.code ?? "worktree_operation_not_applied"), {
      code: receipt.code ?? "worktree_operation_not_applied", worktreeEffectStarted: false,
    });
    fail("worktree_operation_reconciliation_required");
  }
  const receipt = async (value: Record<string, unknown>) => {
    const file = path.join(operation, "receipt.next");
    const handle = await fs.open(file, "w", 0o600);
    try { await handle.writeFile(JSON.stringify({ digest, ...value })); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(file, path.join(operation, "receipt.json"));
    const directory = await fs.open(operation, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  };
  let effectStarted = false;
  await receipt({ state: "started", input: originalInput, effectStarted });
  const markEffect = async () => {
    effectStarted = true;
    await receipt({ state: "applying", input: originalInput, effectStarted });
  };
  const receiptDirectory = await fs.open(root, "r");
  try { await receiptDirectory.sync(); } finally { await receiptDirectory.close(); }
  try {
    if (await targetHead() !== input.expectedTargetHead) fail("worktree_target_moved");
    if (input.action === "create") {
      if (await exists(input.cwd)) fail("worktree_path_exists");
      await markEffect();
      await git(source, ["worktree", "add", "-b", input.branch, "--", input.cwd, input.expectedHead!]);
    } else {
      const before = await inspect();
      if (before.head !== input.expectedHead) fail("worktree_candidate_moved");
      if (input.action === "merge") {
        if (before.dirty) fail("worktree_candidate_dirty");
        let candidate = before.head;
        if (!before.merged && !await ancestor(input.expectedTargetHead!, candidate)) {
          // Preserve collaborator state: construct the merge in a private detached
          // worktree, never checkout/reset/stash in either shared checkout.
          const mergeTree = path.join(operation, "merge");
          await git(source, ["worktree", "add", "--detach", "--", mergeTree, input.expectedTargetHead!]);
          await git(mergeTree, ["merge", "--no-ff", "--no-edit", "--", candidate]);
          candidate = (await git(mergeTree, ["rev-parse", "HEAD"])).trim();
        }
        const targetTrees = (await trees()).filter(row => row.branch === targetRef);
        if (targetTrees.length > 1) fail("worktree_target_checkout_ambiguous");
        if (await targetHead() !== input.expectedTargetHead) fail("worktree_target_moved");
        if (!before.merged) {
          if (targetTrees.length) {
            const targetCwd = await canonical(String(targetTrees[0]!.worktree));
            const targetGit = (await git(targetCwd, ["rev-parse", "--absolute-git-dir"])).trim();
            if (await exists(path.join(targetGit, "index.lock"))) fail("worktree_target_busy");
            if ((await git(targetCwd, ["symbolic-ref", "HEAD"])).trim() !== targetRef ||
                (await git(targetCwd, ["rev-parse", "HEAD"])).trim() !== input.expectedTargetHead) fail("worktree_target_moved");
            const changed = (await git(targetCwd, ["diff", "--name-only", "-z", input.expectedTargetHead!, candidate, "--"])).split("\0").filter(Boolean);
            const dirty = [...(await git(targetCwd, ["diff", "--name-only", "-z", "HEAD", "--"])).split("\0"),
              ...(await git(targetCwd, ["ls-files", "--others", "-z"])).split("\0")].filter(Boolean);
            if (changed.some(file => dirty.some(local => local === file || local.startsWith(file + "/") || file.startsWith(local + "/"))))
              fail("worktree_target_dirty");
            // Include ignored files: Git merge can overwrite those silently. Unrelated local
            // edits remain intact. It also owns its index/ref locks.
            await markEffect();
            await git(targetCwd, ["merge", "--ff-only", "--", candidate]);
          } else {
            await markEffect();
            await git(source, ["update-ref", targetRef, candidate, input.expectedTargetHead!]);
          }
        }
      } else {
        if (!before.merged) fail("retire_blocked_unmerged_commits");
        // The server separately verifies managed runs, providers, leases and
        // services. Local observations are supplementary and never stop them.
        if (process.platform !== "linux") fail("retire_blocked_unknown_live");
        for (const pid of await fs.readdir("/proc")) {
          if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
          try {
            if ((await fs.stat("/proc/" + pid)).uid !== process.getuid?.()) continue;
            const cwd = await fs.realpath("/proc/" + pid + "/cwd");
            if (inside(input.cwd, cwd)) fail("retire_blocked_live_process");
            for (const fd of await fs.readdir("/proc/" + pid + "/fd")) {
              const target = await fs.readlink("/proc/" + pid + "/fd/" + fd);
              if (path.isAbsolute(target) && inside(input.cwd, target)) fail("retire_blocked_open_file");
            }
          } catch (error) {
            if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
            if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) fail("retire_blocked_unknown_live");
            throw error;
          }
        }
        // Includes ignored files and secrets, with no dereferencing. The receipt
        // contains paths/hashes only and stays outside the repo, owner-only.
        const archive = path.join(operation, "worktree.tar");
        await exec("tar", ["--create", "--file", archive, "--exclude=./.git", "-C", input.cwd, "."],
          { timeout: 30_000, maxBuffer: 64 * 1024 });
        await fs.chmod(archive, 0o600);
        const archiveHash = createHash("sha256");
        const archiveHandle = await fs.open(archive, "r");
        try { for await (const chunk of archiveHandle.createReadStream({ autoClose: false })) archiveHash.update(chunk); }
        finally { await archiveHandle.close(); }
        await fs.writeFile(path.join(operation, "backup.json"), JSON.stringify({ sha256: archiveHash.digest("hex"), head: before.head }), { mode: 0o600 });
        const after = await inspect();
        if (after.head !== before.head || after.targetHead !== before.targetHead) fail("worktree_changed_during_retire");
        if (after.dirty) fail("retire_blocked_dirty");
        await exec("tar", ["--compare", "--file", archive, "--exclude=./.git", "-C", input.cwd],
          { timeout: 30_000, maxBuffer: 64 * 1024 });
        // No force, no branch deletion or rescue-ref deletion. Git performs its
        // final dirty/locked checks; the main may keep the branch after retiring.
        await markEffect();
        await git(source, ["worktree", "remove", "--", input.cwd]);
        const result = { ...after, retired: true, rescuePath: archive };
        await receipt({ state: "complete", result });
        return result;
      }
    }
    const result = await inspect();
    if (input.action === "merge" && !result.merged) fail("worktree_merge_not_observed");
    await receipt({ state: "complete", result });
    return result;
  } catch (error) {
    await receipt({ state: "failed", effectStarted, code: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "worktree_git_operation_failed" });
    Object.assign(error as object, { worktreeEffectStarted: effectStarted });
    throw error;
  }
}

/** Execute with Node --input-type=module, passing JSON on stdin (never shell
 * interpolation). Both local and remote paths use this exact implementation. */
export function managedWorktreeHostScript(): string {
  return "import * as fs from 'node:fs/promises'; import * as path from 'node:path'; "
    + "import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { createHash } from 'node:crypto'; "
    + "const __name = (fn) => fn; let raw = ''; for await (const chunk of process.stdin) raw += chunk; "
    + "try { const result = await (" + executeWorktreeOperation.toString() + ")(JSON.parse(raw), { fs, path, execFile, promisify, createHash }); "
    + "process.stdout.write(JSON.stringify({ ok: true, result })); } catch (error) { "
    + "process.stdout.write(JSON.stringify({ ok: false, code: typeof error.code === 'string' ? error.code : 'worktree_git_operation_failed', worktreeEffectStarted: error.worktreeEffectStarted })); }";
}
