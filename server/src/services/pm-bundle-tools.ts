import { pmInstructionLayout, requiredPmBundleFiles, type PmInstructionLayoutVersion } from "@paperclipai/shared";
import { and, eq, desc } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";
import { z } from "zod";
import { forbidden, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { agentFileStore } from "./agent-file-store.js";
import { agentInstructionWorkingCopyService } from "./agent-instruction-working-copies.js";
import { authorizeInstructionRead } from "./agent-instruction-authorization.js";
import { assertPmRun, type PmCoordinationScope } from "./pm-coordination-policy.js";

function bundleSchemas(version?: PmInstructionLayoutVersion) {
  const layout = pmInstructionLayout({ pmInstructionLayout: version });
  const path = z.enum(layout.files);
  return { layout, read: z.object({ path }).strict(), write: z.object({ path, content: z.string().max(1024 * 1024),
    baseHash: z.string().regex(/^[a-f0-9]{64}$/), changeReason: z.string().trim().min(1).max(2000) }).strict() };
}

export function pmBundleTools(version?: PmInstructionLayoutVersion) {
  const { layout, read, write } = bundleSchemas(version);
  return [
    { name: "read_bundle_file", description: `Read a file from your current AGENT_HOME and record this run's read receipt. ${layout.readGuidance} Returned hashes are save preconditions.`, inputSchema: z.toJSONSchema(read) },
    { name: "write_bundle_file", description: `Save your own support files (${layout.editableFiles.join(", ")}) with the last read baseHash and a changeReason. The role entry and managed worker table are protected. Check saved and workingCopySynchronized; on a conflict re-read before deciding your next change.`, inputSchema: z.toJSONSchema(write) },
  ];
}

export async function readPmBundleFile(db: Db, scope: PmCoordinationScope, runId: string, input: unknown) {
  const { path } = bundleSchemas(scope.instructionLayout).read.parse(input);
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
  const required = requiredPmBundleFiles(scope.instructionLayout, operation);
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
  const args = bundleSchemas(scope.instructionLayout).write.parse(input);
  if (!bundleSchemas(scope.instructionLayout).layout.editableFiles.includes(args.path)) throw forbidden("The PM role entry is Owner-managed", { code: "PM_BUNDLE_DENIED" });
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
