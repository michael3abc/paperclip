import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { agents, executionWorkspaces, projectWorkspaces, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { forbidden, unprocessable } from "../errors.js";
import { assertPmRun, type PmCoordinationScope } from "./pm-coordination-policy.js";
import { authorizationService } from "./authorization.js";

const execFile = promisify(execFileCallback);
const read = z.object({ path: z.string().min(1).max(4096), projectWorkspaceId: z.string().uuid().optional(), executionWorkspaceId: z.string().uuid().optional(), commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional(), startLine: z.number().int().min(1).default(1),
  maxLines: z.number().int().min(1).max(500).default(200) }).strict();
const search = z.object({ text: z.string().min(1).max(500), projectWorkspaceId: z.string().uuid().optional(), executionWorkspaceId: z.string().uuid().optional(), path: z.string().max(4096).default("."),
  maxResults: z.number().int().min(1).max(100).default(50) }).strict();
export const PM_PROJECT_READ_TOOLS = [
  { name: "read_project_file", description: "Read project text files, including dotfiles, .env and credentials authorized by the Owner. Use this for project source reads; provider-native readers cover only your instruction bundle. Paths are relative to your project root or selected projectWorkspaceId / executionWorkspaceId. For fixed-version review supply a full commit SHA without changing the checkout. Other projects, including nested projects, are denied. Do not copy credentials into reports, comments or repository changes.", inputSchema: z.toJSONSchema(read) },
  { name: "search_project_files", description: "Search literal text in your project's files, including .env and dotfiles. Other registered projects and symlink escapes are denied. Recursive scans skip Git metadata and dependencies; an explicit file can be read with read_project_file. Binary content is unsupported. Narrow the path when the bounded scan limit is reached. Do not reproduce credentials in reports or comments.", inputSchema: z.toJSONSchema(search) },
];

export async function executePmProjectRead(db: Db, scope: PmCoordinationScope, runId: string, name: string, input: unknown) {
  const { run } = await assertPmRun(db, scope, runId);
  const request = name === "read_project_file" ? read.parse(input) : search.parse(input);
  if (request.projectWorkspaceId && request.executionWorkspaceId) throw unprocessable("Select one configured source or task workspace");
  let selectedRoot = scope.workerRoot;
  if (request.executionWorkspaceId) {
    const [workspace] = await db.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.id, request.executionWorkspaceId), eq(executionWorkspaces.companyId, scope.companyId),
      eq(executionWorkspaces.projectId, scope.projectId)));
    if (!workspace?.cwd) throw forbidden("The task workspace is outside this PM's project or unavailable");
    if (workspace.sourceIssueId && !(await authorizationService(db).decide({
      actor: { type: "agent", source: "agent_jwt", agentId: scope.agentId, companyId: scope.companyId,
        runId, onBehalfOfUserId: run.responsibleUserId ?? undefined },
      action: "issue:read", resource: { type: "issue", companyId: scope.companyId, issueId: workspace.sourceIssueId },
    })).allowed) throw forbidden("The task workspace is outside this PM's readable tasks");
    selectedRoot = workspace.cwd;
  }
  if (request.projectWorkspaceId) {
    const [source] = await db.select({ cwd: projectWorkspaces.cwd }).from(projectWorkspaces).where(and(
      eq(projectWorkspaces.id, request.projectWorkspaceId), eq(projectWorkspaces.companyId, scope.companyId),
      eq(projectWorkspaces.projectId, scope.projectId)));
    if (!source?.cwd) throw forbidden("The configured local source is outside this PM's project or unavailable");
    selectedRoot = source.cwd;
  }
  const root = await fs.realpath(selectedRoot);
  // The home project can contain other registered projects. Root containment
  // alone is not project authorization. Resolve once per request, never per file.
  const [sources, workspaces, bindings] = await Promise.all([
    db.select({ companyId: projectWorkspaces.companyId, projectId: projectWorkspaces.projectId, cwd: projectWorkspaces.cwd }).from(projectWorkspaces),
    db.select({ companyId: executionWorkspaces.companyId, projectId: executionWorkspaces.projectId, cwd: executionWorkspaces.cwd }).from(executionWorkspaces),
    db.select({ companyId: agents.companyId, runtimeConfig: agents.runtimeConfig }).from(agents),
  ]);
  const foreignSources = [...sources, ...workspaces, ...bindings.flatMap(({ companyId, runtimeConfig }) => {
    const binding = runtimeConfig?.workspaceBinding as { projectId?: string; workerRoot?: string } | undefined;
    return binding?.projectId && binding.workerRoot ? [{ companyId, projectId: binding.projectId, cwd: binding.workerRoot }] : [];
  })].filter(source => source.projectId && (source.companyId !== scope.companyId || source.projectId !== scope.projectId) && source.cwd);
  const within = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const excluded = new Set<string>();
  for (const source of foreignSources) {
    const lexical = path.resolve(source.cwd!);
    let resolved: string | undefined;
    try { resolved = await fs.realpath(source.cwd!); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // An explicitly selected source already passed same-project authorization.
    // Its exact physical root may be shared within the company. A broad home,
    // foreign nested root or cross-company registration is never such a grant.
    if (request.projectWorkspaceId && source.companyId === scope.companyId && resolved === root) continue;
    if (within(root, lexical)) excluded.add(lexical);
    if (resolved && within(root, resolved)) excluded.add(resolved);
  }
  function assertProjectPath(candidate: string) {
    if (!within(root, candidate) || [...excluded].some(foreign => within(foreign, candidate))) {
      throw forbidden("The requested path is outside this PM's project");
    }
  }
  async function contained(relative: string) {
    assertProjectPath(path.resolve(root, relative));
    const candidate = await fs.realpath(path.resolve(root, relative));
    assertProjectPath(candidate);
    return candidate;
  }
  async function text(file: string) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // Bind the actual opened inode, including intermediate symlink races.
      if (process.platform !== "linux") throw forbidden("Project file reader is not qualified on this platform");
      await contained(await fs.realpath(`/proc/self/fd/${handle.fd}`));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 512 * 1024) throw unprocessable("Read a text file smaller than 512 KiB");
      const bytes = await handle.readFile();
      if (bytes.includes(0)) throw unprocessable("Binary content is not supported by this text reader");
      return bytes.toString("utf8");
    } finally { await handle.close(); }
  }
  if (name === "read_project_file") {
    const args = read.parse(input);
    if (args.commit) {
      if (path.isAbsolute(args.path) || args.path.split(/[\\/]/).some(part => !part || part === "." || part === "..") || args.path.includes(":")) {
        throw forbidden("Use a relative repository file path");
      }
      assertProjectPath(path.resolve(root, args.path));
      const git = async (argv: string[]) => (await execFile("git", ["--no-pager", "-C", root, ...argv],
        { timeout: 10_000, maxBuffer: 512 * 1024 })).stdout;
      const repoRoot = await fs.realpath((await git(["rev-parse", "--show-toplevel"])).trim());
      if (repoRoot !== root) throw forbidden("Fixed-version reads require the assigned repository root");
      const entry = await git(["ls-tree", "-z", args.commit, "--", `:(literal)${args.path}`]);
      if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(entry) || entry.split("\0").filter(Boolean).length !== 1) {
        throw unprocessable("The commit path must be a regular text file");
      }
      const content = await git(["cat-file", "blob", `${args.commit}:${args.path}`]);
      if (content.includes("\0")) throw unprocessable("Binary content is not supported by this text reader");
      const lines = content.split("\n");
      return { path: args.path, commit: args.commit, startLine: args.startLine, totalLines: lines.length,
        content: lines.slice(args.startLine - 1, args.startLine - 1 + args.maxLines).join("\n") };
    }
    const file = await contained(args.path);
    const lines = (await text(file)).split("\n");
    return { path: path.relative(root, file), startLine: args.startLine, totalLines: lines.length,
      content: lines.slice(args.startLine - 1, args.startLine - 1 + args.maxLines).join("\n") };
  }
  const args = search.parse(input), start = await contained(args.path);
  const results: { path: string; line: number; text: string }[] = [];
  let examined = 0;
  async function visit(file: string): Promise<void> {
    if (results.length >= args.maxResults) return;
    if (++examined > 2000) throw unprocessable("Search scan limit reached; narrow the path");
    await contained(file);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(file)) {
        if ([".git", "node_modules", ".venv"].includes(entry)) continue;
        if ([...excluded].some(foreign => within(foreign, path.join(file, entry)))) continue;
        await visit(path.join(file, entry));
        if (results.length >= args.maxResults) break;
      }
    } else if (stat.isFile() && stat.size <= 512 * 1024) {
      let content: string;
      try { content = await text(file); }
      catch (error) { if (error instanceof Error && error.message === "Binary content is not supported by this text reader") return; throw error; }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && results.length < args.maxResults; i++) {
        if (lines[i]!.includes(args.text)) results.push({ path: path.relative(root, file), line: i + 1, text: lines[i]!.slice(0, 2000) });
      }
    }
  }
  await visit(start);
  return { results, limitReached: results.length === args.maxResults, examined };
}
