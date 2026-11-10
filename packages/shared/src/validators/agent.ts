import { agentAppearanceSchema } from "../agent-appearance.js";
import { aiRuntimeConnectionBindingSchema as aiConnectionBindingSchema } from "../ai-connection-router.js";
import { z } from "zod";
import {
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  INBOX_MINE_ISSUE_STATUS_FILTER,
} from "../constants.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";
import { envConfigSchema } from "./secret.js";
import { trustAuthorizationPolicySchema, trustPresetSchema } from "./trust-policy.js";
import { agentDesiredSkillSelectionSchema } from "./adapter-skills.js";
import { objectWithoutDefaults } from "./partial.js";

export const agentPermissionsSchema = z.object({
  // No schema default: the server derives the default (enabled unless the
  // permissions record marks the agent low-trust) when the field is omitted.
  canCreateAgents: z.boolean().optional(),
  canCreateSkills: z.boolean().optional().default(true),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
}).catchall(z.unknown());

export const agentInstructionsBundleModeSchema = z.enum(["managed", "external"]);

export const updateAgentInstructionsBundleSchema = z.object({
  mode: agentInstructionsBundleModeSchema.optional(),
  rootPath: z.string().trim().min(1).nullable().optional(),
  entryFile: z.string().trim().min(1).optional(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
  requireExistingEntry: z.boolean().optional(),
});

export type UpdateAgentInstructionsBundle = z.infer<typeof updateAgentInstructionsBundleSchema>;

export const upsertAgentInstructionsFileSchema = z.object({
  path: z.string().min(1).max(512),
  content: z.string().max(1024 * 1024),
  baseRevisionId: z.string().uuid().nullable().optional(),
  baseHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  changeReason: z.string().trim().min(1).max(2000).optional(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
}).strict();

export const restoreAgentInstructionSchema = z.object({
  path: z.string().min(1).max(512),
  revisionId: z.string().uuid(),
  baseRevisionId: z.string().uuid(),
}).strict();

export type UpsertAgentInstructionsFile = z.infer<typeof upsertAgentInstructionsFileSchema>;

const adapterConfigSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue === undefined) return;
  const parsed = envConfigSchema.safeParse(envValue);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "adapterConfig.env must be a map of valid env bindings",
      path: ["env"],
    });
  }
});

export const createAgentInstructionsBundleSchema = z.object({
  entryFile: z.string().trim().min(1).optional(),
  files: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length > 0, {
    message: "instructionsBundle.files must contain at least one file",
  }),
});

function absoluteWorkspacePathSchema(message: string) {
  return z.string().trim().min(1).max(4096).refine(
    value => !/[\0\r\n]/.test(value) && /^(\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value),
    message,
  );
}

/** A canonical POSIX absolute path on a remote host: no empty, `.` or `..` segments and no trailing slash. */
function remotePosixPathSchema(message: string) {
  return z.string().max(4096).refine(
    value => !/[\0\r\n]/.test(value) && value.startsWith("/") && value.length > 1
      && value.slice(1).split("/").every(part => part !== "" && part !== "." && part !== ".."),
    message,
  );
}

export const PROJECT_PM_WORKER_ISOLATIONS = ["shared", "worktree"] as const;
export const PROJECT_PM_MIN_WORKER_SLOTS = 0;
export const PROJECT_PM_MAX_WORKER_SLOTS = 4;
export const PROJECT_PM_DEFAULT_WORKER_SLOTS = 0;

/**
 * A fixed working directory. `hostId` names a CC Pocket host registry entry:
 * the directory then exists only on that host (a project's `remote_managed`
 * source), the run uses the local environment, and the adapter verifies the
 * path on the host before dispatch. The controller never stats it.
 */
export const agentFixedWorkspaceBindingSchema = z.object({
  mode: z.literal("fixed"),
  cwd: absoluteWorkspacePathSchema("Fixed working directory must be an absolute path"),
  hostId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
}).strict();

/**
 * A fixed project PM: PM turns run in the agent home (or `pmHome` on the
 * worker host) with one shared session. Zero worker slots restrict the agent to
 * coordination and review; positive slots explicitly permit child execution.
 * `agentHome` may be omitted on write; the server fills the canonical value.
 */
export const agentProjectPmWorkspaceBindingSchema = z.object({
  mode: z.literal("project_pm"),
  agentHome: absoluteWorkspacePathSchema("PM agent home must be an absolute path").optional(),
  projectId: z.string().guid(),
  workerRoot: absoluteWorkspacePathSchema("PM worker root must be an absolute path"),
  workerHostId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
  /** PM home on `workerHostId`; requires it (checked when the binding is resolved). */
  pmHome: remotePosixPathSchema("PM home must be a canonical absolute POSIX path").optional(),
  workerIsolation: z.enum(PROJECT_PM_WORKER_ISOLATIONS).default("shared"),
  workerSlots: z.number().int().min(PROJECT_PM_MIN_WORKER_SLOTS).max(PROJECT_PM_MAX_WORKER_SLOTS)
    .default(PROJECT_PM_DEFAULT_WORKER_SLOTS),
  inboxIssueId: z.string().guid().nullable().optional(),
  allowCrossProject: z.boolean().optional(),
}).strict();

export const agentWorkspaceBindingSchema = z.discriminatedUnion("mode", [
  agentFixedWorkspaceBindingSchema,
  agentProjectPmWorkspaceBindingSchema,
]);

export const PM_INTAKE_SOURCES = ["console", "momo"] as const;

export const pmIntakeDedupeIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/);

export const createPmIntakeSchema = z.object({
  dedupeId: pmIntakeDedupeIdSchema,
  source: z.enum(PM_INTAKE_SOURCES),
  text: z.string().min(1).max(20000),
  /** Embedded in the receipt marker, so it may not contain whitespace or angle brackets. */
  sourceRef: z.string().min(1).max(256).regex(/^[^\s<>]+$/).optional(),
}).strict();

export type CreatePmIntake = z.infer<typeof createPmIntakeSchema>;

export const agentRuntimeConfigSchema = z.object({
  pmInstructionLayout: z.enum(["split-v1", "compact-v1"]).optional(),
  aiConnection: aiConnectionBindingSchema.optional(),
  workspaceBinding: agentWorkspaceBindingSchema.optional(),
  /** Shared workers must execute a project task in its isolated Git worktree. */
  requireTaskWorktree: z.boolean().optional(),
  /** Shared workers may use a configured project checkout with exclusive writer admission. */
  requireProjectWorkspace: z.boolean().optional(),
  debug: z.object({
    providerTrace: z.literal("raw").optional(),
  }).strict().optional(),
}).catchall(z.unknown()).superRefine((value, ctx) => {
  if (Object.prototype.hasOwnProperty.call(value, "modelProfiles")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["modelProfiles"],
      message: "runtimeConfig.modelProfiles is no longer supported",
    });
  }
});

export const createAgentSchema = z.object({
  setupId: z.string().guid().optional(),
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  appearance: agentAppearanceSchema.optional(),
  reportsTo: z.string().guid().optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(agentDesiredSkillSelectionSchema).optional(),
  adapterType: agentAdapterTypeSchema,
  runner: z.enum(["auto", "paperclip", "legacy"]).optional(),
  adapterConfig: adapterConfigSchema.optional().default({}),
  instructionsBundle: createAgentInstructionsBundleSchema.optional(),
  runtimeConfig: agentRuntimeConfigSchema.optional().default({}),
  defaultEnvironmentId: z.string().guid().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  // The optional stored-session claim from a completed Claude login session. It
  // is the non-secret `storedSessionId`; it carries no token. The agent-create
  // transaction consumes it as the one-time stored-session claim.
  storedSessionId: z.string().min(1).max(256).optional(),
  // The optional apply-existing flag. When true, the caller binds the fixed
  // Claude OAuth token reference to the owner stored value with no new login
  // round trip. The server permits the no-claim bind only for a user actor and
  // only when that owner already has a stored value. It carries no token.
  applyStoredClaudeLogin: z.boolean().optional(),
  // Narrow intent flag set by the onboarding wizard when it hires the very first
  // agent (the chief of staff). It is not an agent column: the server consumes
  // it to seed the server-owned chief-of-staff persona over the agent's entry
  // instruction file instead of the generic default, and honors it only for
  // board-authored requests. Mirrors onboardingFirstTask on issue create.
  onboardingFirstAgent: z.boolean().optional(),
});

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const builtInAgentProvisionSchema = z.object({
  adapterType: agentAdapterTypeSchema.optional(),
  runner: z.enum(["auto", "paperclip", "legacy"]).optional(),
  adapterConfig: adapterConfigSchema.optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
}).strict();

export type BuiltInAgentProvision = z.infer<typeof builtInAgentProvisionSchema>;

export const builtInAgentEmptyMutationSchema = z.object({}).strict().default({});

export type BuiltInAgentEmptyMutation = z.infer<typeof builtInAgentEmptyMutationSchema>;

export const builtInAgentResetSchema = z.object({
  resources: z.array(z.enum(["agent", "instructions", "skill", "routine"])).optional(),
}).strict().default({});

export type BuiltInAgentReset = z.infer<typeof builtInAgentResetSchema>;

export const createAgentHireSchema = createAgentSchema.omit({ setupId: true }).extend({
  setupAgentId: z.string().guid().optional(),
  sourceIssueId: z.string().guid().optional().nullable(),
  sourceIssueIds: z.array(z.string().guid()).optional(),
  // Agent-authored hires may explicitly request the caller's native runner
  // settings. The server consumes this intent; it is never an agent column.
  inheritRuntimeFrom: z.literal("caller").optional(),
});

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

// Narrow intent used by roster bulk edits. The server merges only these fields
// into the latest configuration and rejects stale previews.
export const agentRuntimeSettingsPatchSchema = z.object({
  harness: z.string().min(1),
  model: z.string().trim().min(1).max(512).optional(),
  aiConnection: aiConnectionBindingSchema.optional(),
  expected: z.object({
    model: z.string().nullable(),
    aiConnection: aiConnectionBindingSchema.nullable(),
  }).strict(),
}).strict().refine(value => value.model !== undefined || value.aiConnection !== undefined, {
  message: "Choose a connection or default model to change",
});
export type AgentRuntimeSettingsPatch = z.infer<typeof agentRuntimeSettingsPatchSchema>;

export const updateAgentSchema = objectWithoutDefaults(
  createAgentSchema.omit({ permissions: true, onboardingFirstAgent: true, setupId: true }),
)
  .partial()
  .extend({
    permissions: z.never().optional(),
    runtimeSettings: agentRuntimeSettingsPatchSchema.optional(),
    replaceAdapterConfig: z.boolean().optional(),
    expectedConfigurationRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    status: z.enum(["paused", "idle", "terminated"]).optional(),
    spentMonthlyCents: z.never().optional(),
  });

export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const qualifyAgentRunnerSchema = z.object({
  expectedEnvironmentId: z.string().uuid(),
}).strict();

export const updateAgentInstructionsPathSchema = z.object({
  path: z.string().trim().min(1).nullable(),
  adapterConfigKey: z.string().trim().min(1).optional(),
});

export type UpdateAgentInstructionsPath = z.infer<typeof updateAgentInstructionsPathSchema>;

export const taskBridgeAgentKeyScopeSchema = z.object({
  kind: z.literal("task_bridge"),
  projectId: z.string().guid().optional().nullable(),
  projectIds: z.array(z.string().guid()).max(50).optional(),
  parentIssueId: z.string().guid().optional().nullable(),
  parentIssueIds: z.array(z.string().guid()).max(50).optional(),
  allowedAssigneeAgentIds: z.array(z.string().guid()).max(50).optional(),
}).strict().superRefine((value, ctx) => {
  const hasProjectBoundary = Boolean(value.projectId) || Boolean(value.projectIds?.length);
  const hasParentBoundary = Boolean(value.parentIssueId) || Boolean(value.parentIssueIds?.length);
  if (!hasProjectBoundary && !hasParentBoundary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "task_bridge keys require at least one project or parent issue boundary",
      path: ["projectId"],
    });
  }
});

/**
 * Long-lived key held by a CC Pocket Bridge for one project card's native
 * session. It reads and comments within `projectIds` (plus the agent's own
 * conversation) without a heartbeat run. It never checks out work, manages
 * connections or secrets, or writes outside its projects. See
 * doc/plans/2026-11-10-session-bridge-key-scope.md.
 */
export const sessionBridgeAgentKeyScopeSchema = z.object({
  kind: z.literal("session_bridge"),
  projectIds: z.array(z.string().guid()).min(1).max(50),
  /** Agent whose Agent Chat conversation this key may mirror into. */
  conversationAgentId: z.string().guid().optional().nullable(),
  /** Permit creating issues inside `projectIds` (stamped originKind=session_bridge). */
  allowCreateTasks: z.boolean().optional(),
  allowAssignedTools: z.boolean().optional(),
}).strict();

export const standardAgentKeyScopeSchema = z.object({
  kind: z.literal("standard"),
}).strict();

export const skillTestAgentKeyScopeSchema = z.object({
  kind: z.literal("skill_test"),
  issueId: z.string().guid(),
}).strict();

export const agentApiKeyScopeSchema = z.union([
  standardAgentKeyScopeSchema,
  taskBridgeAgentKeyScopeSchema,
  skillTestAgentKeyScopeSchema,
  sessionBridgeAgentKeyScopeSchema,
]);

export type AgentApiKeyScope = z.infer<typeof agentApiKeyScopeSchema>;
export type TaskBridgeAgentKeyScope = z.infer<typeof taskBridgeAgentKeyScopeSchema>;
export type SessionBridgeAgentKeyScope = z.infer<typeof sessionBridgeAgentKeyScopeSchema>;
export type SkillTestAgentKeyScope = z.infer<typeof skillTestAgentKeyScopeSchema>;

export function normalizeAgentApiKeyScope(value: unknown): AgentApiKeyScope {
  const parsed = agentApiKeyScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : { kind: "standard" };
}

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
  scope: agentApiKeyScopeSchema.optional().default({ kind: "standard" }),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

export const agentMineInboxQuerySchema = z.object({
  userId: z.string().trim().min(1),
  status: z.string().trim().min(1).optional().default(INBOX_MINE_ISSUE_STATUS_FILTER),
});

export type AgentMineInboxQuery = z.infer<typeof agentMineInboxQuerySchema>;

export const wakeAgentSchema = z.object({
  source: z
    .enum(["timer", "assignment", "on_demand", "automation"])
    .optional()
    .default("on_demand"),
  triggerDetail: z.enum(["manual", "ping", "callback", "system"]).optional(),
  reason: z.string().optional().nullable(),
  /** Select an exact failed run; its chat request and actor are server-derived. */
  failedRunId: z.string().uuid().optional(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
  forceFreshSession: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.boolean().optional().default(false),
  ),
  debug: z
    .object({
      providerTrace: z.literal("raw"),
    })
    .strict()
    .optional(),
});

export type WakeAgent = z.infer<typeof wakeAgentSchema>;

export const resetAgentSessionSchema = z.object({
  taskKey: z.string().min(1).optional().nullable(),
});

export type ResetAgentSession = z.infer<typeof resetAgentSessionSchema>;

export const testAdapterEnvironmentSchema = z.object({
  runner: z.enum(["auto", "paperclip", "legacy"]).optional(),
  aiConnection: aiConnectionBindingSchema.optional(),
  /** Saved agent whose redacted environment entries are restored for this probe. */
  agentId: z.string().guid().optional(),
  /** One-shot provider keys for a probe. Never persist these in agent config. */
  testCredentials: z.object({
    ANTHROPIC_API_KEY: z.string().max(16384),
    OPENAI_API_KEY: z.string().max(16384),
    OPENROUTER_API_KEY: z.string().max(16384),
    GEMINI_API_KEY: z.string().max(16384),
    XAI_API_KEY: z.string().max(16384),
    GROQ_API_KEY: z.string().max(16384),
    OPENCODE_API_KEY: z.string().max(16384),
    CURSOR_API_KEY: z.string().max(16384),
    KIMI_MODEL_API_KEY: z.string().max(16384),
    API_SERVER_KEY: z.string().max(16384),
    ZAI_API_KEY: z.string().max(16384),
    KIMI_API_KEY: z.string().max(16384),
    MINIMAX_API_KEY: z.string().max(16384),
  }).partial().strict().optional(),
  adapterConfig: adapterConfigSchema.optional().default({}),
  /**
   * Optional environment to run the adapter test inside. When omitted, the
   * test runs against the local Paperclip host. When provided and the
   * environment is non-local (SSH/sandbox), the test probes are executed
   * inside that environment so the result reflects real agent execution.
   */
  environmentId: z.string().guid().optional().nullable(),
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
  canCreateSkills: z.boolean().optional(),
  canAssignTasks: z.boolean(),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;

export const addAgentProjectAccessSchema = z.object({
  projectIds: z.array(z.string().uuid()).min(1).max(100),
}).strict();

export const resolveAgentInstructionCandidateSchema = z.object({
  baseRevisionId: z.string().uuid().nullable(),
  content: z.string().max(1024 * 1024),
}).strict();
export type ResolveAgentInstructionCandidate = z.infer<typeof resolveAgentInstructionCandidateSchema>;
