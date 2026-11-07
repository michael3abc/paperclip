import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, companies, companyMemberships, heartbeatRuns, issues, principalPermissionGrants, type Db } from "@paperclipai/db";
import {
  DECISION_DELEGATION_PERMISSION, delegatedDecisionScopeSchema,
  type DecisionDelegationScope, type DelegatedDecisionContext,
  type HumanReservedDecisionReason,
} from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { pmCoordinationScope } from "./pm-coordination-policy.js";
import { persistActivity, publishActivity } from "./activity-log.js";

export type ActiveDecisionDelegation = {
  id: string; companyId: string; agentId: string; ownerUserId: string;
  scope: DecisionDelegationScope;
};

export function decisionFingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input !== null && typeof input === "object"
      ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
      : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** A request may add a restriction; omission can never remove a platform gate. */
export function approvalReservedReasons(type: string, payload: Record<string, unknown>): HumanReservedDecisionReason[] {
  const reasons = new Set<HumanReservedDecisionReason>();
  if (payload.humanOnly === true || payload.ownerOnly === true || payload.resolverPolicy === "human_only") reasons.add("explicit_human");
  if (payload.sensitiveDataExport === true) reasons.add("sensitive_data_export");
  if (payload.irreversible === true || payload.destructive === true) reasons.add("major_irreversible_destruction");
  // These are capability-bearing fields consumed by platform operations, not a
  // model's assertion that an operation is low risk.
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["permissionKey", "permissions", "grants", "membershipRole", "toolPolicy", "accessPolicy", "secretProposal", "securityPolicy"].includes(key)) reasons.add("account_security_expansion");
      if (["decisionDelegation", "delegateAgentId", "delegationScope"].includes(key)) reasons.add("delegation_change");
      visit(child);
    }
  };
  visit(payload);
  if (!["hire_agent", "approve_ceo_strategy", "budget_override_required", "request_board_approval"].includes(type)) reasons.add("explicit_human");
  return [...reasons];
}

export async function assertDecisionDelegationOwner(db: Db, companyId: string, userId: string) {
  const [membership] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
    eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"),
    eq(companyMemberships.membershipRole, "owner"),
  )).limit(1);
  if (!membership) throw forbidden("Only the human company Owner may change decision delegation");
}

export async function readDecisionDelegation(db: Db, companyId: string, options: { includeDisabled?: boolean; lock?: boolean } = {}): Promise<ActiveDecisionDelegation | null> {
  const query = db.select().from(principalPermissionGrants).where(and(
    eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.permissionKey, DECISION_DELEGATION_PERMISSION),
  ));
  const rows = await (options.lock ? query.for("share") : query);
  if (!rows.length) return null;
  if (rows.length !== 1) throw conflict("Ambiguous company decision delegation");
  const row = rows[0]!;
  const parsed = delegatedDecisionScopeSchema.safeParse(row.scope);
  if (!parsed.success || row.principalType !== "agent" || !row.grantedByUserId) throw forbidden("Invalid Owner decision delegation");
  if (!options.includeDisabled && (!parsed.data.enabled || Date.parse(parsed.data.activatedAt) > Date.now())) return null;
  await assertDecisionDelegationOwner(db, companyId, row.grantedByUserId);
  const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, row.principalId), eq(agents.companyId, companyId))).limit(1);
  if (!agent) throw conflict("The delegated agent is unavailable; the request remains pending");
  return { id: row.id, companyId, agentId: row.principalId, ownerUserId: row.grantedByUserId, scope: parsed.data };
}

export async function saveDecisionDelegation(db: Db, input: {
  companyId: string; ownerUserId: string; agentId: string; baseRevision: string | null;
  enabled: boolean; allowSelfApproval: boolean; scopes: DecisionDelegationScope["scopes"];
  reason?: string;
}) {
  let publication: Parameters<typeof publishActivity>[0] | undefined;
  const result = await db.transaction(async tx => {
    const database = tx as unknown as Db;
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, input.companyId)).for("update");
    await assertDecisionDelegationOwner(database, input.companyId, input.ownerUserId);
    const rows = await tx.select().from(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.companyId, input.companyId), eq(principalPermissionGrants.permissionKey, DECISION_DELEGATION_PERMISSION),
    )).for("update");
    if (rows.length > 1) throw conflict("Ambiguous company decision delegation");
    const previous = rows[0];
    const oldScope = previous ? delegatedDecisionScopeSchema.parse(previous.scope) : null;
    if ((oldScope?.revision ?? null) !== input.baseRevision) throw conflict("Decision delegation changed; reload its current revision");
    if (previous?.grantedByUserId && previous.grantedByUserId !== input.ownerUserId) throw forbidden("Only the granting Owner may change this delegation");
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).limit(1);
    if (!agent || agent.status === "terminated" || pmCoordinationScope(agent)) throw forbidden("The delegate must be a company agent outside the project PM role");
    const scope: DecisionDelegationScope = { version: 1, revision: randomUUID(),
      activatedAt: new Date().toISOString(), enabled: input.enabled, allowSelfApproval: input.allowSelfApproval, scopes: input.scopes };
    const values = { principalType: "agent", principalId: input.agentId, scope, grantedByUserId: input.ownerUserId, updatedAt: new Date() };
    const [saved] = previous
      ? await tx.update(principalPermissionGrants).set(values).where(eq(principalPermissionGrants.id, previous.id)).returning()
      : await tx.insert(principalPermissionGrants).values({ ...values, companyId: input.companyId, permissionKey: DECISION_DELEGATION_PERMISSION }).returning();
    const activity = await persistActivity(database, { companyId: input.companyId, actorType: "user", actorId: input.ownerUserId,
      action: "delegation.updated", entityType: "agent", entityId: input.agentId,
      details: { grantId: saved!.id, previousRevision: input.baseRevision, scope, reason: input.reason ?? "Owner delegation configuration" } });
    publication = activity.publication;
    return saved!;
  });
  if (publication) publishActivity(publication);
  return result;
}

/** Facts here come from the persisted request/issue, never an agent-supplied risk rating. */
export async function routeDelegatedDecision(db: Db, input: {
  companyId: string; issueId?: string | null; requesterAgentId: string | null;
  sourceRunId: string | null; fingerprint: string; createdAt: Date;
  category: "interaction" | "approval" | "runtime";
  reservedReasons: HumanReservedDecisionReason[];
  requiredScopes?: DecisionDelegationScope["scopes"];
  requiresDelegate?: boolean;
}): Promise<DelegatedDecisionContext | null> {
  const grant = await readDecisionDelegation(db, input.companyId, { lock: true });
  if (!grant || input.createdAt.getTime() < Date.parse(grant.scope.activatedAt)) return null;
  const requiredScopes: DecisionDelegationScope["scopes"] = [...new Set([
    input.category === "approval" ? "general_approvals" as const : "task_decisions" as const,
    ...(input.requiredScopes ?? []),
  ])];
  if (!requiredScopes.every(scope => grant.scope.scopes.includes(scope))) return null;
  const [requester] = input.requesterAgentId ? await db.select().from(agents).where(and(eq(agents.id, input.requesterAgentId), eq(agents.companyId, input.companyId))).limit(1) : [];
  if (input.requesterAgentId && !requester || !requester && input.category !== "approval") throw forbidden("Decision requester is outside the company");
  const [issue] = input.issueId ? await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).limit(1) : [];
  if (input.issueId && !issue) throw forbidden("Decision task is outside the company");
  const context: DelegatedDecisionContext = {
    version: 1, grantId: grant.id, grantRevision: grant.scope.revision, ownerUserId: grant.ownerUserId,
    delegateAgentId: grant.agentId, level: "delegate", recipientAgentId: grant.agentId,
    projectId: issue?.projectId ?? null, sourceRunId: input.sourceRunId,
    sourceFingerprint: input.fingerprint, revision: randomUUID(), reservedReasons: input.reservedReasons, requiredScopes,
  };
  if (context.reservedReasons.length || (requester?.id === grant.agentId && !grant.scope.allowSelfApproval)) {
    return { ...context, level: "human", recipientAgentId: null };
  }
  if (!input.requiresDelegate && input.category !== "approval" && requester && !pmCoordinationScope(requester) && requester.id !== grant.agentId && issue?.projectId) {
    const candidates = (await db.select().from(agents).where(eq(agents.companyId, input.companyId)))
      .filter(agent => pmCoordinationScope(agent)?.projectId === issue.projectId);
    if (candidates.length !== 1) throw conflict("The task project must have exactly one designated PM");
    context.level = "pm";
    context.recipientAgentId = candidates[0]!.id;
  }
  return context;
}

export async function assertDelegatedDecisionActor(db: Db, input: {
  companyId: string; context: DelegatedDecisionContext; agentId: string; runId: string;
  revision: string; fingerprint: string;
}) {
  const { context } = input;
  if (context.revision !== input.revision || context.sourceFingerprint !== input.fingerprint) throw conflict("Delegated request has changed; the old answer is stale");
  if (context.level === "human" || context.reservedReasons.length || context.recipientAgentId !== input.agentId) throw forbidden("This request is not delegated to this agent");
  const grant = await readDecisionDelegation(db, input.companyId, { lock: true });
  if (!grant || grant.id !== context.grantId || grant.scope.revision !== context.grantRevision || grant.agentId !== context.delegateAgentId) throw forbidden("The delegation is no longer current");
  if (!context.requiredScopes.every(scope => grant.scope.scopes.includes(scope))) throw forbidden("This operation is outside the delegation scope");
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId))).limit(1).for("share");
  if (!run || run.status !== "running") throw forbidden("A current running agent turn is required to decide");
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).limit(1).for("share");
  if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status)) throw forbidden("The deciding agent is unavailable");
  if (context.level === "pm" && pmCoordinationScope(agent)?.projectId !== context.projectId) throw forbidden("PM decisions are limited to the assigned project");
  return grant;
}

export function nextDelegatedDecision(context: DelegatedDecisionContext, humanReason?: HumanReservedDecisionReason): DelegatedDecisionContext {
  if (context.level === "human") throw conflict("The request is already waiting for the human Owner");
  const human = context.level === "delegate" || !!humanReason;
  return { ...context, revision: randomUUID(), level: human ? "human" : "delegate",
    recipientAgentId: human ? null : context.delegateAgentId,
    reservedReasons: human ? [...new Set([...context.reservedReasons, humanReason ?? "uncertain"])] : context.reservedReasons };
}
