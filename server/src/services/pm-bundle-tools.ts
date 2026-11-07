import { and, eq, desc } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";
import { z } from "zod";
import { forbidden, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { agentFileStore } from "./agent-file-store.js";
import { agentInstructionWorkingCopyService } from "./agent-instruction-working-copies.js";
import { authorizeInstructionRead } from "./agent-instruction-authorization.js";
import { PM_BUNDLE_FILES, PM_EDITABLE_BUNDLE_FILES, assertPmRun, type PmCoordinationScope } from "./pm-coordination-policy.js";

const readSchema = z.object({ path: z.enum(PM_BUNDLE_FILES) }).strict();
const writeSchema = z.object({ path: z.enum(PM_BUNDLE_FILES), content: z.string().max(1024 * 1024),
  baseHash: z.string().regex(/^[a-f0-9]{64}$/), changeReason: z.string().trim().min(1).max(2000) }).strict();
export const PM_BUNDLE_TOOLS = [
  { name: "read_bundle_file", description: "Read a required file from your current AGENT_HOME, synchronize its saved version and record this run's read receipt. Read AGENTS.md, PROJECT.md and memory/handoff.md every run; WORKERS.md and REVIEW.md before dispatch; REVIEW.md before review. Returned hashes are save preconditions.", inputSchema: z.toJSONSchema(readSchema) },
  { name: "write_bundle_file", description: "Save one of your own workflow or memory support files with its last read baseHash and a changeReason. AGENTS.md, model authorization, worker identity and Owner gates stay protected. Inspect the save and working-copy receipts; never replay an uncertain save blindly.", inputSchema: z.toJSONSchema(writeSchema) },
];

export async function readPmBundleFile(db: Db, scope: PmCoordinationScope, runId: string, input: unknown) {
  const { path } = readSchema.parse(input);
  await assertPmRun(db, scope, runId);
  const agent = await agentService(db).getById(scope.agentId);
  if (!agent || agent.companyId !== scope.companyId) throw forbidden("PM identity is unavailable");
  const bound = await authorizeInstructionRead(db, { type: "agent", source: "agent_jwt", ...scope, runId }, agent);
  const file = await agentInstructionsService().readFile(agent, path);
  if (typeof file.content !== "string" || !file.contentHash) throw unprocessable("Required PM bundle file is unavailable");
  await agentInstructionWorkingCopyService(db).synchronizePmFile({ ...scope, runId, path, content: file.content });
  await db.insert(activityLog).values({ companyId: scope.companyId, actorType: "agent", actorId: scope.agentId,
    agentId: scope.agentId, runId, responsibleUserId: bound.onBehalfOfUserId,
    action: "pm.bundle_read", entityType: "agent", entityId: scope.agentId, details: { path, contentHash: file.contentHash } });
  return file;
}

export async function requirePmBundleReads(db: Db, scope: PmCoordinationScope, runId: string, operation: string) {
  await assertPmRun(db, scope, runId);
  const required = ["AGENTS.md", "PROJECT.md", "memory/handoff.md"];
  if (["create_task", "reassign_task", "dispatch"].includes(operation)) required.push("WORKERS.md", "REVIEW.md");
  else if (["resolve_review", "request_review", "review"].includes(operation)) required.push("REVIEW.md");
  const reads = await db.select({ details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, scope.companyId), eq(activityLog.agentId, scope.agentId), eq(activityLog.runId, runId),
    eq(activityLog.action, "pm.bundle_read"))).orderBy(desc(activityLog.createdAt)).limit(200);
  const agent = await agentService(db).getById(scope.agentId);
  if (!agent) throw forbidden("PM identity is unavailable");
  const files = await Promise.all(required.map(path => agentInstructionsService().readFile(agent, path)));
  const missing = required.filter(path => {
    const hash = files[required.indexOf(path)]?.contentHash;
    return !hash || !reads.some(row => row.details?.path === path && row.details?.contentHash === hash);
  });
  if (missing.length) throw unprocessable(`Read the current bundle files with read_bundle_file before ${operation}: ${missing.join(", ")}`, { code: "PM_BUNDLE_READ_REQUIRED", paths: missing });
}

export async function writePmBundleFile(db: Db, scope: PmCoordinationScope, runId: string, input: unknown) {
  const args = writeSchema.parse(input);
  if (!PM_EDITABLE_BUNDLE_FILES.has(args.path)) throw forbidden("The PM role entry is Owner-managed", { code: "PM_BUNDLE_DENIED" });
  await requirePmBundleReads(db, scope, runId, "write_bundle_file");
  const receipt = await agentFileStore(db).write({ ...scope, ...args, bytes: Buffer.from(args.content), ownWorkflow: true },
    { type: "agent", source: "agent_jwt", ...scope, runId });
  try {
    await agentInstructionWorkingCopyService(db).synchronizePmFile({ ...scope, runId, path: args.path, content: args.content });
  } catch (error) {
    // The canonical save is durable. Preserve that fact, including partial failure.
    return { ...receipt, saved: true, workingCopySynchronized: false,
      error: error instanceof Error ? error.message : "Working copy synchronization failed. Re-read this file before continuing." };
  }
  return { ...receipt, saved: true, workingCopySynchronized: true };
}
