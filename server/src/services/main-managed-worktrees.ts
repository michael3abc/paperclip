import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hostname } from "node:os";
import { and, eq, inArray, isNull, not, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { managedWorktreeOperationSchema } from "@paperclipai/shared";
import { agents, environmentLeases, executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces,
  workspaceOperations, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import { MAIN_MANAGED_WORKTREE_KEY, MAIN_MANAGED_WORKTREE_SCHEMA, isMainManagedExecutionWorkspace,
  readMainManagedWorktree, type MainManagedWorktree } from "@paperclipai/shared";
import { managedWorktreeHostOperation, type ManagedWorktreeHostInput, type ManagedWorktreeHostResult } from "@paperclipai/adapter-utils/managed-worktree-host";
import { forbidden, conflict, notFound } from "../errors.js";
import { resolvePaperclipConfigPath } from "../paths.js";
import { assertAgentRunWriteAllowed, agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { accessService } from "./access.js";
import { type AuthorizationActor, canActorReadExecutionWorkspace } from "./authorization.js";
import { withExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { mainAgentProjectId } from "./main-agent-workers.js";
import { TERMINAL_RUN_STATUSES, unsettledWorkspaceHolders } from "./heartbeat/shared-checkout.js";
import { logActivity } from "./activity-log.js";
import { assertTaskWorkspaceExecutionAccess } from "./task-workspace-access.js";
import { executionWorkspaceRepositoryService } from "./execution-workspace-repositories.js";

type Operation = z.infer<typeof managedWorktreeOperationSchema>;
type Workspace = typeof executionWorkspaces.$inferSelect;
type Scope = { companyId: string; projectId: string; workspaceId: string; actor: AuthorizationActor };
type Host = (hostId: string | null, input: ManagedWorktreeHostInput) => Promise<ManagedWorktreeHostResult>;
const generation = (row: Workspace) => Number.isSafeInteger(row.metadata?.lifecycleGeneration) ? Number(row.metadata!.lifecycleGeneration) : 0;
const fail = (code: string): never => { throw conflict(code, { code }); };
const inside = (root: string, cwd: string) => {
  const relative = path.posix.relative(root, cwd);
  return relative === "" || (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative));
};

export function mainManagedWorktreeService(db: Db, options: { host?: Host; receiptRoot?: string } = {}) {
  const receiptRoot = options.receiptRoot ?? path.join(path.dirname(resolvePaperclipConfigPath()), "worktree-operations");
  const host: Host = options.host ?? (async (hostId, input) => {
    if (hostId) {
      const { getServerAdapter } = await import("../adapters/registry.js");
      const adapter = getServerAdapter("ccpocket_bridge");
      if (!adapter.managedWorktreeOperation) fail("worktree_host_capability_unavailable");
      return adapter.managedWorktreeOperation!({ hostId, operation: input });
    }
    await fs.mkdir(receiptRoot, { recursive: true, mode: 0o700 });
    return managedWorktreeHostOperation(input);
  });
  const load = async (connection: Db, scope: Scope) => {
    const [row] = await connection.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.id, scope.workspaceId), eq(executionWorkspaces.companyId, scope.companyId), eq(executionWorkspaces.projectId, scope.projectId),
    ));
    return row;
  };
  async function authorize(connection: Db, scope: Scope, participantIssueId?: string) {
    const { actor, companyId, projectId } = scope;
    const read = await accessService(connection).decide({ actor, action: "project:read", resource: { type: "project", companyId, projectId } });
    if (!read.allowed) throw forbidden("Project is outside this actor's authorization boundary");
    const [project] = await connection.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)));
    if (!project || project.archivedAt) throw notFound("Project not found");
    if (actor.type === "board") {
      const manage = await accessService(connection).decide({ actor, action: "runtime:manage", resource: { type: "company", companyId } });
      if (!manage.allowed) throw forbidden("Workspace management requires human runtime-management permission");
    } else {
      if (actor.type !== "agent" || actor.source !== "agent_jwt" || !actor.agentId || !actor.runId
        || (actor.keyScope && actor.keyScope.kind !== "standard")) throw forbidden("Workspace management requires a current run-bound token");
      await assertAgentRunWriteAllowed(connection, companyId, actor);
      const [run] = await connection.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId),
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actor.agentId), eq(heartbeatRuns.status, "running")));
      const [agent] = await connection.select().from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId)));
      if (!run || !agent || agent.lifecycleState !== "ready" || agent.lifecycleHolds.length || !["idle", "running"].includes(agent.status)
        || project.pausedAt) throw forbidden("Agent or project is held or no longer running");
      const projectMain = project.leadAgentId === agent.id && mainAgentProjectId(agent) === project.id;
      if (participantIssueId && !projectMain) {
        const [issue] = await connection.select().from(issues).where(and(eq(issues.id, participantIssueId), eq(issues.companyId, companyId), eq(issues.projectId, projectId)));
        const runIssueId = run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId;
        if (!issue || ["done", "cancelled"].includes(issue.status) || issue.assigneeAgentId !== actor.agentId || runIssueId !== issue.id)
          throw forbidden("Only the current assignee may join or leave its task");
      } else if (!participantIssueId && !projectMain) {
        throw forbidden("Only the project's current main may manage worktrees");
      }
    }
    return project;
  }
  async function audit(connection: Db, scope: Scope, operation: Operation, phase: string, currentGeneration: number) {
    await logActivity(connection, { companyId: scope.companyId, actorType: scope.actor.type === "agent" ? "agent" : "user",
      actorId: scope.actor.agentId ?? scope.actor.userId ?? "local-board", agentId: scope.actor.agentId, runId: scope.actor.runId,
      action: "workspace.lifecycle." + operation.action, entityType: "execution_workspace", entityId: scope.workspaceId,
      details: { operationId: operation.operationId, phase, generation: currentGeneration } });
  }
  async function assertLegacyRemoteAdoptionIdle(connection: Db, row: Workspace) {
    const [active] = await connection.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, row.companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      or(sql`${heartbeatRuns.contextSnapshot}->>'executionWorkspaceId' = ${row.id}`,
        sql`exists (select 1 from ${issues} linked where linked.company_id = ${row.companyId}
          and (linked.execution_workspace_id = ${row.id} or linked.id = ${row.sourceIssueId})
          and (${heartbeatRuns.id} in (linked.checkout_run_id, linked.execution_run_id)
            or ${heartbeatRuns.issueId} = linked.id or ${heartbeatRuns.nativeIssueId} = linked.id
            or ${heartbeatRuns.contextSnapshot}->>'issueId' = linked.id::text
            or ${heartbeatRuns.contextSnapshot}->>'taskId' = linked.id::text))`),
    )).limit(1);
    if (active) fail("worktree_registration_active_run");
  }
  /** Liveness-first rule 2: a terminal participant run is enough. Stop evidence,
   * cleanup receipts and leases of terminal runs never block retirement. Live
   * work (a non-terminal run, its unreleased lease, a running service) still does,
   * and the host retire itself never force-removes or deletes dirty/ignored files. */
  async function assertRetirable(row: Workspace, managed: MainManagedWorktree) {
    const participants = Object.values(managed.participants);
    if (participants.some(value => !value.runId)) fail("retire_blocked_participants");
    const runIds = participants.flatMap(value => value.runId ? [value.runId] : []);
    if (runIds.length) {
      const runs = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, row.companyId), inArray(heartbeatRuns.id, runIds)));
      if (runs.length !== new Set(runIds).size) fail("retire_blocked_unknown_live");
      if (runs.some(run => !(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status))) fail("retire_blocked_participants");
    }
    const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, environmentLeases.heartbeatRunId)).where(and(
        eq(environmentLeases.companyId, row.companyId), eq(environmentLeases.executionWorkspaceId, row.id),
        isNull(environmentLeases.releasedAt), not(inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES])),
      )).limit(1);
    const [service] = await db.select({ id: workspaceRuntimeServices.id }).from(workspaceRuntimeServices).where(and(
      eq(workspaceRuntimeServices.companyId, row.companyId), eq(workspaceRuntimeServices.executionWorkspaceId, row.id),
      not(inArray(workspaceRuntimeServices.status, ["stopped", "failed"])),
    )).limit(1);
    if (lease || service) fail("retire_blocked_live_resource");
    // Only non-terminal runs in this tree are holders (shared-checkout settled == terminal).
    const holders = await unsettledWorkspaceHolders(db, { host: managed.hostId ? "ccpocket:" + managed.hostId : hostname(),
      path: row.cwd!, remote: managed.hostId !== null, first: true });
    if (holders.length) fail("retire_blocked_unknown_live");
    const [source] = await db.select({ id: projectWorkspaces.id }).from(projectWorkspaces).where(eq(projectWorkspaces.cwd, row.cwd!)).limit(1);
    const [resident] = await db.select({ id: agents.id }).from(agents).where(eq(sql.raw("adapter_config->>'cwd'"), row.cwd)).limit(1);
    if (source || resident) fail("retire_blocked_protected_directory");
  }
  async function completeHostOperation(scope: Scope, row: Workspace, operation: Operation, digest: string,
    hostInput: ManagedWorktreeHostInput, result: ManagedWorktreeHostResult) {
    const managed = readMainManagedWorktree(row.metadata)!;
    if (result.schema !== "paperclip.managed-worktree-host.v1" || result.operationId !== operation.operationId
      || result.cwd !== row.cwd || result.action !== hostInput.action || result.branch !== managed.branch) fail("worktree_host_receipt_mismatch");
    if (operation.action === "merge" && !result.merged) fail("worktree_merge_not_observed");
    if (operation.action === "retire" && !result.retired) fail("worktree_retire_not_observed");
    return db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const current = await load(tx, scope), marker = readMainManagedWorktree(current?.metadata);
      if (!current || generation(current) !== generation(row) || marker?.pendingOperationId !== operation.operationId) fail("worktree_generation_conflict");
      const [savedOperation] = await tx.select().from(workspaceOperations).where(and(
        eq(workspaceOperations.id, operation.operationId), eq(workspaceOperations.companyId, scope.companyId),
        eq(workspaceOperations.executionWorkspaceId, row.id), eq(workspaceOperations.phase, "main_managed_worktree"),
      ));
      const normalizeRemoteProvider = savedOperation?.metadata?.normalizeLegacyRemoteProvider === true;
      if (normalizeRemoteProvider) {
        const [source] = await tx.select().from(projectWorkspaces).where(and(
          eq(projectWorkspaces.id, current!.projectWorkspaceId!), eq(projectWorkspaces.companyId, scope.companyId),
          eq(projectWorkspaces.projectId, scope.projectId),
        )).for("update");
        if (operation.action !== "register" || hostInput.action !== "inspect" || savedOperation.metadata?.digest !== digest
          || current!.providerType !== "local_fs" || current!.strategyType !== "project_primary" || current!.providerRef !== null
          || current!.projectWorkspaceId !== row.projectWorkspaceId || current!.cwd !== row.cwd
          || current!.sourceIssueId !== row.sourceIssueId || current!.closedAt || ["archived", "cleanup_failed"].includes(current!.status)
          || source?.sourceType !== "remote_managed" || source.cwd !== hostInput.sourceCwd || source.cwd !== current!.cwd
          || source.metadata?.hostId !== managed.hostId || !managed.hostId
          || (current!.metadata?.hostId != null && current!.metadata.hostId !== managed.hostId)) fail("worktree_registration_coordinates_conflict");
        await assertLegacyRemoteAdoptionIdle(tx, current!);
      }
      const phase = operation.action === "retire" ? "retired" : operation.action === "merge" ? "merged" : "open";
      const receipt = { workspaceId: row.id, operationId: operation.operationId, phase, generation: generation(row), host: result };
      await tx.update(executionWorkspaces).set({ metadata: { ...current!.metadata, [MAIN_MANAGED_WORKTREE_KEY]: {
        ...marker, phase, pendingOperationId: null, lastReceipt: { operationId: operation.operationId, head: result.head, targetHead: result.targetHead },
      } }, ...(normalizeRemoteProvider ? { providerType: "remote_managed" } : {}),
        ...(phase === "retired" ? { status: "archived", closedAt: new Date() } : {}), updatedAt: new Date() }).where(eq(executionWorkspaces.id, row.id));
      await tx.update(workspaceOperations).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date(),
        metadata: { ...savedOperation?.metadata, digest, action: operation.action, generation: generation(row), hostInput, receipt } }).where(eq(workspaceOperations.id, operation.operationId));
      await audit(tx, scope, operation, phase, generation(row));
      return receipt;
    });
  }
  async function recordFailure(scope: Scope, row: Workspace, operationId: string, error: unknown, noEffect: boolean) {
    return db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await tx.update(workspaceOperations).set({ status: "failed", finishedAt: new Date(), updatedAt: new Date(),
        stderrExcerpt: error instanceof Error ? error.message.slice(0, 200) : "worktree_operation_failed" }).where(eq(workspaceOperations.id, operationId));
      if (noEffect) {
        const current = await load(tx, scope), managed = readMainManagedWorktree(current?.metadata);
        if (!current || generation(current) !== generation(row) || managed?.pendingOperationId !== operationId) fail("worktree_generation_conflict");
        await tx.update(executionWorkspaces).set({ metadata: { ...current!.metadata,
          [MAIN_MANAGED_WORKTREE_KEY]: { ...managed, pendingOperationId: null } }, updatedAt: new Date() }).where(eq(executionWorkspaces.id, row.id));
      }
    });
  }
  return {
    // Internal dispatch boundary: no helper credential exists yet. Authorize the
    // persisted task selection and current run, not a caller-supplied main grant.
    prepareRun: async (scope: Scope, issueId: string, expectedGeneration: number) =>
      withExecutionWorkspaceLifecycleLock(db, scope.workspaceId, async () => {
        const row = await load(db, scope), managed = readMainManagedWorktree(row?.metadata);
        if (!row || !managed) fail("worktree_marker_unrecognized");
        if (generation(row!) !== expectedGeneration) fail("worktree_generation_conflict");
        if (managed!.phase !== "open") fail("workspace_converging");
        if (managed!.pendingOperationId) fail("worktree_operation_reconciliation_required");
        const authorizeRun = async (connection: Db) => {
          await assertTaskWorkspaceExecutionAccess(connection, scope.actor, scope.companyId, { issueId, workspaceId: scope.workspaceId });
          const [run] = await connection.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, scope.actor.runId!), eq(heartbeatRuns.companyId, scope.companyId),
            eq(heartbeatRuns.agentId, scope.actor.agentId!), eq(heartbeatRuns.status, "running"),
          )).for("update");
          const [agent] = await connection.select().from(agents).where(and(eq(agents.id, scope.actor.agentId!), eq(agents.companyId, scope.companyId)));
          const [project] = await connection.select().from(projects).where(and(eq(projects.id, scope.projectId), eq(projects.companyId, scope.companyId)));
          // A main's own Agent Chat has no project; it may run in its project's tree (Owner 2026-11-14).
          const [issue] = await connection.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, scope.companyId),
            or(eq(issues.projectId, scope.projectId), and(isNull(issues.projectId), eq(issues.conversationAgentId, scope.actor.agentId!)))));
          if (!run || agentRunWritesRevoked(run) || !agent || agent.lifecycleState !== "ready" || agent.lifecycleHolds.length
            || agent.pauseReason || !(await evaluateAgentInvokabilityFromDb(connection, agent)).invokable
            || !project || project.pausedAt || project.archivedAt
            || !issue || ["done", "cancelled"].includes(issue.status)) fail("worktree_run_no_longer_admitted");
          return run;
        };
        const admittedRun = await db.transaction(tx => authorizeRun(tx as unknown as Db));
        // Sharing a tree skips provisioning, never repository authorization.
        // This read-only check cannot switch branches or repair another writer.
        await executionWorkspaceRepositoryService(db).assertRegisteredRepositoryAccess({ companyId: scope.companyId,
          issueId, workspaceId: scope.workspaceId, cwd: row.cwd!, agentId: admittedRun.agentId, runId: admittedRun.id,
          responsibleUserId: admittedRun.responsibleUserId });
        const observed = await host(managed!.hostId, { action: "inspect", operationId: scope.actor.runId!,
          kind: managed!.kind,
          cwd: row!.cwd!, sourceCwd: managed!.sourceCwd, parentDir: managed!.parentDir,
          branch: managed!.branch, targetBranch: managed!.targetBranch, receiptRoot });
        if (observed.schema !== "paperclip.managed-worktree-host.v1" || observed.action !== "inspect"
          || observed.operationId !== scope.actor.runId || observed.cwd !== row!.cwd || observed.branch !== managed!.branch) fail("worktree_host_receipt_mismatch");
        return db.transaction(async transaction => {
          const tx = transaction as unknown as Db;
          const run = await authorizeRun(tx);
          const current = await load(tx, scope), marker = readMainManagedWorktree(current?.metadata);
          if (!current || generation(current) !== expectedGeneration || marker?.phase !== "open" || marker.pendingOperationId) fail("worktree_generation_conflict");
          const participant = { issueId, agentId: run.agentId, runId: run.id, joinedAt: new Date().toISOString() };
          const [updated] = await tx.update(executionWorkspaces).set({ metadata: { ...current!.metadata,
            [MAIN_MANAGED_WORKTREE_KEY]: { ...marker, participants: { ...marker!.participants, [run.id]: participant } },
          }, lastUsedAt: new Date(), updatedAt: new Date() }).where(eq(executionWorkspaces.id, scope.workspaceId)).returning();
          return { workspace: updated!, generation: expectedGeneration, observed };
        });
      }, { lockTimeoutMs: 30_000 }),
    inspect: async (scope: Scope) => {
      if (!await canActorReadExecutionWorkspace(db, scope.actor, scope.workspaceId)) throw notFound("Execution workspace not found");
      const row = await load(db, scope); if (!row) throw notFound("Execution workspace not found");
      const managed = readMainManagedWorktree(row.metadata); if (!managed) fail("worktree_marker_unrecognized");
      const operations = await db.select().from(workspaceOperations).where(and(
        eq(workspaceOperations.companyId, scope.companyId), eq(workspaceOperations.executionWorkspaceId, row.id), eq(workspaceOperations.phase, "main_managed_worktree"),
      ));
      // Host exclusion coordinates may belong to unreadable foreign projects.
      const visibleOperations = operations.map(operation => {
        const input = operation.metadata?.hostInput as Record<string, unknown> | undefined;
        if (!input) return operation;
        const { excludedRoots: _excludedRoots, ...visibleInput } = input;
        return { ...operation, metadata: { ...operation.metadata, hostInput: visibleInput } };
      });
      return { workspace: row, generation: generation(row), managed, operations: visibleOperations };
    },
    recheck: async (scope: Scope, operationId: string, expectedGeneration: number) =>
      withExecutionWorkspaceLifecycleLock(db, scope.workspaceId, async () => {
        await db.transaction(tx => authorize(tx as unknown as Db, scope));
        const row = await load(db, scope), managed = readMainManagedWorktree(row?.metadata);
        if (!row || !managed || generation(row) !== expectedGeneration) fail("worktree_generation_conflict");
        const [saved] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.id, operationId),
          eq(workspaceOperations.companyId, scope.companyId), eq(workspaceOperations.executionWorkspaceId, scope.workspaceId),
          eq(workspaceOperations.phase, "main_managed_worktree")));
        if (!saved) throw notFound("Worktree operation not found");
        if (saved.status === "succeeded") return saved.metadata?.receipt;
        if (managed!.pendingOperationId !== operationId) return { operationId, status: "failed", pending: false };
        const original = saved.metadata?.hostInput as ManagedWorktreeHostInput | undefined;
        if (!original || original.operationId !== operationId) fail("worktree_operation_receipt_missing");
        const action = saved.metadata?.action as Operation["action"];
        try {
          const result = await host(managed!.hostId, { ...original!, recheckOnly: true });
          return await completeHostOperation(scope, row!, { action, operationId, expectedGeneration },
            String(saved.metadata?.digest), original!, result);
        } catch (error) {
          const noEffect = (error as { worktreeEffectStarted?: unknown })?.worktreeEffectStarted === false || original!.action === "inspect";
          await recordFailure(scope, row!, operationId, error, noEffect);
          throw error;
        }
      }, { lockTimeoutMs: 30_000 }),
    operate: async (scope: Scope, raw: Operation) => {
      const operation = managedWorktreeOperationSchema.parse(raw);
      if (["create", "merge"].includes(operation.action) && (!operation.expectedHead || !operation.expectedTargetHead))
        fail("worktree_expected_heads_required");
      return withExecutionWorkspaceLifecycleLock(db, scope.workspaceId, async lockTransaction => {
        const digest = createHash("sha256").update(JSON.stringify({ companyId: scope.companyId, projectId: scope.projectId,
          workspaceId: scope.workspaceId, actorId: scope.actor.agentId ?? scope.actor.userId ?? "local-board", operation })).digest("hex");
        // Commit intent before host I/O while the existing lifecycle lock excludes
        // legacy cleanup and other management operations. No run-wide writer lock.
        const prepared = await db.transaction(async transaction => {
          const tx = transaction as unknown as Db;
          const participant = operation.action === "join" || operation.action === "leave";
          if (participant && !operation.issueId) fail("worktree_participant_issue_required");
          const project = await authorize(tx, scope, participant ? operation.issueId : undefined);
          const [prior] = await tx.select().from(workspaceOperations).where(eq(workspaceOperations.id, operation.operationId));
          if (prior) {
            if (prior.companyId !== scope.companyId || prior.executionWorkspaceId !== scope.workspaceId || prior.metadata?.digest !== digest) fail("worktree_operation_conflict");
            if (prior.status !== "succeeded") fail("worktree_operation_reconciliation_required");
            return { replay: prior.metadata!.receipt, row: null, managed: null, hostInput: null };
          }
          let row = await load(tx, scope);
          if (row && generation(row) !== operation.expectedGeneration) fail("worktree_generation_conflict");
          let managed = readMainManagedWorktree(row?.metadata);
          let excludedRoots: string[] | undefined;
          let normalizeLegacyRemoteProvider = false;
          if (row && isMainManagedExecutionWorkspace(row) && !managed) fail("worktree_marker_unrecognized");
          if (managed?.pendingOperationId) fail("worktree_operation_reconciliation_required");
          if (["create", "register", "initialize"].includes(operation.action)) {
            if (managed?.lastReceipt || Object.keys(managed?.participants ?? {}).length || (!row && operation.expectedGeneration !== 0)) fail("worktree_already_registered");
            if (!operation.projectWorkspaceId || !operation.name || !operation.branch || !operation.targetBranch) fail("worktree_registration_required");
            const [source] = await tx.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.id, operation.projectWorkspaceId!),
              eq(projectWorkspaces.projectId, scope.projectId), eq(projectWorkspaces.companyId, scope.companyId)));
            const policy = parseProjectExecutionWorkspacePolicy(project.executionWorkspacePolicy);
            const configuredParent = policy?.workspaceStrategy?.worktreeParentDir;
            if (!source?.cwd || !path.posix.isAbsolute(source.cwd)) fail("worktree_source_configuration_required");
            const kind = operation.kind ?? "linked_worktree";
            if (operation.action === "create" && kind !== "linked_worktree") fail("repository_root_use_register_or_initialize");
            if (operation.action === "initialize" && kind !== "repository_root") fail("worktree_initialize_requires_repository_root");
            const parent = configuredParent ?? source!.cwd!;
            if (!path.posix.isAbsolute(parent) || path.posix.normalize(parent) !== parent) fail("worktree_parent_configuration_required");
            const sourceHost = source!.sourceType === "remote_managed" ? source!.metadata?.hostId : null;
            // A legacy Git source can already point at a local checkout. Keep
            // its source ID/type during adoption; the host still validates the
            // canonical Git root. A foreign host or remote manager is never
            // interpreted as a controller-local path merely because cwd exists.
            const localGitSource = source!.sourceType === "git_repo"
              && source!.remoteProvider == null && source!.remoteWorkspaceRef == null
              && (source!.metadata?.hostId == null || source!.metadata?.hostId === hostname());
            if ((!localGitSource && !["local_path", "remote_managed"].includes(source!.sourceType))
              || (source!.sourceType === "remote_managed" && (typeof sourceHost !== "string" || !sourceHost))) fail("worktree_host_capability_unavailable");
            const cwd = operation.cwd ?? (configuredParent ? path.posix.join(parent, operation.name!) : "");
            if (!cwd || !path.posix.isAbsolute(cwd) || path.posix.normalize(cwd) !== cwd
              || cwd.split("/").includes(".git")
              || (!inside(source!.cwd!, cwd) && !(configuredParent && inside(parent, cwd)))) fail("worktree_path_outside_parent");
            // A source grant never includes another project's registered nested
            // root. Host checks canonical aliases before touching Git.
            const sources = await tx.select({ cwd: projectWorkspaces.cwd, companyId: projectWorkspaces.companyId,
              projectId: projectWorkspaces.projectId, sourceType: projectWorkspaces.sourceType, metadata: projectWorkspaces.metadata }).from(projectWorkspaces);
            excludedRoots = sources.filter(other => other.cwd &&
              (other.companyId !== scope.companyId || other.projectId !== scope.projectId) &&
              (other.sourceType === "remote_managed" ? other.metadata?.hostId : null) === sourceHost &&
              // A broad same-company session/source parent does not own the
              // explicitly granted source below it. Foreign descendants do.
              !(other.companyId === scope.companyId && inside(other.cwd!, source!.cwd!)))
              .map(other => other.cwd!);
            if (excludedRoots.some(root => inside(root, cwd) || inside(cwd, root))) fail("worktree_foreign_project_path");
            const physicalKey = "managed-worktree-path:" + (sourceHost ?? hostname()) + ":" + cwd;
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${physicalKey}, 0))`);
            const duplicates = await tx.select({ id: executionWorkspaces.id, metadata: executionWorkspaces.metadata })
              .from(executionWorkspaces).where(and(eq(executionWorkspaces.cwd, cwd),
                sql`${executionWorkspaces.metadata} ? ${MAIN_MANAGED_WORKTREE_KEY}`));
            if (duplicates.some(other => other.id !== scope.workspaceId
              && (!readMainManagedWorktree(other.metadata) || readMainManagedWorktree(other.metadata)?.hostId === sourceHost))) fail("worktree_already_registered");
            // Old project-primary Bridge rows used the local provider label even
            // for an explicitly registered remote source. Only read-only register
            // may adopt that exact source; publish the provider correction after
            // its host has proved the Git identity, never during intent creation.
            normalizeLegacyRemoteProvider = Boolean(row && operation.action === "register" && sourceHost
              && row.providerType === "local_fs" && row.strategyType === "project_primary"
              && row.providerRef === null && row.cwd === source!.cwd
              && (row.metadata?.hostId == null || row.metadata.hostId === sourceHost));
            if (row && (row.cwd !== cwd || row.projectWorkspaceId !== source!.id
              || (row.branchName !== null && row.branchName !== operation.branch)
              || (sourceHost ? row.providerType !== "remote_managed" && !normalizeLegacyRemoteProvider : !["local_fs", "git_worktree"].includes(row.providerType))
              || row.closedAt || ["archived", "cleanup_failed"].includes(row.status))) fail("worktree_registration_coordinates_conflict");
            if (normalizeLegacyRemoteProvider) await assertLegacyRemoteAdoptionIdle(tx, row!);
            managed = { schema: MAIN_MANAGED_WORKTREE_SCHEMA, kind, phase: "converging", sourceCwd: source!.cwd!, parentDir: parent,
              branch: operation.branch!, targetBranch: operation.targetBranch!, hostId: sourceHost as string | null, participants: {}, pendingOperationId: null };
            if (!row) {
              [row] = await tx.insert(executionWorkspaces).values({ id: scope.workspaceId, companyId: scope.companyId,
                projectId: scope.projectId, projectWorkspaceId: source!.id, sourceIssueId: null, mode: "isolated_workspace",
                strategyType: "git_worktree", providerType: sourceHost ? "remote_managed" : "local_fs", name: operation.name!,
                cwd, branchName: operation.branch!, baseRef: operation.expectedHead ?? null, metadata: { lifecycleGeneration: 0 } }).returning();
            }
          }
          if (!row || !managed) fail("worktree_registration_required");
          if (managed!.phase === "retired") fail("worktree_retired");
          const next = { ...managed!, participants: { ...managed!.participants } };
          let hostAction: ManagedWorktreeHostInput["action"] | null = null;
          switch (operation.action) {
            case "create": hostAction = "create"; break;
            case "register": hostAction = "inspect"; break;
            case "initialize": hostAction = "initialize"; break;
            case "join": {
              if (next.phase !== "open") fail("workspace_converging");
              const [issue] = await tx.select().from(issues).where(and(eq(issues.id, operation.issueId!), eq(issues.companyId, scope.companyId), eq(issues.projectId, scope.projectId)));
              if (!issue?.assigneeAgentId || ["done", "cancelled"].includes(issue.status)) fail("worktree_participant_invalid");
              next.participants[issue!.id] = { issueId: issue!.id, agentId: issue!.assigneeAgentId!, runId: scope.actor.runId ?? null, joinedAt: new Date().toISOString() };
              break;
            }
            case "leave": {
              next.participants = Object.fromEntries(Object.entries(next.participants).filter(([, value]) => value.issueId !== operation.issueId));
              break;
            }
            case "set_default": {
              if (next.phase !== "open") fail("workspace_converging");
              await tx.update(projects).set({ executionWorkspacePolicy: { ...project.executionWorkspacePolicy,
                enabled: true, executionMode: "worktree", defaultExecutionWorkspaceId: row!.id }, updatedAt: new Date() })
                .where(and(eq(projects.id, scope.projectId), eq(projects.companyId, scope.companyId)));
              break;
            }
            case "converge": if (next.phase !== "open") fail("worktree_phase_conflict"); next.phase = "converging"; break;
            case "reopen":
              if (!next.lastReceipt) fail("worktree_registration_incomplete");
              if (next.phase === "open") fail("worktree_phase_conflict"); next.phase = "open"; break;
            case "merge":
              if (next.kind === "repository_root") fail("repository_root_metadata_lifecycle_only");
              if (!["converging", "merged"].includes(next.phase)) fail("worktree_must_converge"); hostAction = "merge"; break;
            case "retire":
              if (next.kind === "repository_root") {
                if (next.phase !== "converging") fail("worktree_must_converge");
                // Deregistration only: no Git merge, process kill, backup or
                // filesystem deletion is needed for an existing repository.
                next.phase = "retired";
              } else {
                if (next.phase !== "merged") fail("worktree_not_merged");
                if (!operation.expectedHead || !operation.expectedTargetHead) fail("worktree_expected_heads_required");
                hostAction = "retire";
              }
              break;
          }
          const nextGeneration = generation(row!) + (participant ? 0 : 1);
          if (hostAction) next.pendingOperationId = operation.operationId;
          const hostInput: ManagedWorktreeHostInput | null = hostAction ? { action: hostAction, kind: next.kind, excludedRoots, sourceCwd: next.sourceCwd,
            cwd: row!.cwd!, parentDir: next.parentDir, branch: next.branch, targetBranch: next.targetBranch, operationId: operation.operationId,
            receiptRoot, expectedHead: operation.expectedHead, expectedTargetHead: operation.expectedTargetHead } : null;
          const receipt = { workspaceId: row!.id, operationId: operation.operationId, phase: next.phase, generation: nextGeneration,
            ...(operation.action === "retire" && next.kind === "repository_root" ? { filesystemEffect: "none" } : {}) };
          const [saved] = await tx.update(executionWorkspaces).set({ metadata: { ...row!.metadata, lifecycleGeneration: nextGeneration,
            [MAIN_MANAGED_WORKTREE_KEY]: next }, branchName: next.branch, cleanupEligibleAt: null, cleanupReason: null,
            ...(next.phase === "retired" ? { status: "archived" as const, closedAt: new Date() } : {}),
            updatedAt: new Date() }).where(eq(executionWorkspaces.id, row!.id)).returning();
          await tx.insert(workspaceOperations).values({ id: operation.operationId, companyId: scope.companyId, executionWorkspaceId: row!.id,
            heartbeatRunId: scope.actor.runId, issueId: operation.issueId, phase: "main_managed_worktree", status: hostAction ? "running" : "succeeded",
            finishedAt: hostAction ? null : new Date(), metadata: { digest, action: operation.action, generation: nextGeneration, hostInput, receipt,
              ...(normalizeLegacyRemoteProvider ? { normalizeLegacyRemoteProvider: true } : {}) } });
          await audit(tx, scope, operation, next.phase, nextGeneration);
          return { replay: hostAction ? null : receipt, row: saved!, managed: next, hostInput };
        });
        if (prepared.replay) return prepared.replay;
        const row = prepared.row!, managed = prepared.managed!, hostInput = prepared.hostInput!;
        let enteredHost = false;
        try {
          const targetKey = "managed-worktree-target:" + (managed.hostId ?? hostname()) + ":" + managed.sourceCwd + ":" + managed.targetBranch;
          const [targetLock] = await lockTransaction.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${targetKey}, 0)) as acquired`);
          if (!targetLock?.acquired) fail("worktree_target_busy");
          if (operation.action === "retire") await assertRetirable(row, managed);
          enteredHost = true;
          const result = await host(managed.hostId, hostInput);
          return await completeHostOperation(scope, row, operation, digest, hostInput, result);
        } catch (error) {
          const noEffect = !enteredHost || hostInput.action === "inspect" || (error as { worktreeEffectStarted?: unknown })?.worktreeEffectStarted === false;
          await recordFailure(scope, row, operation.operationId, error, noEffect);
          throw error;
        }
      }, { lockTimeoutMs: 30_000 });
    },
  };
}
