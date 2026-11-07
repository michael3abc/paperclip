import { z } from "zod";

/** This grant is managed only through the human Owner delegation endpoint. */
export const DECISION_DELEGATION_PERMISSION = "company:delegate_decisions";
export const delegatedDecisionScopeSchema = z.object({
  version: z.literal(1),
  revision: z.string().uuid(),
  activatedAt: z.string().datetime(),
  enabled: z.boolean(),
  allowSelfApproval: z.boolean(),
  scopes: z.array(z.enum(["task_decisions", "ordinary_operations", "agent_model_budget", "external_writes", "general_approvals"])).min(1),
}).strict();
export type DecisionDelegationScope = z.infer<typeof delegatedDecisionScopeSchema>;

/** Independent of company delegation and its optional momo recipient. */
export const PROJECT_PM_DECISION_PERMISSION = "company:project_pm_decisions";
export const projectPmDecisionScopeSchema = delegatedDecisionScopeSchema.extend({
  projectIds: z.array(z.string().uuid()).min(1).refine(ids => new Set(ids).size === ids.length),
  scopes: z.array(z.enum(["task_decisions", "ordinary_operations", "external_writes", "general_approvals"])).min(1),
});

export const HUMAN_RESERVED_DECISION_REASONS = [
  "explicit_human", "major_irreversible_destruction", "sensitive_data_export",
  "account_security_expansion", "delegation_change", "uncertain",
] as const;
export type HumanReservedDecisionReason = (typeof HUMAN_RESERVED_DECISION_REASONS)[number];

/** Persisted by the server, never accepted in an agent request body. */
export interface DelegatedDecisionContext {
  version: 1;
  grantId: string;
  grantRevision: string;
  ownerUserId: string;
  delegateAgentId: string | null;
  authority?: "project_pm";
  sourceIssueId?: string | null;
  level: "pm" | "delegate" | "human";
  recipientAgentId: string | null;
  projectId: string | null;
  sourceRunId: string | null;
  sourceFingerprint: string;
  revision: string;
  reservedReasons: HumanReservedDecisionReason[];
  requiredScopes: DecisionDelegationScope["scopes"];
  notifiedRevision?: string;
  deliveryError?: string;
}

export const updateDecisionDelegationSchema = z.object({
  agentId: z.string().uuid(),
  baseRevision: z.string().uuid().nullable(),
  enabled: z.boolean(),
  allowSelfApproval: z.boolean(),
  scopes: delegatedDecisionScopeSchema.shape.scopes,
  reason: z.string().trim().min(1).max(4000),
}).strict();

export const updateProjectPmDecisionAuthoritySchema = updateDecisionDelegationSchema.omit({ agentId: true }).extend({
  projectIds: projectPmDecisionScopeSchema.shape.projectIds,
  scopes: projectPmDecisionScopeSchema.shape.scopes,
});

export const delegatedRequestSchema = z.object({
  kind: z.enum(["interaction", "approval", "runtime"]),
  requestId: z.string().min(1).max(160),
  runId: z.string().uuid().optional(),
  revision: z.string().uuid(),
  reason: z.string().trim().min(1).max(4000),
}).strict();
export const resolveDelegatedRequestSchema = delegatedRequestSchema.extend({
  action: z.enum(["accept", "reject", "answer", "allow"]),
  response: z.record(z.string(), z.unknown()).optional(),
});
export const escalateDelegatedRequestSchema = delegatedRequestSchema.extend({
  humanReason: z.enum(HUMAN_RESERVED_DECISION_REASONS).optional(),
});
