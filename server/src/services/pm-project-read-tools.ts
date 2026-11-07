import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";
import { assertPmRun, type PmCoordinationScope } from "./pm-coordination-policy.js";

const read = z.object({ path: z.string().min(1).max(4096), startLine: z.number().int().min(1).default(1),
  maxLines: z.number().int().min(1).max(500).default(200) }).strict();
const search = z.object({ text: z.string().min(1).max(500), path: z.string().max(4096).default("."),
  maxResults: z.number().int().min(1).max(100).default(50) }).strict();
export const PM_PROJECT_READ_TOOLS = [
  { name: "read_project_file", description: "Read a bounded text file within your assigned project repository. Paths are relative to the PM project root. This cannot execute commands or read outside your project.", inputSchema: z.toJSONSchema(read) },
  { name: "search_project_files", description: "Search for literal text within your assigned project repository, with bounded results. Symlinks, binary files, Git metadata and dependencies are excluded. Narrow the path when the scan limit is reached.", inputSchema: z.toJSONSchema(search) },
];

export async function executePmProjectRead(db: Db, scope: PmCoordinationScope, runId: string, name: string, input: unknown) {
  await assertPmRun(db, scope, runId);
  const root = await fs.realpath(scope.workerRoot);
  async function contained(relative: string) {
    const candidate = await fs.realpath(path.resolve(root, relative));
    const rel = path.relative(root, candidate);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw forbidden("The requested path is outside this PM's project");
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
    const args = read.parse(input), file = await contained(args.path);
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
