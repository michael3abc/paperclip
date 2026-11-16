import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

/** Host mechanics only. The server authorizes and records operation intent; this
 * function is self-contained so the exact same code can execute on a registered
 * remote host without accessing its files locally.
 *
 * Observed Git state is the source of truth (Owner 2026-11-16). Every action reads
 * `git worktree list --porcelain`, the branch, HEAD, refs and dirty status, then
 * decides "already done", "do it" or "conflict" and verifies the result from Git.
 * Running the same input twice is safe. Host receipts are an audit log only: they
 * are never read to decide an outcome, and a missing receipt proves nothing. */
export interface ManagedWorktreeHostInput {
  action: "inspect" | "create" | "initialize" | "merge" | "retire";
  kind?: "repository_root" | "linked_worktree";
  /** Server-scoped foreign roots on this same host; never caller grants. */
  excludedRoots?: string[];
  sourceCwd: string;
  cwd: string;
  parentDir: string;
  branch: string;
  targetBranch: string;
  operationId: string;
  /** Private owner-only directory for audit receipts and retire backups. */
  receiptRoot: string;
  /** create: start commit when the branch does not exist yet. merge: the candidate HEAD being merged. */
  expectedHead?: string;
  /** merge: the target HEAD the merge was decided against. */
  expectedTargetHead?: string;
  /** Observe only: report whether this action's desired Git state holds now; never run its Git mutations. */
  recheckOnly?: boolean;
}

export interface ManagedWorktreeHostResult {
  schema: "paperclip.managed-worktree-host.v1";
  action: ManagedWorktreeHostInput["action"];
  operationId: string;
  cwd: string;
  commonDir: string;
  head: string | null;
  branch: string;
  targetHead: string | null;
  dirty: boolean;
  merged: boolean;
  retired?: boolean;
  rescuePath?: string;
  /** applied: this call changed Git; already_done: Git already showed the desired state; observed: read-only. */
  outcome?: "applied" | "already_done" | "observed";
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
  // Bounds for large trees: long enough for a big checkout, merge or backup, never unbounded.
  const GIT_TIMEOUT_MS = 10 * 60_000, TAR_TIMEOUT_MS = 10 * 60_000;
  const fail = (code: string, detail?: string): never => {
    throw Object.assign(new Error(detail ? code + ": " + detail : code), detail ? { code, detail } : { code });
  };
  const inside = (root: string, value: string) => {
    const relative = path.relative(root, value);
    return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (!["inspect", "create", "initialize", "merge", "retire"].includes(input.action) ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(input.operationId)) fail("worktree_operation_invalid");
  if (["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]
    .some(key => process.env[key])) fail("worktree_git_override");
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  /** Output is never capped (maxBuffer): a large merge or untracked listing must not fail the operation. */
  const tool = async (file: string, args: string[], timeout: number, code: string, env?: Record<string, string | undefined>) => {
    try { return (await exec(file, args, { timeout, maxBuffer: Infinity, ...(env ? { env } : {}) })).stdout; }
    catch (error) {
      const raw = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown };
      throw Object.assign(new Error(code), {
        code: raw.killed || raw.signal === "SIGTERM" ? "worktree_host_timeout" : code,
        exitCode: typeof raw.code === "number" ? raw.code : null,
        detail: String(raw.stderr ?? "").trim().slice(-500) || undefined,
      });
    }
  };
  const git = (cwd: string, args: string[]) => tool("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args],
    GIT_TIMEOUT_MS, "worktree_git_operation_failed", { ...gitEnv, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
  /** Exit status of a Git predicate (0 true, 1 false); any other failure is an error. */
  const gitTest = async (cwd: string, args: string[]) => {
    try { await git(cwd, args); return true; }
    catch (error) { if ((error as { exitCode?: unknown }).exitCode === 1) return false; throw error; }
  };
  const exists = async (file: string) => fs.lstat(file).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  const canonical = async (value: string, missing = "worktree_path_missing") => {
    if (!path.isAbsolute(value) || path.normalize(value) !== value) fail("worktree_path_not_canonical");
    const real = await fs.realpath(value).catch(error => {
      if (error.code === "ENOENT") fail(missing, value);
      throw error;
    });
    if (real !== value) fail("worktree_path_not_canonical");
    return value;
  };
  /** mkdir -p beneath an existing real directory, one component at a time; a
   * symlinked component anywhere in the path is refused, never followed. */
  const ensureDirectory = async (value: string) => {
    if (!path.isAbsolute(value) || path.normalize(value) !== value) fail("worktree_path_not_canonical");
    const missing: string[] = [];
    let existing = value;
    while (!await exists(existing)) { missing.unshift(existing); existing = path.dirname(existing); }
    await canonical(existing);
    if (!(await fs.lstat(existing)).isDirectory()) fail("worktree_parent_not_directory", existing);
    for (const directory of missing) {
      await fs.mkdir(directory).catch(error => { if (error.code !== "EEXIST") throw error; });
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail("worktree_path_not_canonical", directory);
    }
    return canonical(value);
  };
  const split = (value: string) => value.split("\0").filter(Boolean);
  const repositoryRoot = input.kind === "repository_root";
  if (input.kind !== undefined && !["repository_root", "linked_worktree"].includes(input.kind)) fail("worktree_kind_invalid");
  if (input.action === "initialize" && !repositoryRoot) fail("worktree_initialize_requires_repository_root");
  if (repositoryRoot && ["create", "merge", "retire"].includes(input.action)) fail("repository_root_metadata_lifecycle_only");
  const source = await canonical(input.sourceCwd, "worktree_source_missing");
  // A new tree may name a parent that does not exist yet (create makes it), and a
  // retired tree's parent may be gone; their path checks stay lexical. Every other
  // action requires the canonical parent.
  if (!path.isAbsolute(input.parentDir) || path.normalize(input.parentDir) !== input.parentDir) fail("worktree_path_not_canonical");
  const parent = inside(source, input.cwd) ? source
    : ["create", "retire"].includes(input.action) && !await exists(input.parentDir) ? input.parentDir
      : await canonical(input.parentDir);
  // A configured source may already be this linked worktree. Read-only
  // registration/finalization still verifies its Git admin file, common dir and
  // branch below; equality alone neither makes it a primary checkout nor grants
  // permission to mutate the configured source.
  if (!path.isAbsolute(input.cwd) || path.normalize(input.cwd) !== input.cwd ||
      input.cwd.split(path.sep).includes(".git") ||
      (!inside(parent, input.cwd) && !inside(source, input.cwd)) ||
      (!repositoryRoot && input.cwd === source && input.action !== "inspect")) fail("worktree_path_outside_parent");
  for (const excluded of input.excludedRoots ?? []) {
    const resolved = await fs.realpath(excluded).catch(error => { if (error.code === "ENOENT") return excluded; throw error; });
    if (inside(resolved, input.cwd) || inside(input.cwd, resolved)) fail("worktree_foreign_project_path");
  }
  if (!repositoryRoot) {
    const sourceRoot = (await git(source, ["rev-parse", "--show-toplevel"])).trim();
    if (await fs.realpath(sourceRoot) !== source) fail("worktree_source_not_root");
  }
  const common = repositoryRoot ? path.join(input.cwd, ".git")
    : await fs.realpath((await git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
  await git(source, ["check-ref-format", "refs/heads/" + input.branch]);
  await git(source, ["check-ref-format", "refs/heads/" + input.targetBranch]);
  if (!repositoryRoot && input.branch === input.targetBranch) fail("worktree_target_is_candidate");
  const branchRef = "refs/heads/" + input.branch, targetRef = "refs/heads/" + input.targetBranch;
  const targetHead = async () => (await git(source, ["rev-parse", "--verify", targetRef + "^{commit}"])).trim();
  const refHead = async (ref: string) => await gitTest(source, ["show-ref", "--verify", "--quiet", ref])
    ? (await git(source, ["rev-parse", "--verify", ref + "^{commit}"])).trim() : null;
  const ancestor = (head: string, target: string) => gitTest(source, ["merge-base", "--is-ancestor", head, target]);
  const trees = async () => (await git(source, ["worktree", "list", "--porcelain", "-z"]))
    .split("\0\0").filter(Boolean).map(record => Object.fromEntries(record.split("\0").filter(Boolean).map(line => {
      const space = line.indexOf(" "); return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)];
    })) as Record<string, string | true>);
  const treeAt = async (cwd: string) => (await trees()).filter(row => row.worktree === cwd);
  // Untracked directories are collapsed; only a boolean is needed.
  const isDirty = async (cwd: string) => (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"])).length > 0;
  const inspect = async (): Promise<ManagedWorktreeHostResult> => {
    await canonical(input.cwd);
    if (repositoryRoot) {
      if (!(await fs.lstat(common)).isDirectory() || await fs.realpath(common) !== common) fail("execution_workspace_requires_repository_root");
      const ownCommon = (await git(input.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
      if (ownCommon !== common || (await git(input.cwd, ["rev-parse", "--absolute-git-dir"])).trim() !== common
        || (await git(input.cwd, ["rev-parse", "--show-toplevel"])).trim() !== input.cwd) fail("worktree_repository_mismatch");
      if ((await git(input.cwd, ["symbolic-ref", "HEAD"])).trim() !== branchRef) fail("workspace_branch_mismatch");
      let head: string | null;
      try { head = (await git(input.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim(); }
      catch (error) {
        // A missing branch ref with a valid symbolic HEAD is an unborn repo, not
        // permission to ignore a corrupt or inaccessible existing commit.
        if ((error as { exitCode?: unknown }).exitCode !== 128) throw error;
        if (await gitTest(input.cwd, ["show-ref", "--verify", "--quiet", branchRef])) throw error;
        head = null;
      }
      return { schema: "paperclip.managed-worktree-host.v1", action: input.action, operationId: input.operationId,
        cwd: input.cwd, commonDir: common, head, branch: input.branch, targetHead: null, merged: false,
        dirty: await isDirty(input.cwd), outcome: "observed" };
    }
    const admin = await fs.lstat(path.join(input.cwd, ".git")).catch(error => {
      if (error.code === "ENOENT") fail("execution_workspace_requires_linked_worktree");
      throw error;
    });
    if (!admin.isFile()) fail("execution_workspace_requires_linked_worktree");
    const ownCommon = await fs.realpath((await git(input.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
    const gitDir = await fs.realpath((await git(input.cwd, ["rev-parse", "--absolute-git-dir"])).trim());
    if (ownCommon !== common || gitDir === common || !inside(common, gitDir) ||
        (await git(input.cwd, ["rev-parse", "--show-toplevel"])).trim() !== input.cwd) fail("worktree_repository_mismatch");
    const rows = await treeAt(input.cwd);
    if (rows.length !== 1 || rows[0]!.branch !== branchRef) fail("workspace_branch_mismatch");
    const head = (await git(input.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const target = await targetHead();
    return { schema: "paperclip.managed-worktree-host.v1", action: input.action, operationId: input.operationId,
      cwd: input.cwd, commonDir: common, head, branch: input.branch, targetHead: target,
      dirty: await isDirty(input.cwd), merged: await ancestor(head, target), outcome: "observed" };
  };
  if (input.action === "inspect") return inspect();
  const observeOnly = input.recheckOnly === true;
  const notObserved = (): never => fail("worktree_operation_not_observed");

  // Audit log and private scratch space, outside every repository. Best effort for
  // audit; merge commits and retire backups require it.
  let operationDir: string | null = null;
  try {
    const root = await canonical(input.receiptRoot);
    const stat = await fs.stat(root);
    if (stat.isDirectory() && stat.uid === process.getuid?.() && !(stat.mode & 0o077)
      && !inside(source, root) && !inside(parent, root) && !inside(root, input.cwd) && !inside(input.cwd, root)) {
      const directory = path.join(root, input.operationId);
      // An observation never writes; it only reads an earlier attempt's directory.
      if (!observeOnly) await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      const own = await fs.lstat(directory);
      if (own.isDirectory() && own.uid === process.getuid?.() && !(own.mode & 0o077)) operationDir = directory;
    }
  } catch { operationDir = null; }
  const privateDir = () => operationDir ?? fail("worktree_private_receipt_root_required");
  const { recheckOnly: _recheckOnly, ...originalInput } = input;
  const digest = createHash("sha256").update(JSON.stringify(originalInput)).digest("hex");
  let attempt = 1;
  if (operationDir && !observeOnly) {
    try { attempt = Number(JSON.parse(await fs.readFile(path.join(operationDir, "receipt.json"), "utf8")).attempt ?? 0) + 1; }
    catch { attempt = 1; }
  }
  const audit = async (value: Record<string, unknown>) => {
    if (!operationDir || observeOnly) return;
    try {
      const file = path.join(operationDir, "receipt.next");
      const handle = await fs.open(file, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ schema: "paperclip.managed-worktree-host-audit.v1", digest, attempt,
          at: new Date().toISOString(), input: originalInput, ...value }));
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(file, path.join(operationDir, "receipt.json"));
    } catch { /* Audit only: never decides or blocks an operation. */ }
  };

  const initialize = async (): Promise<ManagedWorktreeHostResult> => {
    await canonical(input.cwd);
    if (await exists(common)) {
      // This exact repository root on this branch: already initialized.
      const observed = await inspect().catch(() => null);
      if (observed) return { ...observed, outcome: "already_done" };
      // Preserve a legacy ignore-only .git/info/exclude in place. All other
      // metadata (including symlinks) requires explicit investigation.
      if (!(await fs.lstat(common)).isDirectory() || await fs.realpath(common) !== common
        || JSON.stringify((await fs.readdir(common)).sort()) !== JSON.stringify(["info"])) fail("repository_initialization_metadata_exists");
      const info = path.join(common, "info"), exclude = path.join(info, "exclude");
      if (!(await fs.lstat(info)).isDirectory() || await fs.realpath(info) !== info
        || JSON.stringify(await fs.readdir(info)) !== JSON.stringify(["exclude"])
        || !(await fs.lstat(exclude)).isFile()) fail("repository_initialization_metadata_exists");
    }
    if (observeOnly) notObserved();
    await git(input.cwd, ["init", "--quiet", "--template=", "--initial-branch=" + input.branch, "."]);
    return { ...await inspect(), outcome: "applied" };
  };

  const create = async (): Promise<ManagedWorktreeHostResult> => {
    const registered = await treeAt(input.cwd);
    if (registered.length) {
      // Already a linked worktree here: done when it is this repository and branch.
      if (registered[0]!.branch !== branchRef) fail("workspace_branch_mismatch");
      // Git's own add was killed before it finished (SIGKILL/power loss); its
      // partial checkout is left for the main to inspect, never repaired or deleted.
      if (registered[0]!.locked === "initializing") fail("worktree_create_incomplete");
      return { ...await inspect(), outcome: "already_done" };
    }
    if (observeOnly) notObserved();
    if (!input.expectedHead?.match(/^[0-9a-f]{40,64}$/)) fail("worktree_expected_heads_required");
    if (await exists(input.cwd)) {
      // Git accepts an existing empty directory; anything else is not ours to reuse.
      if (!(await fs.lstat(input.cwd)).isDirectory() || (await fs.readdir(input.cwd)).length) fail("worktree_path_exists");
      await canonical(input.cwd);
    } else await ensureDirectory(path.dirname(input.cwd));
    const branchHead = await refHead(branchRef);
    if (branchHead === null) {
      await git(source, ["worktree", "add", "--quiet", "-b", input.branch, "--", input.cwd, input.expectedHead!]);
    } else {
      // An interrupted earlier create can leave the branch without its tree. Reuse
      // the branch only when it starts at or descends from the requested commit and
      // no other tree has it checked out.
      if (branchHead !== input.expectedHead && !await ancestor(input.expectedHead!, branchHead)) fail("worktree_branch_exists");
      if ((await trees()).some(row => row.branch === branchRef)) fail("worktree_branch_checked_out");
      await git(source, ["worktree", "add", "--quiet", "--", input.cwd, input.branch]);
    }
    return { ...await inspect(), outcome: "applied" };
  };

  const merge = async (): Promise<ManagedWorktreeHostResult> => {
    const before = await inspect();
    if (before.merged) return { ...before, outcome: "already_done" };
    if (observeOnly) notObserved();
    if (!input.expectedHead?.match(/^[0-9a-f]{40,64}$/) || !input.expectedTargetHead?.match(/^[0-9a-f]{40,64}$/)) fail("worktree_expected_heads_required");
    if (before.targetHead !== input.expectedTargetHead) fail("worktree_target_moved");
    if (before.head !== input.expectedHead) fail("worktree_candidate_moved");
    if (before.dirty) fail("worktree_candidate_dirty");
    let candidate = before.head!;
    if (!await ancestor(input.expectedTargetHead!, candidate)) {
      // Preserve collaborator state: construct the merge in a private detached
      // worktree, never checkout/reset/stash in either shared checkout. The
      // private tree is removed (non-force) once it is clean again.
      const mergeTree = path.join(privateDir(), "merge-" + Date.now() + "-" + process.pid);
      await git(source, ["worktree", "add", "--quiet", "--detach", "--", mergeTree, input.expectedTargetHead!]);
      try {
        try { await git(mergeTree, ["merge", "--no-ff", "--no-edit", "--quiet", "--no-stat", "--", candidate]); }
        catch (error) {
          await git(mergeTree, ["merge", "--abort"]).catch(() => undefined);
          throw Object.assign(error as object, { code: "worktree_merge_conflict" });
        }
        candidate = (await git(mergeTree, ["rev-parse", "HEAD"])).trim();
      } finally {
        await git(source, ["worktree", "remove", "--", mergeTree]).catch(() => undefined);
      }
    }
    const targetTrees = (await trees()).filter(row => row.branch === targetRef);
    if (targetTrees.length > 1) fail("worktree_target_checkout_ambiguous");
    if (await targetHead() !== input.expectedTargetHead) fail("worktree_target_moved");
    if (targetTrees.length) {
      const targetCwd = await canonical(String(targetTrees[0]!.worktree));
      const targetGit = (await git(targetCwd, ["rev-parse", "--absolute-git-dir"])).trim();
      if (await exists(path.join(targetGit, "index.lock"))) fail("worktree_target_busy");
      if ((await git(targetCwd, ["symbolic-ref", "HEAD"])).trim() !== targetRef ||
          (await git(targetCwd, ["rev-parse", "HEAD"])).trim() !== input.expectedTargetHead) fail("worktree_target_moved");
      // Refuse before any shared effect when an incoming path overlaps a local
      // change, untracked or ignored file of the target checkout (Git merge can
      // overwrite ignored files silently). Untracked directories are collapsed, so
      // the listing stays small; unrelated local edits remain intact.
      const changed = split(await git(targetCwd, ["diff", "--name-only", "--no-renames", "-z", input.expectedTargetHead!, candidate, "--"]));
      const local = [...split(await git(targetCwd, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"])),
        ...split(await git(targetCwd, ["ls-files", "--others", "--directory", "-z"]))].map(file => file.replace(/\/+$/, ""));
      const localPaths = new Set(local), localParents = new Set<string>();
      for (const file of local) for (let dir = path.posix.dirname(file); dir !== "." && dir !== "/"; dir = path.posix.dirname(dir)) localParents.add(dir);
      const overlaps = (file: string) => {
        if (localPaths.has(file) || localParents.has(file)) return true;
        for (let dir = path.posix.dirname(file); dir !== "." && dir !== "/"; dir = path.posix.dirname(dir)) if (localPaths.has(dir)) return true;
        return false;
      };
      if (changed.some(overlaps)) fail("worktree_target_dirty");
      await git(targetCwd, ["merge", "--ff-only", "--quiet", "--", candidate]);
    } else {
      await git(source, ["update-ref", targetRef, candidate, input.expectedTargetHead!]);
    }
    const after = await inspect();
    if (!after.merged) fail("worktree_merge_not_observed");
    return { ...after, outcome: "applied" };
  };

  const latestBackup = async () => {
    if (!operationDir) return undefined;
    const names = (await fs.readdir(operationDir).catch(() => [] as string[])).filter(name => /^worktree(-\d+)?\.tar$/.test(name));
    let latest: { file: string; time: number } | undefined;
    for (const name of names) {
      const file = path.join(operationDir, name), time = (await fs.stat(file)).mtimeMs;
      if (!latest || time > latest.time) latest = { file, time };
    }
    return latest?.file;
  };

  const retire = async (): Promise<ManagedWorktreeHostResult> => {
    const registered = await treeAt(input.cwd);
    if (!registered.length) {
      // A plain directory at this path is never deleted.
      if (await exists(input.cwd)) fail("worktree_not_registered");
      // Already retired: report the branch as Git shows it now (it is never deleted).
      const head = await refHead(branchRef), target = await refHead(targetRef);
      const rescuePath = await latestBackup();
      return { schema: "paperclip.managed-worktree-host.v1", action: input.action, operationId: input.operationId,
        cwd: input.cwd, commonDir: common, head, branch: input.branch, targetHead: target, dirty: false,
        merged: head === null || (target !== null && await ancestor(head, target)), retired: true,
        ...(rescuePath ? { rescuePath } : {}), outcome: "already_done" };
    }
    const before = await inspect();
    if (observeOnly) notObserved();
    if (!before.merged) fail("retire_blocked_unmerged_commits");
    if (before.dirty) fail("retire_blocked_dirty");
    if (registered[0]!.locked) fail("retire_blocked_locked");
    // Only a readable process whose cwd or open file is inside the tree blocks.
    // Same-uid but non-dumpable processes (user systemd, sd-pam, ssh-agent, the
    // delivering sshd-session) hide cwd and fds; they are skipped. The server
    // separately checks managed runs, leases and services.
    if (process.platform === "linux") {
      for (const pid of await fs.readdir("/proc")) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
        let blocked: string | null = null;
        try {
          if ((await fs.stat("/proc/" + pid)).uid !== process.getuid?.()) continue;
          const cwd = await fs.readlink("/proc/" + pid + "/cwd");
          if (path.isAbsolute(cwd) && inside(input.cwd, cwd)) blocked = "retire_blocked_live_process";
          else for (const fd of await fs.readdir("/proc/" + pid + "/fd")) {
            const target = await fs.readlink("/proc/" + pid + "/fd/" + fd).catch(() => "");
            if (path.isAbsolute(target) && inside(input.cwd, target)) { blocked = "retire_blocked_open_file"; break; }
          }
        } catch { continue; }
        if (blocked) fail(blocked, "pid " + pid);
      }
    }
    // Back up everything except Git metadata, including ignored files and
    // secrets, with no dereferencing. Owner-only, outside every repository; an
    // earlier backup of the same operation is never overwritten.
    const directory = privateDir();
    let archive = path.join(directory, "worktree.tar");
    if (await exists(archive)) archive = path.join(directory, "worktree-" + Date.now() + ".tar");
    await tool("tar", ["--create", "--file", archive, "--exclude=./.git", "-C", input.cwd, "."], TAR_TIMEOUT_MS, "worktree_backup_failed");
    await fs.chmod(archive, 0o600);
    const archiveHash = createHash("sha256");
    const archiveHandle = await fs.open(archive, "r");
    try { for await (const chunk of archiveHandle.createReadStream({ autoClose: false })) archiveHash.update(chunk); }
    finally { await archiveHandle.close(); }
    await fs.writeFile(archive + ".json", JSON.stringify({ sha256: archiveHash.digest("hex"), head: before.head }), { mode: 0o600 });
    const after = await inspect();
    if (after.head !== before.head || after.targetHead !== before.targetHead) fail("worktree_changed_during_retire");
    if (after.dirty) fail("retire_blocked_dirty");
    await tool("tar", ["--compare", "--file", archive, "--exclude=./.git", "-C", input.cwd], TAR_TIMEOUT_MS, "worktree_backup_mismatch");
    // No force, no branch deletion. Git performs its own final dirty/locked checks.
    await git(source, ["worktree", "remove", "--", input.cwd]);
    if ((await treeAt(input.cwd)).length || await exists(input.cwd)) fail("worktree_retire_not_observed");
    return { ...after, retired: true, rescuePath: archive, outcome: "applied" };
  };

  await audit({ state: "started" });
  try {
    const result = input.action === "initialize" ? await initialize() : input.action === "create" ? await create()
      : input.action === "merge" ? await merge() : await retire();
    await audit({ state: "complete", result });
    return result;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    await audit({ state: "failed", code: typeof code === "string" ? code : "worktree_git_operation_failed" });
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
    + "process.stdout.write(JSON.stringify({ ok: false, code: typeof error.code === 'string' ? error.code : 'worktree_git_operation_failed', "
    + "detail: typeof error.detail === 'string' ? error.detail.slice(-500) : undefined })); }";
}
