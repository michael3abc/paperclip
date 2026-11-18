import { claimSharedCheckout } from "./shared-checkout.js";
import { isMainManagedExecutionWorkspace, readMainManagedWorktree } from "@paperclipai/shared";
import { mainManagedWorktreeService } from "../main-managed-worktrees.js";
import { isMainAgent, mainAgentProjectId } from "../main-agent-workers.js";
import { remoteBridgeWorkerHost } from "./remote-bridge-worker.js";
import { NATIVE_REMOTE_RECOVERY_LEASE_MISMATCH, remoteRecoveryLeaseMismatch } from "../native-runtime/remote-recovery-lease-mismatch.js";
import { readInheritedRunnerRetainedSandbox } from "../native-runtime/native-inherited-runner-retry.js";
import { resolveProviderApiPlacement } from "../native-runtime/provider-api-placement.js";
import { assertEphemeralWorkspaceExecution, readRemoteWorkspaceAuthority, RemoteWorkspaceWriterActiveError, reserveRemoteWorkspace, shouldUseRemoteWorkspaces } from "../remote-workspaces.js";
import { WorkspaceBusyDeferral } from "./retries.js";
import { remoteWorkspaceHoldRefusesStart } from "../remote-workspace-writer-hold.js";
import { WORKSPACE_BUSY_RETRY_REASON } from "../../modules/run-dispatch/index.js";
import { findWorkspaceProviderFailure } from "../workspace-provider-failure.js";
import { readFreshWorkspaceReadiness, recordVerifiedRetryWorkspace, type ContinuationReadiness } from "../fresh-workspace-continuation.js";
import { assertNativeSessionPreparationAuthority } from "../native-runtime/native-execution-lease.js";
import { NativeExecutionContext } from "../native-runtime/native-execution-context.js";
import { resolveRemoteWorkspaceSource } from "./remote-workspace-source.js";
import { reserveFreshPluginTaskWorkspace, stageProviderFreshWorkspace } from "../provider-fresh-workspace.js";
import { freshWorkspaceSchema, type PluginFreshWorkspace } from "@paperclipai/plugin-sdk";
import { pluginRegistryService } from "../plugin-registry.js";
import { attachPreservedWorkspaceSnapshots } from "../workspace-recovery-snapshot.js";
import { describeRetainedPriorWorkspace, materializeFreshWorkspaceSeed } from "../fresh-workspace-seed.js";
import { assertTaskWorkspaceExecutionAccess } from "../task-workspace-access.js";
import { preparePluginWorkspace, type WorkspaceWorkers } from "../plugin-workspaces.js";
import { readWorkspaceProviderBinding } from "@paperclipai/shared";
import { nativeExecutionUsesTaskWorkspace } from "./external-provider.js";
import { readGitCacheRestoration } from "../git-workspace-restoration.js";
import { createHeartbeatPreparationTiming } from "./preparation-timing.js";
import {
  resolveWorkspaceAfterLowTrustPreflight,
  WorkspaceValidationFailure,
  stripHostWorkspaceProvision,
  assertGitWorktreeBaseWorkspaceReady,
  buildEffectiveRunWorkspaceConfigMetadata,
  resolveExecutionWorkspaceConfigFreshness,
  resolveExecutionWorkspaceReuseProvisioningPolicy,
  provisionExecutionWorkspaceForFreshnessDecision,
  mergeExecutionWorkspaceMetadataForPersistence,
  resolveExecutionWorkspaceBranchOwnership,
  reconcileReusedExecutionWorkspaceProjectWorkspaceId,
  recordWorkspaceConfigFreshnessOperation,
  prepareProjectRepositoryWorkspaces,
  WORKSPACE_CONFIG_FINGERPRINT_METADATA_KEY,
} from "./workspaces.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import fs from "node:fs/promises";
import path from "node:path";
import { CONTROLLER_PROVISION_COPY_ONLY, workspaceRequiresCopyOnlyProvisioning } from "../workspace-host-provision.js";
import { and, asc, eq, sql } from "drizzle-orm";
import { type ExecutionWorkspace } from "@paperclipai/shared";
import { executionWorkspaces as executionWorkspacesTable, heartbeatRuns, issues, projects, projectWorkspaces, environmentLeases } from "@paperclipai/db";
import { getStartupTracer } from "../../instrumentation.js";
import { createHostDuplexObservabilityRecorder } from "../duplex-observability-recorder.js";
import { incrementToolRuntimeMetricCounter } from "../tool-runtime-metrics.js";
import { logger } from "../../middleware/logger.js";
import { HttpError } from "../../errors.js";
import { createGitRemoteAuthProvider } from "../git-credentials.js";
import { readNativeWorkspaceSyncReference, readNativeWorkspaceSyncLocalCwd } from "../native-runtime/index.js";
import { parseObject } from "../../adapters/utils.js";
import { materializeNativeChatTaskRoot } from "../native-runtime/native-chat-workspace.js";
import { materializeIsolatedTaskDirectory } from "../isolated-task-directory.js";
import { withIndependentWorkspaceSourceLocks } from "../workspace-source-lock.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable,
  realizeExecutionWorkspace,
  renderWorkspaceTemplate, sanitizeBranchName,
  type ExecutionWorkspaceInput,
  type RealizedExecutionWorkspace,
} from "../workspace-runtime.js";
import {
  readManagedWorktreeInstanceOwnership,
  WORKTREE_INSTANCE_ROOT_METADATA_KEY,
} from "../workspace-instance-cleanup.js";
import { isRuntimeOwnedGitBranch } from "../execution-workspace-branch-ownership.js";
import {
  issueExecutionWorkspaceModeForPersistedWorkspace,
  resolveEffectiveWorkspaceStrategyType,
} from "../execution-workspace-policy.js";
import { evaluateExecutionAllowlist } from "../execution-allowlist.js";
import type { Db, agents } from "@paperclipai/db";
import type {
  Environment,
  IssueExecutionWorkspaceSettings,
  ProjectExecutionWorkspacePolicy,
} from "@paperclipai/shared";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import type { NativeRunHistoricalSpan } from "../native-runtime/native-run-trace.js";
import type { NativeRestartRecoveryClaim } from "../native-runtime/index.js";
import type { NativeChatWorkspaceScope } from "../native-runtime/native-chat-workspace.js";
import type { TrustPresetResolution } from "../trust-preset-resolver.js";
import type { environmentRunOrchestrator } from "../environment-run-orchestrator.js";
import type { instanceSettingsService } from "../instance-settings.js";
import type { executionWorkspaceService, TaskWorkspaceBindingPatch } from "../execution-workspaces.js";
import type { workspaceOperationService } from "../workspace-operations.js";
import type { watchLegacyControllerLease } from "../legacy-controller-lease.js";
import type {
  createHeartbeatWorkspaceResolver,
  resolveExecutionWorkspaceReuseRequestForIssue,
} from "./workspaces.js";
import type { createHeartbeatLifecycle } from "./run-lifecycle.js";
import { readPaperclipPmWorkspaceContext, readWorkspaceBinding, assertFixedWorkspacePolicy, isExternalWorkspaceTask, isFixedMainReview, appliedFixedWorkspaceStrategies } from "../agent-workspace-binding.js";
import type {
  ParsedExecutionWorkspaceMode,
  ExecutionWorkspaceEnvironmentResolution,
} from "../execution-workspace-policy.js";

type WorkspaceResolver = ReturnType<typeof createHeartbeatWorkspaceResolver>;
type WorkspaceMetadataInput = Parameters<typeof buildEffectiveRunWorkspaceConfigMetadata>[0];

/** Exact-lease failures that prove the retained sandbox can no longer be used. */
const RETAINED_SANDBOX_GONE = new RegExp(`^${NATIVE_REMOTE_RECOVERY_LEASE_MISMATCH}: stage=environment_(?:acquire|resume) field=(?:lease|lease_status|lease_expired|provider_lease_id)$`);

export class RetryWorkspaceRefused extends Error {}

/** Prepares the workspace and environment; dispatch and terminal lease release stay with the caller. */
export interface HeartbeatWorkspacePreparationInput {
  signal?: AbortSignal;
  run: typeof heartbeatRuns.$inferSelect;
  agent: typeof agents.$inferSelect;
  task: {
    issueRef: (NonNullable<Parameters<typeof realizeExecutionWorkspace>[0]["issue"]> & {
      projectId: string | null;
      projectWorkspaceId: string | null;
      executionWorkspaceId: string | null;
      executionWorkspacePreference: string | null;
      assigneeAgentId?: string | null;
      conversationAgentId?: string | null;
      executionState?: unknown;
    }) | null;
    issueId: string | null;
    wasIssueAssignee: boolean;
    context: Record<string, unknown>;
    responsibleUserId: string | null;
    previousSessionParams: Record<string, unknown> | null;
    freshWorkspace?: import("../fresh-workspace-continuation.js").ContinuationReadiness | null;
    retryWorkspaceCandidate?: Extract<ContinuationReadiness, { mode: "reuse_issue_workspace" }>;
    workspaceSelection?: import("@paperclipai/shared").TaskWorkspaceIntent | null;
  };
  policy: {
    trustPreset: TrustPresetResolution;
    isolatedWorkspacesEnabled: boolean;
    effectiveExecutionWorkspaceMode: ParsedExecutionWorkspaceMode;
    requestedExecutionWorkspaceMode: ParsedExecutionWorkspaceMode;
    useIsolatedTaskDirectory: boolean;
    nativeChatWorkspaceScope: NativeChatWorkspaceScope | null;
    projectExecutionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
    issueExecutionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
    environmentExecutionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
    executionPolicy: Parameters<typeof evaluateExecutionAllowlist>[0];
  };
  environment: {
    selectedEnvironmentId: string | null;
    localEnvironment: Environment;
    selectedEnvironmentForConfig: Environment | null;
    environmentResolution: ExecutionWorkspaceEnvironmentResolution | { environmentId: null; source: "default" };
    resolvedInstanceSettings: Awaited<ReturnType<ReturnType<typeof instanceSettingsService>["get"]>>;
  };
  config: {
    mergedConfig: Record<string, unknown>;
    configSnapshot: WorkspaceMetadataInput["configSnapshot"];
    secretManifest: WorkspaceMetadataInput["secretManifest"];
    managedAiCredentialIdentity?: string;
    runnerTaskResumeSessionId?: string | null;
  };
  reuse: {
    requestedShouldReuseExisting: boolean;
    existingExecutionWorkspace: ExecutionWorkspace | null;
    reusableExistingExecutionWorkspace: ExecutionWorkspace | null;
    workspaceReuseRequest: ReturnType<typeof resolveExecutionWorkspaceReuseRequestForIssue>;
    nativeRecoveryExecutionWorkspaceId: string | null;
    persistedNativeExecutionInput: NativeExecutionInput | null;
    isDotRun: boolean;
    runOptions: { nativeLeaseOwner?: string; nativeRestartRecovery?: NativeRestartRecoveryClaim; portablePreparationLeaseId?: string };
  };
  services: {
    workspaceWorkers?: WorkspaceWorkers;
    envOrchestrator: Pick<ReturnType<typeof environmentRunOrchestrator>, "resolveEnvironment" | "acquireForRun" | "confirmWorkspaceTaskPlacement" | "realizeForRun" | "releaseForRun">;
    executionWorkspacesSvc: Pick<ReturnType<typeof executionWorkspaceService>, "create" | "update" | "getStoredById" | "bindTaskWorkspace" | "prepareTaskRepositoriesForAdmission" | "assertTaskRepositoryPublicationAllowed" | "prepareConfiguredRepositoryCopy" | "assertTaskRepositoryRecoveryBinding">;
    workspaceOperationsSvc: Pick<ReturnType<typeof workspaceOperationService>, "createRecorder">;
    resolveWorkspaceForRun: WorkspaceResolver["resolveWorkspaceForRun"];
    resolveReusedGitWorkspaceAnchor: WorkspaceResolver["resolveReusedGitWorkspaceAnchor"];
    appendRunEvent: ReturnType<typeof createHeartbeatLifecycle>["appendRunEvent"];
  };
  controllerLease: Pick<ReturnType<typeof watchLegacyControllerLease>, "assertOwned">;
  nativeRunnerPreparationSpans: NativeRunHistoricalSpan[];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Liveness-first (rule 3): joining a main-managed tree never fails on its
 * registration generation, phase, pending operation, host receipt or host
 * inspection. Authorization still does: a revoked, cancelled or paused run, a
 * held agent or project, a closed task, or missing project/repository access.
 */
function isManagedAdmissionAuthorityFailure(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  if ([401, 403, 404].includes(error.status)) return true;
  const details = parseObject(error.details);
  return details.code === "worktree_run_no_longer_admitted";
}

export async function prepareHeartbeatWorkspace(db: Db, input: HeartbeatWorkspacePreparationInput) {
  if (isMainManagedExecutionWorkspace(input.reuse.reusableExistingExecutionWorkspace ?? input.reuse.existingExecutionWorkspace)) {
    return prepareHeartbeatWorkspaceLocked(db, input);
  }
  const sourceIssueId = input.reuse.reusableExistingExecutionWorkspace?.sourceIssueId
    ?? input.reuse.existingExecutionWorkspace?.sourceIssueId ?? input.task.issueId;
  if (input.reuse.isDotRun || resolveProviderApiPlacement(input)) return prepareHeartbeatWorkspaceLocked(db, input);
  // A run can be dispatched from inside another operation's source scope, for
  // example by a recovery timer. Its preparation owns its own locks.
  if (!sourceIssueId) return withIndependentWorkspaceSourceLocks(db, { companyId: input.agent.companyId },
    () => prepareHeartbeatWorkspaceLocked(db, input));
  return withIndependentWorkspaceSourceLocks(db, { companyId: input.agent.companyId,
    issueIds: [...new Set([sourceIssueId, input.task.issueId].filter((id): id is string => Boolean(id)))] }, async () => {
    const reuse = { ...input.reuse };
    for (const key of ["existingExecutionWorkspace", "reusableExistingExecutionWorkspace"] as const) {
      const selected = reuse[key];
      if (!selected || readRemoteWorkspaceAuthority(selected.metadata)) continue;
      const [fresh] = await db.select({ metadata: executionWorkspacesTable.metadata }).from(executionWorkspacesTable)
        .where(and(eq(executionWorkspacesTable.companyId, input.agent.companyId), eq(executionWorkspacesTable.id, selected.id)));
      if (!readRemoteWorkspaceAuthority(fresh?.metadata)) continue;
      const current = await input.services.executionWorkspacesSvc.getStoredById(input.agent.companyId, selected.id);
      if (current && readRemoteWorkspaceAuthority(current.metadata)) reuse[key] = current;
    }
    return prepareHeartbeatWorkspaceLocked(db, { ...input, reuse });
  });
}

async function prepareHeartbeatWorkspaceLocked(db: Db, input: HeartbeatWorkspacePreparationInput) {
  const { run, agent, controllerLease, nativeRunnerPreparationSpans } = input;
  const providerApiPlacement = resolveProviderApiPlacement(input);
  const fresh = input.task.freshWorkspace?.mode === "fresh_isolated_workspace";
  const timeWorkspace = createHeartbeatPreparationTiming(run.id);
  const fixedBinding = readWorkspaceBinding(agent.runtimeConfig, input.task.context);
  // A shared CC Pocket worker on another Bridge host works in that host's copy of the task's source.
  const remoteWorkerHost = remoteBridgeWorkerHost(agent);
  const pmCoordination = fixedBinding !== null && (agent.runtimeConfig?.workspaceBinding as { mode?: string } | undefined)?.mode === "project_pm"
    && readPaperclipPmWorkspaceContext(input.task.context.paperclipPmWorkspace)?.role === "pm";
  const reviewHome = isFixedMainReview(agent, input.task.issueRef);
  const preserveTaskWorkspace = pmCoordination || reviewHome;
  const {
    issueRef,
    issueId,
    context,
    responsibleUserId,
    previousSessionParams,
  } = input.task;
  const {
    trustPreset,
    isolatedWorkspacesEnabled: runtimeWorkspaceSelectionEnabled,
    effectiveExecutionWorkspaceMode,
    requestedExecutionWorkspaceMode,
    useIsolatedTaskDirectory,
    nativeChatWorkspaceScope,
    projectExecutionWorkspacePolicy,
    issueExecutionWorkspaceSettings,
    environmentExecutionWorkspaceSettings,
    executionPolicy,
  } = input.policy;
  const {
    selectedEnvironmentId,
    localEnvironment,
    selectedEnvironmentForConfig,
    environmentResolution,
    resolvedInstanceSettings,
  } = input.environment;
  const { mergedConfig, configSnapshot, secretManifest } = input.config;
  // Caller wake JSON cannot grant a filesystem binding. Publish only after the
  // server's current task selection and lifecycle generation have been checked.
  delete context.managedWorktreeParticipation;
  delete context.mainWorktreeParentDir;
  delete context.sessionOnly;
  const managedWorkspace = isMainManagedExecutionWorkspace(input.reuse.reusableExistingExecutionWorkspace)
    ? input.reuse.reusableExistingExecutionWorkspace : null;
  const managedMarker = readMainManagedWorktree(managedWorkspace?.metadata);
  const explicitSessionOnly = Boolean(issueId && issueRef?.projectId
    && input.task.workspaceSelection?.selection.kind === "session_only"
    && issueExecutionWorkspaceSettings?.sessionOnly === true
    && !input.reuse.persistedNativeExecutionInput?.binding.executionWorkspaceId);
  const sessionOnly = !managedWorkspace && (issueExecutionWorkspaceSettings?.sessionOnly === true
    || Boolean(context.paperclipPmWorkspace)
    || (isMainAgent(agent) && (!issueRef || issueRef.conversationAgentId === agent.id)));
  if (sessionOnly) { context.sessionOnly = true; delete context.sharedCheckoutClaim; }
  const mainProjectId = mainAgentProjectId(agent);
  if (mainProjectId) {
    const [project] = await db.select({ policy: projects.executionWorkspacePolicy }).from(projects)
      .where(and(eq(projects.id, mainProjectId), eq(projects.companyId, agent.companyId)));
    const parentDir = parseObject(project?.policy?.workspaceStrategy).worktreeParentDir;
    if (typeof parentDir === "string" && path.isAbsolute(parentDir)) context.mainWorktreeParentDir = parentDir;
  }
  let managedAdmission: Awaited<ReturnType<ReturnType<typeof mainManagedWorktreeService>["prepareRun"]>> | null = null;
  if (managedWorkspace) {
    // Liveness-first: the main-managed marker only means "do not delete"; admission,
    // generation, receipt and host checks are advisory and never fail the run.
    const warnManaged = (reason: string, message: string, error?: unknown) => logger.warn({ runId: run.id, agentId: agent.id,
      workspaceId: managedWorkspace.id, workspaceValidation: { reason }, err: error }, `Managed worktree mismatch ignored: ${message}`);
    if (!managedMarker || !issueId || managedWorkspace.projectId !== issueRef?.projectId)
      warnManaged("worktree_marker_unrecognized", "the managed worktree binding is invalid.");
    const bridgeHost = typeof mergedConfig.hostId === "string" ? mergedConfig.hostId : fixedBinding?.hostId ?? remoteWorkerHost;
    if (fresh || useIsolatedTaskDirectory || preserveTaskWorkspace || input.reuse.isDotRun || providerApiPlacement
      || (selectedEnvironmentForConfig && selectedEnvironmentForConfig.driver !== "local")
      || (managedMarker?.hostId && (agent.adapterType !== "ccpocket_bridge" || bridgeHost !== managedMarker.hostId)))
      warnManaged("worktree_host_capability_unavailable", "the selected runtime does not match the registered worktree host.");
    await controllerLease.assertOwned();
    if (managedMarker && issueId && managedWorkspace.projectId) {
      managedAdmission = await mainManagedWorktreeService(db).prepareRun({ companyId: agent.companyId, projectId: managedWorkspace.projectId,
        workspaceId: managedWorkspace.id, actor: { type: "agent", source: "agent_jwt", companyId: agent.companyId, agentId: agent.id,
          runId: run.id, onBehalfOfUserId: responsibleUserId === "local-board" ? null : responsibleUserId } }, issueId,
        Number(managedWorkspace.metadata?.lifecycleGeneration ?? 0)).catch(error => {
        // Current authority still applies: a revoked, paused or unauthorized run
        // fails here. Generation, phase, pending-operation, receipt and host
        // inspection results are advisory and only skip participant registration.
        if (isManagedAdmissionAuthorityFailure(error)) throw error;
        warnManaged("worktree_admission_skipped", "participant registration failed; running in the directory anyway.", error);
        return null;
      });
    }
    if (managedMarker) context.managedWorktreeParticipation = { workspaceId: managedWorkspace.id,
      generation: managedAdmission?.generation ?? Number(managedWorkspace.metadata?.lifecycleGeneration ?? 0),
      cwd: managedWorkspace.cwd, hostId: managedMarker.hostId, branch: managedMarker.branch,
      // Valid v1 registrations without kind predate repository-root support and denote linked trees.
      kind: managedMarker.kind ?? "linked_worktree", sourceCwd: managedMarker.sourceCwd,
      parentDir: managedMarker.parentDir, projectId: managedWorkspace.projectId };
  }
  const warnWorkspace = (reason: string, message: string) => logger.warn({ runId: run.id, agentId: agent.id, issueId,
    workspaceValidation: { reason } }, `Workspace mismatch ignored: ${message}`);
  if (!managedWorkspace && agent.runtimeConfig?.requireTaskWorktree === true && (
    !issueId || !issueRef?.projectId || fixedBinding || !runtimeWorkspaceSelectionEnabled ||
    effectiveExecutionWorkspaceMode !== "isolated_workspace" ||
    resolveEffectiveWorkspaceStrategyType(requestedExecutionWorkspaceMode, mergedConfig) !== "git_worktree"
  )) {
    warnWorkspace("shared_worker_requires_task_worktree", "the shared worker prefers an isolated Git worktree; using the resolved directory.");
  }
  if (!managedWorkspace && !explicitSessionOnly && agent.runtimeConfig?.requireProjectWorkspace === true && (
    !issueId || !issueRef?.projectId || !issueRef.projectWorkspaceId || fixedBinding || !runtimeWorkspaceSelectionEnabled ||
    !["shared_workspace", "isolated_workspace"].includes(effectiveExecutionWorkspaceMode) ||
    (effectiveExecutionWorkspaceMode === "shared_workspace" && resolveEffectiveWorkspaceStrategyType(requestedExecutionWorkspaceMode, mergedConfig) !== "project_primary")
  )) warnWorkspace("shared_worker_requires_project_workspace", "the shared worker prefers a project checkout or isolated worktree; using the resolved directory.");
  if (!managedWorkspace && !explicitSessionOnly && remoteWorkerHost && (fresh || useIsolatedTaskDirectory || !issueId || !issueRef?.projectWorkspaceId ||
    effectiveExecutionWorkspaceMode !== "shared_workspace" || input.task.context.paperclipPmWorkspace ||
    resolveEffectiveWorkspaceStrategyType(requestedExecutionWorkspaceMode, mergedConfig) !== "project_primary")) {
    warnWorkspace("remote_worker_requires_shared_source", `the worker on Bridge host ${remoteWorkerHost} uses the task's shared project source on that host.`);
  }
  const {
    requestedShouldReuseExisting,
    existingExecutionWorkspace,
    reusableExistingExecutionWorkspace,
    workspaceReuseRequest,
    nativeRecoveryExecutionWorkspaceId,
    persistedNativeExecutionInput,
    isDotRun,
    runOptions,
  } = input.reuse;
  if (!managedWorkspace && (agent.runtimeConfig?.requireTaskWorktree === true ||
      (agent.runtimeConfig?.requireProjectWorkspace === true && reusableExistingExecutionWorkspace?.mode !== "shared_workspace")) && reusableExistingExecutionWorkspace &&
      reusableExistingExecutionWorkspace.sourceIssueId !== issueId) {
    warnWorkspace("shared_worker_worktree_owner_mismatch", "the reused worktree belongs to another task.");
  }
  // An ordinary clean task directory already has a new per-attempt identity.
  // It is not a repository source and must not pass through Git copy admission.
  const controllerOnly = isDotRun || providerApiPlacement !== null;
  const freshNeedsSeed = fresh && !controllerOnly && !useIsolatedTaskDirectory &&
    !(nativeChatWorkspaceScope && !nativeChatWorkspaceScope.projectId);
  const {
    envOrchestrator,
    executionWorkspacesSvc,
    workspaceOperationsSvc,
    resolveWorkspaceForRun,
    resolveReusedGitWorkspaceAnchor,
    appendRunEvent,
  } = input.services;
  const pluginTaskWorkspace = selectedEnvironmentForConfig?.driver === "plugin" && agent.adapterType === "paperclip_runner";
  const restartRecovery = runOptions.nativeRestartRecovery;
  const portablePreparationLeaseId = runOptions.portablePreparationLeaseId ??
    (restartRecovery?.kind === "bootstrap_incomplete" ? restartRecovery.portablePreparationLeaseId : undefined);
  if (portablePreparationLeaseId && (!pluginTaskWorkspace || controllerOnly)) {
    throw remoteRecoveryLeaseMismatch("workspace_preparation", "environment_driver");
  }
  for (const workspaceId of new Set([existingExecutionWorkspace?.id, reusableExistingExecutionWorkspace?.id].filter(Boolean))) {
    const [workspace] = await db.select({ metadata: executionWorkspacesTable.metadata }).from(executionWorkspacesTable)
      .where(and(eq(executionWorkspacesTable.companyId, agent.companyId), eq(executionWorkspacesTable.id, workspaceId!)));
    if (parseObject(workspace?.metadata?.remoteWorkspaceMigration).state === "running") {
      throw new WorkspaceValidationFailure("The workspace is being moved to remote storage. Try again after the move completes.",
        { reason: "remote_workspace_migration_in_progress" });
    }
  }
  const enrolledRemoteAuthority = readRemoteWorkspaceAuthority((reusableExistingExecutionWorkspace ?? existingExecutionWorkspace)?.metadata) !== null;
  // Liveness-first (rule 3): an agent's fixed directory wins over remote storage.
  let remoteAuthority = !sessionOnly && !managedWorkspace && !controllerOnly && !remoteWorkerHost && !fixedBinding && shouldUseRemoteWorkspaces({
    adapterType: agent.adapterType,
    environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
    experimentalEnabled: (process.env.PAPERCLIP_EPHEMERAL_SERVER === "true" || resolvedInstanceSettings.experimental.remoteWorkspaceStorageEnabled) && Boolean(issueId && issueRef)
      && !projectExecutionWorkspacePolicy?.storageProviderPluginId,
    existingWorkspace: reusableExistingExecutionWorkspace ?? existingExecutionWorkspace,
  });
  if (!providerApiPlacement) assertEphemeralWorkspaceExecution({ externalConversation: isDotRun,
    adapterType: agent.adapterType,
    environmentDriver: selectedEnvironmentForConfig?.driver,
    pluginTaskWorkspace, remoteAuthority });
  const assertRemotePreparationOwned = run.runtimeMode === "native" ? () => assertNativeSessionPreparationAuthority({
    db, companyId: agent.companyId, runId: run.id,
    leaseOwner: runOptions.nativeLeaseOwner ?? runOptions.nativeRestartRecovery?.leaseOwner,
    ...(runOptions.nativeRestartRecovery ? {
      controllerGeneration: runOptions.nativeRestartRecovery.controllerGeneration,
      providerAttempt: runOptions.nativeRestartRecovery.providerAttempt,
    } : {}),
  }) : () => controllerLease.assertOwned();
  if (enrolledRemoteAuthority) await assertRemotePreparationOwned();
  if (remoteAuthority && (!issueId || !issueRef)) throw new WorkspaceValidationFailure(
    "Remote workspace storage requires a task.", { reason: "remote_workspace_task_required" });
  const remoteSourceState: { value: Extract<Awaited<ReturnType<typeof resolveRemoteWorkspaceSource>>, { authority: "remote" }> | null } = { value: null };
  const pluginConfig = parseObject(selectedEnvironmentForConfig?.config);
  if (fresh && !controllerOnly && pluginTaskWorkspace) {
    const plugin = typeof pluginConfig.pluginKey === "string" ? await pluginRegistryService(db).getByKey(pluginConfig.pluginKey) : null;
    const driver = plugin?.manifestJson.environmentDrivers?.find(value => value.driverKey === pluginConfig.driverKey);
    if (driver?.freshWorkspaceVersion !== 1) throw new WorkspaceValidationFailure(
      "A fresh attempt is unavailable for this workspace storage provider. The existing workspace is retained.",
      { reason: "fresh_workspace_storage_unsupported" });
  }
  const taskWorkspaceOwner = pluginTaskWorkspace ? { agentId: agent.id, environmentId: selectedEnvironmentForConfig.id,
    pluginKey: pluginConfig.pluginKey ?? null, driverKey: pluginConfig.driverKey ?? null } : null;
  for (const workspace of [existingExecutionWorkspace, reusableExistingExecutionWorkspace]) {
    const owner = parseObject(workspace?.metadata?.runnerTaskWorkspaceOwner);
    if ((pluginTaskWorkspace && workspace && workspace.providerType !== "plugin" && Object.keys(owner).length === 0)
        || (Object.keys(owner).length > 0 && (!taskWorkspaceOwner || Object.entries(taskWorkspaceOwner).some(([key, value]) => owner[key] !== value)))) {
      throw new WorkspaceValidationFailure("The retained workspace belongs to a different agent, environment, or storage provider.",
        { reason: "plugin_workspace_owner_mismatch" });
    }
  }
  const workspaceServices = parseObject(mergedConfig.workspaceRuntime).services;
  if (pluginTaskWorkspace && Array.isArray(workspaceServices) && workspaceServices.length > 0) {
    throw new WorkspaceValidationFailure("The selected plugin environment does not support Core workspace services.",
      { reason: "plugin_workspace_services_unsupported" });
  }
  const {
    selectedEnvironmentDriver: lowTrustPreflightEnvironmentDriver,
    workspace: resolvedWorkspace,
  } = await timeWorkspace("workspace_source_resolution", () => resolveWorkspaceAfterLowTrustPreflight({
    db,
    trustPreset,
    isolatedWorkspacesEnabled: runtimeWorkspaceSelectionEnabled,
    effectiveExecutionWorkspaceMode,
    issue: issueRef
      ? {
          companyId: agent.companyId,
          id: issueRef.id,
          projectId: issueRef.projectId,
        }
      : null,
    resolveSelectedEnvironmentDriver: async () => {
      if (providerApiPlacement) return "provider_api";
      const preflightEnvironment = await envOrchestrator.resolveEnvironment(
        {
          companyId: agent.companyId,
          selectedEnvironmentId: selectedEnvironmentId ?? localEnvironment.id,
          localEnvironmentId: localEnvironment.id,
        },
      );
      return preflightEnvironment.driver;
    },
    resolveWorkspace: async () => {
      if (managedWorkspace) {
        return { cwd: managedWorkspace.cwd!, source: "task_session" as const, projectId: managedWorkspace.projectId,
          workspaceId: managedWorkspace.projectWorkspaceId, repoUrl: managedWorkspace.repoUrl, repoRef: managedWorkspace.baseRef,
          workspaceHints: [], warnings: [], baseCwdFallback: false, materializationFailures: [], additionalWorkspaces: [], referencedProjectFailures: [] };
      }
      // A provider-owned workspace has no local directory, so a fixed binding does not apply to it.
      if (fixedBinding && providerApiPlacement) {
        warnWorkspace("fixed_workspace_policy_conflict", "the provider-owned workspace ignores the fixed working directory.");
      }
      if (fixedBinding && !providerApiPlacement) {
        // A run-requested fresh attempt still wins (rule 3: run-requested > agent fixed);
        // remote storage does not apply to a fixed directory.
        if (fresh) warnWorkspace("fixed_workspace_policy_conflict", "the requested fresh attempt is seeded from the fixed working directory.");
        if (enrolledRemoteAuthority) warnWorkspace("fixed_workspace_policy_conflict", "the fixed working directory replaces remote workspace storage.");
        assertFixedWorkspacePolicy({
          binding: fixedBinding, environment: selectedEnvironmentForConfig,
          trustPreset: trustPreset.kind, mode: requestedExecutionWorkspaceMode, isDot: controllerOnly,
          external: await isExternalWorkspaceTask(db, agent.companyId, issueId),
          strategies: appliedFixedWorkspaceStrategies({ mode: requestedExecutionWorkspaceMode, mergedConfig, configSnapshot,
            projectPolicy: projectExecutionWorkspacePolicy, issueStrategy: issueExecutionWorkspaceSettings?.workspaceStrategy,
            environmentStrategy: environmentExecutionWorkspaceSettings?.workspaceStrategy }),
        });
        return resolveWorkspaceForRun(agent, context, previousSessionParams, {
          executionEnvironmentDriver: selectedEnvironmentForConfig?.driver,
          executionEnvironmentConfig: selectedEnvironmentForConfig?.config,
        });
      }
      if (explicitSessionOnly && !fixedBinding) {
        if (fresh || useIsolatedTaskDirectory) warnWorkspace("session_only_workspace_conflict",
          "session-only work ignores the requested fresh task checkout.");
        if (remoteWorkerHost) {
          const cwd = readNonEmptyString(mergedConfig.cwd);
          if (!cwd || !path.posix.isAbsolute(cwd) || path.posix.normalize(cwd) !== cwd)
            throw new WorkspaceValidationFailure("This remote session-only worker needs an absolute session cwd in its adapter settings.",
              { reason: "remote_session_cwd_required" });
          return { cwd, source: "task_session" as const, projectId: issueRef!.projectId, workspaceId: null,
            repoUrl: null, repoRef: null, workspaceHints: [], warnings: [], baseCwdFallback: false,
            materializationFailures: [], additionalWorkspaces: [], referencedProjectFailures: [], localPathOnlyWorkspace: true };
        }
        const workspace = await resolveWorkspaceForRun(agent, context, null, {
          useProjectWorkspace: false, configuredCwd: readNonEmptyString(mergedConfig.cwd), storageProviderPluginId: null,
          skipReferencedWorkspaces: true,
          executionEnvironmentDriver: selectedEnvironmentForConfig?.driver,
          executionEnvironmentConfig: selectedEnvironmentForConfig?.config,
        });
        return { ...workspace, projectId: issueRef!.projectId, workspaceId: null, repoUrl: null, repoRef: null,
          additionalWorkspaces: [], referencedProjectFailures: [] };
      }
      if (remoteWorkerHost) {
        if (remoteAuthority || providerApiPlacement || controllerOnly) throw new WorkspaceValidationFailure(
          "A remote Bridge worker cannot use remote storage or a provider-owned workspace.", { reason: "remote_worker_requires_shared_source" });
        return resolveWorkspaceForRun(agent, context, previousSessionParams, {
          executionEnvironmentDriver: selectedEnvironmentForConfig?.driver,
          executionEnvironmentConfig: selectedEnvironmentForConfig?.config,
        });
      }
      if (remoteAuthority) {
        const strategy = parseObject(mergedConfig.workspaceStrategy);
        const sourceState = await resolveRemoteWorkspaceSource(db, {
          companyId: agent.companyId, issueId: issueId!, agentId: agent.id, runId: run.id,
          responsibleUserId, projectId: issueRef!.projectId,
          projectWorkspaceId: issueRef!.projectWorkspaceId, selection: input.task.workspaceSelection,
          existingWorkspace: fresh ? null : reusableExistingExecutionWorkspace ?? existingExecutionWorkspace,
          taskDirectory: useIsolatedTaskDirectory, automaticEnrollment: !enrolledRemoteAuthority,
          configuredCwd: readNonEmptyString(mergedConfig.cwd),
          ref: readNonEmptyString(strategy.baseRef),
          branchMode: readNonEmptyString(strategy.existingBranch) ? "existing" : "create",
          branchName: readNonEmptyString(strategy.existingBranch) ??
            (resolveEffectiveWorkspaceStrategyType(requestedExecutionWorkspaceMode, mergedConfig) === "git_worktree"
              ? sanitizeBranchName(renderWorkspaceTemplate(String(strategy.branchTemplate ?? "{{issue.identifier}}-{{slug}}"), {
                  issue: issueRef, agent, projectId: issueRef!.projectId, repoRef: null,
                })) : null),
        });
        if (sourceState.authority === "host") {
          remoteAuthority = false;
          // Source resolution can retain a configured host folder. Check the
          // resolved authority before materializing it or acquiring a sandbox.
          if (!providerApiPlacement) assertEphemeralWorkspaceExecution({ externalConversation: isDotRun,
            adapterType: agent.adapterType, environmentDriver: selectedEnvironmentForConfig?.driver, pluginTaskWorkspace, remoteAuthority });
        }
        else {
          remoteSourceState.value = sourceState;
          if (!enrolledRemoteAuthority) await assertRemotePreparationOwned();
          // The remote storage reservation below owns its actual workspace.
          // Project-wide sharing preferences cannot authorize a second writer
          // or forbid independent storage identities.
          if (Array.isArray(workspaceServices) && workspaceServices.length > 0) throw new WorkspaceValidationFailure(
            "Remote workspace storage does not support Core workspace services.", { reason: "remote_workspace_runtime_services_unsupported" });
          const source = sourceState.source;
          return {
            cwd: reusableExistingExecutionWorkspace?.cwd ?? `/workspaces/${run.id}`,
            source: "task_session" as const,
            projectId: remoteSourceState.value!.projectId, workspaceId: remoteSourceState.value!.projectWorkspaceId,
            repoUrl: source.kind === "git" ? source.repoUrl : null,
            repoRef: source.kind === "git" ? source.ref : null,
            workspaceHints: [], warnings: remoteSourceState.value.warnings ?? [], baseCwdFallback: false,
            materializationFailures: [], additionalWorkspaces: [],
            referencedProjectFailures: remoteSourceState.value.referencedProjectFailures ?? [],
          };
        }
      }
      if (controllerOnly) {
        // This is private controller storage, never a provider filesystem.
        // External providers receive workspace.access=none and cwd=null.
        const cwd = path.resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", providerApiPlacement ? "cursor-cloud-controllers" : (persistedNativeExecutionInput?.provider.kind ?? mergedConfig.provider) === "muse" ? "muse-controllers" : "dot-controllers", agent.companyId, ...(providerApiPlacement ? [agent.id, issueId ?? run.id] : [run.id]));
        await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
        return { cwd, source: "agent_home" as const, projectId: null, workspaceId: null, repoUrl: null, repoRef: null,
          workspaceHints: [], warnings: [], baseCwdFallback: false, materializationFailures: [], additionalWorkspaces: [], referencedProjectFailures: [] };
      }
      if (useIsolatedTaskDirectory && issueRef && !pluginTaskWorkspace) {
        // A completed fresh attempt becomes the current task directory. New
        // input reuses that binding; only another fresh attempt changes roots.
        let cwd: string;
        // RC-35: preparing the same fresh attempt again after a restart reuses
        // the attempt directory this run itself created and bound. Any other
        // binding still requires a new attempt directory.
        let ownFreshAttempt = false;
        try {
          if (reusableExistingExecutionWorkspace) {
            const [currentIssue] = await db.select({ workspaceId: issues.executionWorkspaceId }).from(issues)
              .where(and(eq(issues.id, issueRef.id), eq(issues.companyId, agent.companyId)));
            const stored = await executionWorkspacesSvc.getStoredById(agent.companyId, reusableExistingExecutionWorkspace.id);
            // A pure path check: the reuse validation below confirms the full
            // isolated-workspace-attempts/<company>/<issue>/<run> identity.
            ownFreshAttempt = fresh && Boolean(stored?.cwd) && path.basename(stored!.cwd!) === run.id &&
              path.basename(path.dirname(stored!.cwd!)) === issueRef.id &&
              path.basename(path.dirname(path.dirname(path.dirname(stored!.cwd!)))) === "isolated-workspace-attempts";
            if ((fresh && !ownFreshAttempt) || currentIssue?.workspaceId !== reusableExistingExecutionWorkspace.id ||
                reusableExistingExecutionWorkspace.companyId !== agent.companyId ||
                reusableExistingExecutionWorkspace.sourceIssueId !== issueRef.id ||
                reusableExistingExecutionWorkspace.mode !== "isolated_workspace" ||
                reusableExistingExecutionWorkspace.strategyType !== "project_primary" || !stored ||
                stored.companyId !== agent.companyId || stored.sourceIssueId !== issueRef.id ||
                stored.mode !== "isolated_workspace" || stored.strategyType !== "project_primary" ||
                stored.status !== "active" || stored.cwd !== reusableExistingExecutionWorkspace.cwd || !stored.cwd) {
              throw new Error("The saved task directory binding changed");
            }
          }
          cwd = await materializeIsolatedTaskDirectory({
            companyId: agent.companyId,
            issueId: issueRef.id,
            ...(fresh && !reusableExistingExecutionWorkspace ? { attemptId: run.id } : {}),
            ...(reusableExistingExecutionWorkspace ? { reuseCwd: reusableExistingExecutionWorkspace.cwd! } : {}),
          });
        } catch (error) {
          if (!reusableExistingExecutionWorkspace) throw error;
          // Liveness-first: the saved binding no longer matches. Keep using the saved
          // directory when its path is still this task's own directory, otherwise use
          // the task's directory (created if missing); never fail the run.
          warnWorkspace("isolated_task_directory_binding_mismatch", "the saved task directory binding changed; using the task's own directory.");
          const savedCwd = !fresh && reusableExistingExecutionWorkspace.cwd
            ? await materializeIsolatedTaskDirectory({ companyId: agent.companyId, issueId: issueRef.id,
              reuseCwd: reusableExistingExecutionWorkspace.cwd }).catch(() => null)
            : null;
          cwd = savedCwd ?? await materializeIsolatedTaskDirectory({ companyId: agent.companyId, issueId: issueRef.id,
            ...(fresh ? { attemptId: run.id } : {}) });
        }
        return resolveWorkspaceForRun(agent, context, previousSessionParams, {
          executionEnvironmentDriver: selectedEnvironmentForConfig?.driver ?? null,
                executionEnvironmentConfig: selectedEnvironmentForConfig?.config ?? null,
          anchorWorkspace: {
            cwd,
            source: "task_session",
            projectId: reusableExistingExecutionWorkspace?.projectId ?? null,
            workspaceId: reusableExistingExecutionWorkspace?.projectWorkspaceId ?? null,
            repoUrl: null,
            repoRef: null,
            // The verified task-directory branch keeps its saved physical
            // contract through the final Claude/Codex launch guard as well.
            localPathOnlyWorkspace: true,
            workspaceHints: [],
            warnings: [],
            baseCwdFallback: false,
            materializationFailures: [],
          },
        });
      }
      if (nativeChatWorkspaceScope && !nativeChatWorkspaceScope.projectId && !pluginTaskWorkspace) {
        const cwd = await materializeNativeChatTaskRoot(
          nativeChatWorkspaceScope,
        );
        return {
          cwd,
          source: "task_session" as const,
          projectId: null,
          workspaceId: null,
          repoUrl: null,
          repoRef: null,
          workspaceHints: [],
          warnings: [],
          baseCwdFallback: false,
          materializationFailures: [],
          additionalWorkspaces: [],
          referencedProjectFailures: [],
        };
      }
      const workspace = await resolveWorkspaceForRun(
        agent,
        context,
        previousSessionParams,
        {
          useProjectWorkspace:
            requestedExecutionWorkspaceMode !== "agent_default",
          configuredCwd: readNonEmptyString(mergedConfig.cwd),
          storageProviderPluginId: projectExecutionWorkspacePolicy?.storageProviderPluginId ?? null,
          anchorWorkspace: !pluginTaskWorkspace && requestedShouldReuseExisting && reusableExistingExecutionWorkspace?.strategyType === "git_worktree"
            ? await resolveReusedGitWorkspaceAnchor({
                agent,
                workspace: reusableExistingExecutionWorkspace,
                responsibleUserId,
                immutableNativeBinding: Boolean(nativeRecoveryExecutionWorkspaceId),
                projectId: nativeRecoveryExecutionWorkspaceId
                  ? reusableExistingExecutionWorkspace.projectId
                  : issueRef?.projectId ?? readNonEmptyString(context.projectId),
                explicitProjectWorkspaceId: nativeRecoveryExecutionWorkspaceId
                  ? reusableExistingExecutionWorkspace.projectWorkspaceId
                  : readNonEmptyString(context.projectWorkspaceId),
                issueId,
                runId: run.id,
              })
            : requestedShouldReuseExisting && reusableExistingExecutionWorkspace?.cwd ? {
                cwd: reusableExistingExecutionWorkspace.cwd, source: "task_session" as const,
                projectId: reusableExistingExecutionWorkspace.projectId,
                workspaceId: reusableExistingExecutionWorkspace.projectWorkspaceId,
                repoUrl: reusableExistingExecutionWorkspace.repoUrl, repoRef: reusableExistingExecutionWorkspace.baseRef,
                localPathOnlyWorkspace: reusableExistingExecutionWorkspace.strategyType === "project_primary" && !reusableExistingExecutionWorkspace.repoUrl && !reusableExistingExecutionWorkspace.branchName,
                workspaceHints: [], warnings: [], baseCwdFallback: false, materializationFailures: [],
              } : undefined,
          // Thread the selected environment driver so run-workspace resolution can tell a local
          // target from a remote one, and a confined sandbox target from an unconfined remote
          // target. A remote run resolves referenced projects only for the confined sandbox
          // transport with the remote flag on. This never changes the anchor workspace.
          executionEnvironmentDriver:
            selectedEnvironmentForConfig?.driver ?? null,
                executionEnvironmentConfig: selectedEnvironmentForConfig?.config ?? null,
        },
      );
      // Additional referenced projects are a separate trusted Board
      // capability, not extra readable roots for an external conversation.
      return nativeChatWorkspaceScope
        ? {
            ...workspace,
            additionalWorkspaces: [],
            runnerTaskProjectIds: undefined,
            referencedProjectFailures: [],
          }
        : workspace;
    },
  }));
  const remoteFresh = remoteAuthority && fresh ? await readFreshWorkspaceReadiness(db, run) : null;
  if (remoteAuthority && fresh && (remoteFresh?.mode !== "fresh_isolated_workspace"
    || input.task.freshWorkspace?.mode !== "fresh_isolated_workspace"
    || remoteFresh.retryIntentId !== input.task.freshWorkspace.retryIntentId
    || remoteFresh.sourceRunId !== input.task.freshWorkspace.sourceRunId)) {
    throw new WorkspaceValidationFailure("The committed fresh workspace recovery authorization changed.",
      { reason: "remote_workspace_fresh_authorization_changed" });
  }
  const remoteFreshBinding = remoteFresh?.mode === "fresh_isolated_workspace"
    ? (await db.select({ workspaceId: issues.executionWorkspaceId, revision: issues.workspaceBindingRevision }).from(issues)
      .where(and(eq(issues.companyId, agent.companyId), eq(issues.id, issueId!))))[0] : null;
  if (remoteFresh && !remoteFreshBinding) throw new Error("remote_workspace_task_binding_missing");
  const hostProvisionDriver = selectedEnvironmentForConfig?.driver ?? lowTrustPreflightEnvironmentDriver;
  let providerFresh: PluginFreshWorkspace | undefined;
  let previousProviderWorkspaceId: string | null = null;
  let previousProviderBindingRevision = 0;
  if (input.task.freshWorkspace?.mode === "fresh_isolated_workspace" && !controllerOnly && issueId) {
    const [task] = await db.select({ workspaceId: issues.executionWorkspaceId, revision: issues.workspaceBindingRevision }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)));
    previousProviderWorkspaceId = task?.workspaceId ?? null;
    previousProviderBindingRevision = task?.revision ?? 0;
    const [previous] = previousProviderWorkspaceId ? await db.select().from(executionWorkspacesTable)
      .where(and(eq(executionWorkspacesTable.id, previousProviderWorkspaceId), eq(executionWorkspacesTable.companyId, agent.companyId))) : [];
    if (pluginTaskWorkspace || previous?.providerType === "plugin" ||
        (resolvedWorkspace.workspaceId && projectExecutionWorkspacePolicy?.storageProviderPluginId)) {
      const saved = freshWorkspaceSchema.safeParse(previous?.metadata?.workspaceProviderFresh ?? previous?.metadata?.runnerTaskFreshWorkspace);
      providerFresh = saved.success && saved.data.attemptId === input.task.freshWorkspace.retryIntentId ? saved.data :
        await stageProviderFreshWorkspace({ db, companyId: agent.companyId, issueId,
          attemptId: input.task.freshWorkspace.retryIntentId, sourceRunId: input.task.freshWorkspace.sourceRunId,
          previousWorkspaceId: previousProviderWorkspaceId });
    }
  }
  const assertAllowedEnvironment = (environment: Environment) => {
    const allowlistDecision = evaluateExecutionAllowlist(executionPolicy, {
      driver: environment.driver,
      provider:
        typeof environment.config?.provider === "string"
          ? environment.config.provider
          : null,
    });
    if (!allowlistDecision.allowed) {
      logger.error(
        {
          runId: run.id,
          issueId,
          agentId: agent.id,
          environmentId: environment.id,
          deniedDriver: allowlistDecision.deniedDriver,
          deniedProvider: allowlistDecision.deniedProvider,
        },
        "Execution allowlist denied the resolved environment; failing run",
      );
      throw new Error(allowlistDecision.reason);
    }
  };
  const refused = parseObject(context.retryWorkspaceRefusal);
  const refusedWorkspaceId = fresh && input.task.freshWorkspace?.mode === "fresh_isolated_workspace" &&
    refused.intentId === input.task.freshWorkspace.retryIntentId && typeof refused.workspaceId === "string"
    ? refused.workspaceId : undefined;
  const priorVerificationLease = refusedWorkspaceId && selectedEnvironmentForConfig && typeof refused.leaseId === "string"
    ? (await db.select().from(environmentLeases).where(and(
        eq(environmentLeases.id, refused.leaseId), eq(environmentLeases.companyId, agent.companyId), eq(environmentLeases.heartbeatRunId, run.id),
        eq(environmentLeases.environmentId, selectedEnvironmentForConfig.id), eq(environmentLeases.executionWorkspaceId, refusedWorkspaceId),
      )))[0] : undefined;
  if (refusedWorkspaceId && typeof refused.leaseId === "string" && !priorVerificationLease)
    throw new Error("Workspace verification lease changed");
  const releaseVerificationLease = async (leaseId: string) => {
    await controllerLease.assertOwned();
    await envOrchestrator.releaseForRun({ companyId: agent.companyId, agentId: agent.id, heartbeatRunId: run.id });
    const [lease] = await db.select({ status: environmentLeases.status, releasedAt: environmentLeases.releasedAt,
      cleanupStatus: environmentLeases.cleanupStatus }).from(environmentLeases).where(and(
      eq(environmentLeases.id, leaseId), eq(environmentLeases.companyId, agent.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
    if (!lease?.releasedAt || !["released", "expired"].includes(lease.status) || lease.cleanupStatus !== "success")
      throw new Error("Workspace verification lease cleanup is pending");
  };
  if (priorVerificationLease && (!priorVerificationLease.releasedAt || priorVerificationLease.cleanupStatus !== "success"))
    await releaseVerificationLease(priorVerificationLease.id);
  const retryCandidate = input.task.retryWorkspaceCandidate;
  const environmentAcquisitionInput = (
    persistedExecutionWorkspace: Parameters<typeof envOrchestrator.acquireForRun>[0]["persistedExecutionWorkspace"],
    projectId: string | null,
    additionalWorkspaces: { projectId?: string | null }[] | undefined,
  ) => ({
    companyId: agent.companyId,
    selectedEnvironmentId: selectedEnvironmentId ?? localEnvironment.id,
    localEnvironmentId: localEnvironment.id,
    adapterType: agent.adapterType,
    adapterConfig: parseObject(agent.adapterConfig),
    admittedLifecycleMode: persistedNativeExecutionInput?.session.lifecyclePolicy.mode,
    managedAiCredentialIdentity: input.config.managedAiCredentialIdentity,
    runnerTaskResumeSessionId: input.config.runnerTaskResumeSessionId,
    runnerTaskProjectIds: [...new Set([projectId, ...resolvedWorkspace.runnerTaskProjectIds ?? [],
      ...(additionalWorkspaces ?? []).map(workspace => workspace.projectId)]
      .filter((id): id is string => Boolean(id)))],
    recoverPluginTask: !priorVerificationLease && !portablePreparationLeaseId &&
      !(retryCandidate && restartRecovery?.kind === "bootstrap_incomplete") &&
      (restartRecovery?.kind === "resume_dead_runner" || restartRecovery?.kind === "bootstrap_incomplete"),
    issueId: issueId ?? null,
    heartbeatRunId: run.id,
    agentId: agent.id,
    persistedExecutionWorkspace,
    ...(priorVerificationLease && persistedExecutionWorkspace && persistedExecutionWorkspace.id !== refusedWorkspaceId
      ? { replacementWorkspaceCreation: persistedExecutionWorkspace.id } : {}),
    executionWorkspaceSettings: environmentExecutionWorkspaceSettings,
  });
  const pluginRecovery = restartRecovery?.kind === "reattach_remote_runner" && restartRecovery.remote.kind === "plugin_task"
    ? restartRecovery.remote : portablePreparationLeaseId && portablePreparationLeaseId !== priorVerificationLease?.id
      ? { kind: "plugin_task" as const, leaseId: portablePreparationLeaseId, preparation: true as const } : undefined;
  let workspaceAcquisition: Awaited<ReturnType<typeof envOrchestrator.acquireForRun>> | undefined;
  let workspaceAcquireStartedAtMs: number | undefined;
  let ensureTaskWorkspace: ((taskId: string, assertOwned: () => void) => Promise<void> | undefined) | undefined;
  const acquireTaskLease: NonNullable<Parameters<typeof preparePluginWorkspace>[2]["acquireTaskLease"]> = async workspace => {
    if (workspaceAcquisition) {
      const { environment, lease } = workspaceAcquisition;
      if (lease.executionWorkspaceId !== workspace.id || typeof lease.metadata?.driverKey !== "string" || !lease.providerLeaseId)
        throw new Error("Workspace placement changed");
      return { leaseId: lease.id, taskLease: { environmentId: environment.id, driverKey: lease.metadata.driverKey, providerLeaseId: lease.providerLeaseId } };
    }
    if (!selectedEnvironmentForConfig) throw new Error("Workspace placement is unavailable");
    assertAllowedEnvironment(selectedEnvironmentForConfig);
    await controllerLease.assertOwned();
    workspaceAcquireStartedAtMs = Date.now();
    if (restartRecovery?.kind === "reattach_remote_runner" && restartRecovery.runId !== run.id)
      throw remoteRecoveryLeaseMismatch("workspace_preparation", "run_id");
    const acquisition = await timeWorkspace("workspace_environment_acquire", () => envOrchestrator.acquireForRun({
      ...environmentAcquisitionInput(workspace, resolvedWorkspace.projectId, resolvedWorkspace.additionalWorkspaces),
      ...(pluginRecovery ? { reattachRemoteLease: pluginRecovery } : {}),
    }));
    await controllerLease.assertOwned();
    if (retryCandidate) {
      const metadata = acquisition.lease.metadata;
      if (metadata?.runnerTaskDispatched === true || metadata?.runnerTaskIdentity ||
          metadata?.runnerTaskStartup || metadata?.runnerTaskStartupCleanup || metadata?.runnerTaskRetiring === true)
        throw new Error("Workspace verification lease already started execution");
      workspaceAcquisition = acquisition;
      return acquireTaskLease(workspace);
    }
    const placement = await envOrchestrator.confirmWorkspaceTaskPlacement(acquisition, {
      companyId: agent.companyId, environmentId: selectedEnvironmentForConfig.id, workspaceId: workspace.id, signal: input.signal,
    });
    await controllerLease.assertOwned();
    workspaceAcquisition = placement.acquisition;
    return { leaseId: placement.acquisition.lease.id, taskLease: placement.taskLease };
  };
  const pluginPrepareInput: Parameters<typeof preparePluginWorkspace>[2] = {
    companyId: agent.companyId, projectId: resolvedWorkspace.projectId, projectWorkspaceId: resolvedWorkspace.workspaceId,
    issueId, runId: run.id, agentId: agent.id, responsibleUserId,
    existingWorkspaceId: providerFresh ? providerFresh.previousWorkspaceId : reusableExistingExecutionWorkspace?.id ?? issueRef?.executionWorkspaceId ?? null,
    ...(providerFresh ? { fresh: providerFresh, expectedBindingRevision: previousProviderBindingRevision } : {}),
    selectedProviderPluginId: projectExecutionWorkspacePolicy?.storageProviderPluginId ?? null,
    environment: selectedEnvironmentForConfig,
    acquireTaskLease,
    onTaskPrepared: ensure => { ensureTaskWorkspace = ensure; },
    mode: requestedExecutionWorkspaceMode,
    strategy: resolveEffectiveWorkspaceStrategyType(requestedExecutionWorkspaceMode, mergedConfig),
    branchMode: typeof parseObject(mergedConfig.workspaceStrategy).existingBranch === "string" ? "existing" : "create",
    branchName: typeof parseObject(mergedConfig.workspaceStrategy).existingBranch === "string"
      ? String(parseObject(mergedConfig.workspaceStrategy).existingBranch)
      : resolveEffectiveWorkspaceStrategyType(requestedExecutionWorkspaceMode, mergedConfig) === "git_worktree" ? sanitizeBranchName(renderWorkspaceTemplate(String(parseObject(mergedConfig.workspaceStrategy).branchTemplate ?? "{{issue.identifier}}-{{slug}}"), {
        issue: issueRef, agent, projectId: resolvedWorkspace.projectId, repoRef: resolvedWorkspace.repoRef,
      })) : null,
    baseRef: typeof parseObject(mergedConfig.workspaceStrategy).baseRef === "string"
      ? String(parseObject(mergedConfig.workspaceStrategy).baseRef) : null,
  };
  if (retryCandidate && !controllerOnly && !remoteAuthority) {
    const verified = await timeWorkspace("workspace_verification", () => preparePluginWorkspace(db, input.services.workspaceWorkers, {
      ...pluginPrepareInput,
      existingWorkspaceId: retryCandidate.workspaceId,
      verifyExisting: true,
      assertOwned: () => input.signal?.throwIfAborted(),
      onTaskPrepared: undefined,
    })).catch(error => {
      const failure = findWorkspaceProviderFailure(error);
      if (failure?.reason !== "binding_mismatch" && failure?.reason !== "unsupported_operation") throw error;
      return null;
    });
    await controllerLease.assertOwned();
    if (!verified) {
      const refusal = { intentId: retryCandidate.retryIntentId, workspaceId: retryCandidate.workspaceId,
        leaseId: workspaceAcquisition?.lease.id ?? null };
      const [saved] = await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb)
        || ${JSON.stringify({ retryWorkspaceRefusal: refusal })}::jsonb` })
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.status, "running")))
        .returning({ id: heartbeatRuns.id });
      if (!saved) throw new Error("Workspace verification lost run ownership");
      context.retryWorkspaceRefusal = refusal;
      if (workspaceAcquisition) await releaseVerificationLease(workspaceAcquisition.lease.id);
      throw new RetryWorkspaceRefused();
    }
    await recordVerifiedRetryWorkspace(db, run, issueId!, retryCandidate);
    if (workspaceAcquisition && selectedEnvironmentForConfig) {
      const providerLeaseId = workspaceAcquisition.lease.providerLeaseId;
      const placement = await envOrchestrator.confirmWorkspaceTaskPlacement(workspaceAcquisition, {
        companyId: agent.companyId, environmentId: selectedEnvironmentForConfig.id, workspaceId: retryCandidate.workspaceId, signal: input.signal,
      });
      if (placement.acquisition.lease.providerLeaseId !== providerLeaseId)
        throw new Error("Workspace placement changed after verification");
      workspaceAcquisition = placement.acquisition;
    }
  }
  const pluginPrepared = sessionOnly || managedWorkspace || controllerOnly || remoteAuthority || remoteWorkerHost ? null : await preparePluginWorkspace(db, input.services.workspaceWorkers, pluginPrepareInput);

  const freshTaskReservationId = providerFresh && pluginTaskWorkspace && !pluginPrepared && issueId
    ? await reserveFreshPluginTaskWorkspace({ db, companyId: agent.companyId, issueId, runId: run.id, agentId: agent.id,
        fresh: providerFresh, responsibleUserId, expectedBindingRevision: previousProviderBindingRevision, owner: taskWorkspaceOwner!,
        source: { projectId: resolvedWorkspace.projectId, projectWorkspaceId: resolvedWorkspace.workspaceId,
          repoUrl: resolvedWorkspace.repoUrl, baseRef: resolvedWorkspace.repoRef } }) : null;
  const freshTaskReservation = freshTaskReservationId ? await executionWorkspacesSvc.getStoredById(agent.companyId, freshTaskReservationId) : null;
  const copyOnlyProvisioning = sessionOnly || pluginPrepared || remoteAuthority || remoteWorkerHost ? true : await timeWorkspace("workspace_provision_policy", () => workspaceRequiresCopyOnlyProvisioning(db, {
    companyId: agent.companyId,
    task: issueRef ? { ...issueRef, workspaceSelection: input.task.workspaceSelection } : null,
    sourceProjectId: resolvedWorkspace.projectId,
    sourceWorkspaceId: resolvedWorkspace.workspaceId,
    boundWorkspace: reusableExistingExecutionWorkspace ?? existingExecutionWorkspace,
  }));
  const skipHostProvision = sessionOnly || Boolean(managedWorkspace) || copyOnlyProvisioning || hostProvisionDriver === "sandbox" || hostProvisionDriver === "ssh" || hostProvisionDriver === "plugin";
  const hostExecutionWorkspaceConfig = controllerOnly || sessionOnly ? {} :
    stripHostWorkspaceProvision({
      config: fresh && !remoteAuthority ? { ...mergedConfig, workspaceStrategy: { type: "project_primary" } } : mergedConfig,
      skipHostProvision,
    });
  const executionWorkspaceBase = {
    baseCwd: resolvedWorkspace.cwd,
    source: resolvedWorkspace.source,
    projectId: resolvedWorkspace.projectId,
    workspaceId: resolvedWorkspace.workspaceId,
    repoUrl: resolvedWorkspace.repoUrl,
    repoRef: resolvedWorkspace.repoRef,
    additionalWorkspaces: resolvedWorkspace.additionalWorkspaces,
  } satisfies ExecutionWorkspaceInput;
  const latestWorkspaceStrategyType = resolveEffectiveWorkspaceStrategyType(requestedExecutionWorkspaceMode, hostExecutionWorkspaceConfig);
  if (pluginTaskWorkspace && !pluginPrepared && latestWorkspaceStrategyType === "git_worktree") {
    throw new WorkspaceValidationFailure("The selected plugin environment does not support Core Git worktree preparation.",
      { reason: "plugin_workspace_strategy_unsupported" });
  }
  if (!sessionOnly && !managedWorkspace && !pluginPrepared && !remoteAuthority && !remoteWorkerHost) await timeWorkspace("workspace_base_validation", () => assertGitWorktreeBaseWorkspaceReady({
    requestedExecutionWorkspaceMode,
    // Restoration below uses the persisted realization, including Recovery copies.
    // Validate that same strategy; today's isolated default must not turn an
    // existing local directory into a Git worktree before restoration is reached.
    // Keep latest configuration intact for drift diagnostics and new admissions.
    config: requestedShouldReuseExisting && !fresh && issueRef?.projectId && issueRef.projectWorkspaceId &&
      reusableExistingExecutionWorkspace?.sourceIssueId === issueId &&
      reusableExistingExecutionWorkspace.companyId === agent.companyId &&
      reusableExistingExecutionWorkspace.projectId === issueRef.projectId &&
      reusableExistingExecutionWorkspace.projectWorkspaceId === issueRef.projectWorkspaceId &&
      reusableExistingExecutionWorkspace.mode === "isolated_workspace" &&
      reusableExistingExecutionWorkspace.providerType === "local_fs" &&
      reusableExistingExecutionWorkspace.strategyType === "project_primary" &&
      reusableExistingExecutionWorkspace.metadata?.[CONTROLLER_PROVISION_COPY_ONLY] === true &&
      !reusableExistingExecutionWorkspace.repoUrl && !reusableExistingExecutionWorkspace.baseRef &&
      !reusableExistingExecutionWorkspace.branchName
      ? { ...hostExecutionWorkspaceConfig, workspaceStrategy: {
          ...parseObject(hostExecutionWorkspaceConfig.workspaceStrategy),
          type: reusableExistingExecutionWorkspace.strategyType,
        } }
      : hostExecutionWorkspaceConfig,
    issue: issueRef,
    base: executionWorkspaceBase,
    anchor: {
      baseCwdFallback: resolvedWorkspace.baseCwdFallback,
      materializationFailures: resolvedWorkspace.materializationFailures,
      localPathOnlyWorkspace: resolvedWorkspace.localPathOnlyWorkspace,
    },
  }));
  const workspaceStrategyForFingerprint = parseObject(
    hostExecutionWorkspaceConfig.workspaceStrategy,
  );
  const workspaceStrategyFingerprintValue =
    Object.keys(workspaceStrategyForFingerprint).length > 0
      ? workspaceStrategyForFingerprint
      : null;
  const selectedEnvironmentConfigForFingerprint = parseObject(
    selectedEnvironmentForConfig?.config,
  );
  const workspaceEnvironmentFingerprint = selectedEnvironmentForConfig
    ? {
        selectionSource: environmentResolution.source,
        selectedEnvironmentId,
        driver: selectedEnvironmentForConfig.driver,
        provider: readNonEmptyString(
          selectedEnvironmentConfigForFingerprint.provider,
        ),
        config: selectedEnvironmentForConfig.config,
        configRevisionAt:
          selectedEnvironmentForConfig.updatedAt instanceof Date
            ? selectedEnvironmentForConfig.updatedAt.toISOString()
            : (selectedEnvironmentForConfig.updatedAt ?? null),
        executionPolicy,
      }
    : null;
  const workspaceRealizationFingerprint = {
    environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
    environmentProvider: readNonEmptyString(
      selectedEnvironmentConfigForFingerprint.provider,
    ),
    trustPreset: trustPreset.kind,
    lowTrustSandboxDriver: lowTrustPreflightEnvironmentDriver,
  };
  // Every host-backed task claims its actual writing directory, irrespective of
  // adapter, project or shared/isolated presentation mode. Remote storage and
  // plugin-owned workspaces keep their native writer/lease authority below.
  const hostPathAdmission = Boolean(issueId && !sessionOnly && !remoteAuthority && !pluginTaskWorkspace
    && !pluginPrepared && !controllerOnly && !pmCoordination && !providerApiPlacement
    && hostProvisionDriver !== "sandbox");
  const claimHost = managedMarker?.hostId ?? remoteWorkerHost ?? fixedBinding?.hostId ?? null;
  const claimExecutionDirectory = async (cwd: string, preparingWorktree = false, recordedRecovery = false) => {
    if (!hostPathAdmission) return;
    await controllerLease.assertOwned();
    await claimSharedCheckout(db, {
      companyId: agent.companyId, agentId: agent.id, runId: run.id, issueId: issueId!,
      projectWorkspaceId: reviewHome ? executionWorkspaceBase.workspaceId : issueRef?.projectWorkspaceId ?? null, cwd,
      remoteHostId: claimHost, preparingWorktree, wasIssueAssignee: input.task.wasIssueAssignee,
      requireGit: !recordedRecovery && !preparingWorktree && !claimHost && Boolean(executionWorkspaceBase.repoUrl || executionWorkspaceBase.repoRef),
      checkSourceHandoff: agent.runtimeConfig?.requireProjectWorkspace === true
        && effectiveExecutionWorkspaceMode === "shared_workspace",
      deferralAttempt: run.scheduledRetryReason === WORKSPACE_BUSY_RETRY_REASON ? run.scheduledRetryAttempt ?? 0 : 0,
      context,
    });
  };
  const workspaceFreshnessSource = resolvedWorkspace.freshnessSource ?? executionWorkspaceBase;
  const latestWorkspaceConfigMetadata =
    buildEffectiveRunWorkspaceConfigMetadata({
      mode: requestedExecutionWorkspaceMode,
      projectId: workspaceFreshnessSource.projectId,
      projectWorkspaceId: workspaceFreshnessSource.workspaceId,
      strategyType: latestWorkspaceStrategyType,
      workspaceStrategy: workspaceStrategyFingerprintValue,
      repoUrl: workspaceFreshnessSource.repoUrl,
      repoRef:
        readNonEmptyString(workspaceStrategyForFingerprint.baseRef) ??
        workspaceFreshnessSource.repoRef,
      configSnapshot,
      environment: workspaceEnvironmentFingerprint,
      realization: workspaceRealizationFingerprint,
      secretManifest,
    });
  const inferredExistingWorkspaceConfigMetadata =
    reusableExistingExecutionWorkspace
      ? buildEffectiveRunWorkspaceConfigMetadata({
          mode: issueExecutionWorkspaceModeForPersistedWorkspace(
            reusableExistingExecutionWorkspace.mode,
          ),
          projectId: reusableExistingExecutionWorkspace.projectId,
          projectWorkspaceId:
            reusableExistingExecutionWorkspace.projectWorkspaceId,
          strategyType: reusableExistingExecutionWorkspace.strategyType,
          workspaceStrategy: workspaceStrategyFingerprintValue
            ? {
                ...workspaceStrategyFingerprintValue,
                type: reusableExistingExecutionWorkspace.strategyType,
                ...(reusableExistingExecutionWorkspace.baseRef
                  ? { baseRef: reusableExistingExecutionWorkspace.baseRef }
                  : {}),
              }
            : { type: reusableExistingExecutionWorkspace.strategyType },
          repoUrl: reusableExistingExecutionWorkspace.repoUrl,
          repoRef: reusableExistingExecutionWorkspace.baseRef,
          configSnapshot: reusableExistingExecutionWorkspace.config,
          environment: workspaceEnvironmentFingerprint,
          realization: workspaceRealizationFingerprint,
          secretManifest,
          evaluatedAt: latestWorkspaceConfigMetadata.evaluatedAt,
        })
      : null;
  const workspaceConfigFreshness = resolveExecutionWorkspaceConfigFreshness(
    {
      hasExistingWorkspace:
        requestedShouldReuseExisting &&
        Boolean(reusableExistingExecutionWorkspace),
      existingWorkspaceMetadata:
        reusableExistingExecutionWorkspace?.metadata ?? null,
      inferredMetadata: inferredExistingWorkspaceConfigMetadata,
      nextMetadata: latestWorkspaceConfigMetadata,
      providerOwnedStorage: Boolean(pluginPrepared),
    },
  );
  const workspaceReuseProvisioningPolicy =
    resolveExecutionWorkspaceReuseProvisioningPolicy({
      requestedShouldReuseExisting,
      workspaceConfigFreshness,
    });
  if (pluginTaskWorkspace && !pluginPrepared && workspaceReuseProvisioningPolicy.shouldRestoreExistingWorkspace
    && reusableExistingExecutionWorkspace?.strategyType === "git_worktree") {
    throw new WorkspaceValidationFailure("The selected plugin environment cannot reuse a Core Git worktree.",
      { reason: "plugin_workspace_strategy_unsupported" });
  }
  const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
    companyId: agent.companyId,
    heartbeatRunId: run.id,
    executionWorkspaceId:
      workspaceReuseProvisioningPolicy.shouldRestoreExistingWorkspace
        ? workspaceReuseRequest.requestedExecutionWorkspaceId
        : null,
    issueId,
  });
  // The run-scoped provider resolves the active identity at each Git operation,
  // including base-ref refreshes, workspace realization, and restore.
  const workspaceGitAuthProvider = createGitRemoteAuthProvider(
    db,
    agent.companyId,
    {
      issueId,
      heartbeatRunId: run.id,
      responsibleUserId: run.responsibleUserId,
      agentId: agent.id,
    },
  );
  if (freshNeedsSeed && issueId && !pluginPrepared && !pluginTaskWorkspace && !remoteAuthority && !remoteWorkerHost) {
    await controllerLease.assertOwned();
    const verifySourceAccess = async () => {
      await assertTaskWorkspaceExecutionAccess(db, {
        type: "agent", source: "agent_jwt", companyId: agent.companyId,
        agentId: agent.id, runId: run.id,
        onBehalfOfUserId: responsibleUserId === "local-board" ? null : responsibleUserId,
      }, agent.companyId, { issueId });
    };
    const cwd = await materializeFreshWorkspaceSeed({
      companyId: agent.companyId, issueId, runId: run.id, sourceCwd: executionWorkspaceBase.baseCwd,
      repoUrl: executionWorkspaceBase.repoUrl,
      baseRef: readNonEmptyString(parseObject(mergedConfig.workspaceStrategy).baseRef) ?? executionWorkspaceBase.repoRef,
      beforeCopy: verifySourceAccess,
    });
    await verifySourceAccess();
    executionWorkspaceBase.baseCwd = cwd;
    resolvedWorkspace.cwd = cwd;
    await controllerLease.assertOwned();
  }
  // Claim before restore/provision can write. New worktrees reserve their target
  // through the runtime callback, never the common source checkout.
  if (latestWorkspaceStrategyType !== "git_worktree") {
    await claimExecutionDirectory(
      workspaceReuseProvisioningPolicy.shouldRestoreExistingWorkspace && reusableExistingExecutionWorkspace?.cwd
        ? reusableExistingExecutionWorkspace.cwd : resolvedWorkspace.cwd,
    );
  }
  const {
    executionWorkspace,
    reusedExecutionWorkspace,
    policy: resolvedWorkspaceReusePolicy,
  } = managedWorkspace ? {
    executionWorkspace: { ...executionWorkspaceBase, strategy: "git_worktree" as const, cwd: managedWorkspace.cwd!,
      branchName: managedMarker?.branch ?? managedWorkspace.branchName, worktreePath: managedWorkspace.cwd!, warnings: [], created: false, branchCreatedByRuntime: false } as RealizedExecutionWorkspace,
    reusedExecutionWorkspace: true,
    policy: { ...workspaceReuseProvisioningPolicy, shouldRestoreExistingWorkspace: true, shouldRefreshWorkspaceConfigSnapshot: false,
      shouldPersistLatestWorkspaceConfigMetadata: false },
  } : fixedBinding || remoteWorkerHost ? {
    executionWorkspace: { ...executionWorkspaceBase, strategy: "project_primary" as const, cwd: resolvedWorkspace.cwd, branchName: null, worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false } as RealizedExecutionWorkspace,
    reusedExecutionWorkspace: Boolean((fixedBinding || remoteWorkerHost) && workspaceReuseProvisioningPolicy.shouldRestoreExistingWorkspace && reusableExistingExecutionWorkspace?.cwd === resolvedWorkspace.cwd && reusableExistingExecutionWorkspace.strategyType === "project_primary"),
    policy: { ...workspaceReuseProvisioningPolicy, shouldRestoreExistingWorkspace: Boolean((fixedBinding || remoteWorkerHost) && workspaceReuseProvisioningPolicy.shouldRestoreExistingWorkspace && reusableExistingExecutionWorkspace?.cwd === resolvedWorkspace.cwd && reusableExistingExecutionWorkspace.strategyType === "project_primary") },
  } : pluginPrepared ? { executionWorkspace: { ...executionWorkspaceBase,
    providerBinding: readWorkspaceProviderBinding(pluginPrepared.metadata)!,
    strategy: pluginPrepared.strategyType as "git_worktree" | "project_primary",
    cwd: `/workspaces/${pluginPrepared.id}`, branchName: pluginPrepared.branchName, worktreePath: null,
    warnings: [], created: false, branchCreatedByRuntime: false,
    baseRefSha: pluginPrepared.metadata?.workspaceProviderBaseSha as string | null,
  } as RealizedExecutionWorkspace, reusedExecutionWorkspace: Boolean(reusableExistingExecutionWorkspace), policy: workspaceReuseProvisioningPolicy }
    : controllerOnly || pluginTaskWorkspace || remoteAuthority ? { executionWorkspace: { ...executionWorkspaceBase, strategy: pluginTaskWorkspace || remoteAuthority ? latestWorkspaceStrategyType : "project_primary" as const, cwd: freshTaskReservation?.cwd ?? resolvedWorkspace.cwd, branchName: remoteSourceState.value?.source.kind === "git" ? remoteSourceState.value!.source.branchName ?? null : null, worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false } as RealizedExecutionWorkspace, reusedExecutionWorkspace: (pluginTaskWorkspace || remoteAuthority) && workspaceReuseProvisioningPolicy.shouldRestoreExistingWorkspace && Boolean(reusableExistingExecutionWorkspace), policy: workspaceReuseProvisioningPolicy } : await timeWorkspace("workspace_provision", () => provisionExecutionWorkspaceForFreshnessDecision<RealizedExecutionWorkspace>(
    {
      requestedShouldReuseExisting,
      existingExecutionWorkspaceId:
        workspaceReuseRequest.requestedExecutionWorkspaceId,
      issueRef,
      runId: run.id,
      workspaceConfigFreshness,
      restoreExistingWorkspace: reusableExistingExecutionWorkspace
        ? () =>
            ensurePersistedExecutionWorkspaceAvailable({
              beforeSourceCopy: (_source, target) => claimExecutionDirectory(target, true),
              prepareRestoredLocalSource: issueId ? sourceCwd => executionWorkspacesSvc.prepareConfiguredRepositoryCopy({
                companyId: agent.companyId, issueId, workspaceId: reusableExistingExecutionWorkspace.id,
                cwd: reusableExistingExecutionWorkspace.cwd!, agentId: agent.id, runId: run.id, sourceCwd,
              }) : undefined,
              skipHostProvision,
              db,
              base: executionWorkspaceBase,
              workspace: {
                id: reusableExistingExecutionWorkspace.id,
                mode: reusableExistingExecutionWorkspace.mode,
                strategyType:
                  reusableExistingExecutionWorkspace.strategyType,
                cwd: reusableExistingExecutionWorkspace.cwd,
                providerRef: reusableExistingExecutionWorkspace.providerRef,
                projectId: reusableExistingExecutionWorkspace.projectId,
                projectWorkspaceId:
                  reusableExistingExecutionWorkspace.projectWorkspaceId,
                repoUrl: reusableExistingExecutionWorkspace.repoUrl,
                baseRef: reusableExistingExecutionWorkspace.baseRef,
                branchName: reusableExistingExecutionWorkspace.branchName,
                metadata:
                  reusableExistingExecutionWorkspace.metadata as Record<
                    string,
                    unknown
                  > | null,
                config: {
                  provisionCommand:
                    configSnapshot?.provisionCommand ??
                    reusableExistingExecutionWorkspace.config
                      ?.provisionCommand ??
                    projectExecutionWorkspacePolicy?.workspaceStrategy
                      ?.provisionCommand ??
                    null,
                  runtimeProvisionCommand:
                    configSnapshot?.runtimeProvisionCommand ??
                    reusableExistingExecutionWorkspace.config
                      ?.runtimeProvisionCommand ??
                    projectExecutionWorkspacePolicy?.workspaceStrategy
                      ?.runtimeProvisionCommand ??
                    null,
                },
              },
              issue: issueRef,
              agent: {
                id: agent.id,
                name: agent.name,
                companyId: agent.companyId,
              },
              heartbeatRunId: run.id,
              enableWorkspaceBranchReconcileForward:
                resolvedInstanceSettings.experimental
                  .enableWorkspaceBranchReconcileForward,
              enableWorkspaceDirtyQuarantineRepair:
                resolvedInstanceSettings.experimental
                  .enableWorkspaceDirtyQuarantineRepair,
              recorder: workspaceOperationRecorder,
              resolveGitAuth: workspaceGitAuthProvider,
            })
        : null,
      realizeWorkspace: () =>
        realizeExecutionWorkspace({
          beforeSourceCopy: (_source, target) => claimExecutionDirectory(target, true),
          skipHostProvision,
          db,
          base: executionWorkspaceBase,
          config: hostExecutionWorkspaceConfig,
          issue: issueRef,
          agent: {
            id: agent.id,
            name: agent.name,
            companyId: agent.companyId,
          },
          recordedBranchOwnership:
            existingExecutionWorkspace?.status !== "archived" &&
            existingExecutionWorkspace?.branchName
              ? {
                  branchName: existingExecutionWorkspace.branchName,
                  createdByRuntime: isRuntimeOwnedGitBranch(
                    existingExecutionWorkspace.metadata,
                  ),
                }
              : null,
          heartbeatRunId: run.id,
          enableWorkspaceBranchReconcileForward:
            resolvedInstanceSettings.experimental
              .enableWorkspaceBranchReconcileForward,
          enableWorkspaceDirtyQuarantineRepair:
            resolvedInstanceSettings.experimental
              .enableWorkspaceDirtyQuarantineRepair,
          recorder: workspaceOperationRecorder,
          resolveGitAuth: workspaceGitAuthProvider,
        }),
    },
  ));
  // Revalidate canonical identity after materialization and before repository
  // setup or provider launch. Failed realization never falls back to the source.
  await claimExecutionDirectory(executionWorkspace.cwd);
  if (hostPathAdmission && effectiveExecutionWorkspaceMode === "isolated_workspace"
    && executionWorkspace.strategy !== "git_worktree" && !fresh && !useIsolatedTaskDirectory
    && executionWorkspace.cwd === executionWorkspaceBase.baseCwd
    && executionWorkspace.source !== "task_session") {
    warnWorkspace("isolated_workspace_not_realized", "the isolated selection reuses the base directory.");
  }
  if (!managedWorkspace && agent.runtimeConfig?.requireTaskWorktree === true && (
    executionWorkspace.strategy !== "git_worktree" || !executionWorkspace.worktreePath ||
    executionWorkspace.cwd === executionWorkspaceBase.baseCwd
  )) {
    warnWorkspace("shared_worker_worktree_not_realized", "the shared worker runs without an isolated Git worktree.");
  }
  if (!remoteAuthority && input.task.freshWorkspace?.mode === "fresh_isolated_workspace" && issueId) {
    const recoveredFiles = providerFresh ? providerFresh.recoverySnapshots.map(snapshot => ({
      operationId: snapshot.operationId, sourceRunId: snapshot.sourceRunId,
      path: `.paperclip-recovered/${snapshot.operationId}`,
    })) : (await attachPreservedWorkspaceSnapshots({ db, companyId: agent.companyId,
      issueId, sourceRunIds: [input.task.freshWorkspace.sourceRunId], cwd: executionWorkspace.cwd }))
      .map(snapshot => ({ ...snapshot, path: path.relative(executionWorkspace.cwd, snapshot.path) }));
    context.recoveredWorkspaceFiles = recoveredFiles;
    // R2: never drop the previous attempt's files silently. Its directory stays
    // as it was; tell the agent where it is and what it had changed.
    const priorWorkspace = providerFresh ? null : await describeRetainedPriorWorkspace(db, { companyId: agent.companyId,
      issueId, sourceRunId: input.task.freshWorkspace.sourceRunId, successorRunId: run.id, freshCwd: executionWorkspace.cwd });
    if (priorWorkspace) context.priorWorkspace = priorWorkspace;
    const continuation = context.executionContinuation as import("@paperclipai/shared").ExecutionContinuationEnvelope | null;
    if (continuation) {
      continuation.recoveredFiles = recoveredFiles;
      if (priorWorkspace) continuation.priorWorkspace = priorWorkspace;
      // The wake was assembled before filesystem preparation. Update that same
      // server-authored envelope so every adapter receives the verified paths.
      const wake = context.paperclipWake as Record<string, unknown> | undefined;
      if (wake) wake.executionContinuation = continuation;
    }
  }
  const resolvedProjectId =
    reusableExistingExecutionWorkspace
      ? reusableExistingExecutionWorkspace.projectId
      : executionWorkspace.projectId;
  const resolvedProjectWorkspaceId =
    resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace && reusableExistingExecutionWorkspace?.strategyType === "git_worktree"
      ? reusableExistingExecutionWorkspace.projectWorkspaceId
      : controllerOnly ? null : issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
  let persistedExecutionWorkspace: ExecutionWorkspace | null = null;
  let issueExecutionWorkspaceIdForRun =
    issueRef?.executionWorkspaceId ?? null;
  let issueProjectWorkspaceIdForRun = issueRef?.projectWorkspaceId ?? null;
  let issueExecutionWorkspacePreferenceForRun =
    issueRef?.executionWorkspacePreference ?? null;
  let issueExecutionWorkspaceModeForRun =
    issueExecutionWorkspaceSettings?.mode ?? null;
  const warmReusableExecutionWorkspace =
    selectedEnvironmentForConfig?.driver === "sandbox" &&
    selectedEnvironmentConfigForFingerprint.reuseLease === true &&
    selectedEnvironmentConfigForFingerprint.runnerLifecycleMode === "warm";
  // Native provider checkpoints bind to the workspace row, including ordinary
  // local shared workspaces. Persist that binding independently of the opt-in
  // isolated-workspace UI, just as warm sandbox continuity already does.
  const nativeSharedWorkspace = agent.adapterType === "paperclip_runner" &&
    requestedExecutionWorkspaceMode === "shared_workspace";
  const bindIssueToPersistedExecutionWorkspace = async (
    workspace: ExecutionWorkspace | null,
  ) => {
    if (sessionOnly || controllerOnly || preserveTaskWorkspace || !issueId || !workspace || nativeRecoveryExecutionWorkspaceId) {
      return;
    }
    const nextIssueWorkspaceMode =
      issueExecutionWorkspaceModeForPersistedWorkspace(workspace.mode) ??
      "agent_default";
    const shouldSwitchIssueToExistingWorkspace =
      issueRef?.executionWorkspacePreference === "reuse_existing" ||
      requestedExecutionWorkspaceMode === "isolated_workspace" ||
      requestedExecutionWorkspaceMode === "operator_branch" ||
      warmReusableExecutionWorkspace || nativeSharedWorkspace || Boolean(issueId);
    const nextIssuePatch: TaskWorkspaceBindingPatch = {};
    if (issueExecutionWorkspaceIdForRun !== workspace.id) {
      nextIssuePatch.executionWorkspaceId = workspace.id;
    }
    if (
      resolvedProjectWorkspaceId &&
      issueProjectWorkspaceIdForRun !== resolvedProjectWorkspaceId
    ) {
      nextIssuePatch.projectWorkspaceId = resolvedProjectWorkspaceId;
    }
    if (
      shouldSwitchIssueToExistingWorkspace &&
      (issueExecutionWorkspacePreferenceForRun !== "reuse_existing" ||
        issueExecutionWorkspaceModeForRun !== nextIssueWorkspaceMode)
    ) {
      nextIssuePatch.executionWorkspacePreference = "reuse_existing";
      nextIssuePatch.executionWorkspaceSettings = {
        ...(issueExecutionWorkspaceSettings ?? {}),
        mode: nextIssueWorkspaceMode,
      };
    }
    if (Object.keys(nextIssuePatch).length > 0) {
      await timeWorkspace("workspace_binding", () => executionWorkspacesSvc.bindTaskWorkspace(agent.companyId, issueId, workspace.id, nextIssuePatch));
      issueExecutionWorkspaceIdForRun = workspace.id;
      issueProjectWorkspaceIdForRun =
        resolvedProjectWorkspaceId ?? issueProjectWorkspaceIdForRun;
      if (shouldSwitchIssueToExistingWorkspace) {
        issueExecutionWorkspacePreferenceForRun = "reuse_existing";
        issueExecutionWorkspaceModeForRun = nextIssueWorkspaceMode;
      }
    }
  };
  const baseExecutionWorkspaceMetadata =
    mergeExecutionWorkspaceMetadataForPersistence({
      existingMetadata:
        resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace
          ? (reusableExistingExecutionWorkspace?.metadata ?? null)
          : null,
      source: executionWorkspace.source,
      // Attaching a new worktree to a pre-existing branch reports a fresh
      // workspace, but must not make cleanup own the operator's branch.
      createdByRuntime:
        resolveExecutionWorkspaceBranchOwnership(executionWorkspace),
      strategyType: executionWorkspace.strategy,
      configSnapshot,
      shouldReuseExisting:
        resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace,
      shouldRefreshConfigSnapshot:
        resolvedWorkspaceReusePolicy.shouldRefreshWorkspaceConfigSnapshot,
      workspaceConfigMetadata:
        resolvedWorkspaceReusePolicy.shouldPersistLatestWorkspaceConfigMetadata
          ? latestWorkspaceConfigMetadata
          : null,
      baseRef: executionWorkspace.repoRef,
      baseRefSha: executionWorkspace.baseRefSha ?? null,
    });
  let persistedWorktreeInstanceRoot =
    resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace &&
    typeof reusableExistingExecutionWorkspace?.metadata?.[
      WORKTREE_INSTANCE_ROOT_METADATA_KEY
    ] === "string"
      ? reusableExistingExecutionWorkspace.metadata[
          WORKTREE_INSTANCE_ROOT_METADATA_KEY
        ]
      : null;
  if (
    !managedWorkspace && !pluginPrepared && !remoteAuthority && !persistedWorktreeInstanceRoot &&
    executionWorkspace.strategy === "git_worktree" &&
    executionWorkspace.worktreePath
  ) {
    try {
      persistedWorktreeInstanceRoot =
        (
          await timeWorkspace("workspace_ownership_read", () => readManagedWorktreeInstanceOwnership(
            executionWorkspace.worktreePath!,
          ))
        )?.instanceRoot ?? null;
    } catch (error) {
      logger.warn(
        {
          runId: run.id,
          issueId,
          executionWorkspaceCwd: executionWorkspace.cwd,
          error: error instanceof Error ? error.message : String(error),
        },
        "Could not record managed worktree instance ownership",
      );
    }
  }
  const coreConfigFingerprint = baseExecutionWorkspaceMetadata?.[WORKSPACE_CONFIG_FINGERPRINT_METADATA_KEY];
  const nextExecutionWorkspaceMetadata = {
    ...baseExecutionWorkspaceMetadata,
    ...(pluginPrepared?.metadata ?? {}),
    ...(pluginPrepared && coreConfigFingerprint !== undefined
      ? { [WORKSPACE_CONFIG_FINGERPRINT_METADATA_KEY]: coreConfigFingerprint }
      : {}),
    ...(taskWorkspaceOwner && !pluginPrepared ? { runnerTaskWorkspaceOwner: taskWorkspaceOwner } : {}),
    ...(providerFresh && pluginTaskWorkspace && !pluginPrepared ? { runnerTaskFreshWorkspace: providerFresh } : {}),
    ...(copyOnlyProvisioning ? { [CONTROLLER_PROVISION_COPY_ONLY]: true } : {}),
    ...(persistedWorktreeInstanceRoot
      ? {
          [WORKTREE_INSTANCE_ROOT_METADATA_KEY]:
            persistedWorktreeInstanceRoot,
        }
      : {}),
  };
  const pendingForwardBranchReconcile =
    executionWorkspace.pendingForwardBranchReconcile ?? null;
  const branchNameForInitialPersistence =
    pendingForwardBranchReconcile?.recordedBranchName ??
    executionWorkspace.branchName;
  // A workspace created by this admission may inherit its parent's repository
  // requests (never its files); see executionWorkspaceRepositoryService.
  let createdExecutionWorkspaceThisRun = false;
  try {
    if (remoteAuthority) {
      if (!remoteSourceState.value || !issueId) throw new Error("remote_workspace_source_missing");
      if (!selectedEnvironmentId) throw new Error("remote_workspace_environment_missing");
      await assertRemotePreparationOwned();
      const reserved = await reserveRemoteWorkspace({
        db, companyId: agent.companyId, issueId, runId: run.id, agentId: agent.id,
        environmentId: selectedEnvironmentId,
        mode: effectiveExecutionWorkspaceMode === "shared_workspace" ? "shared_workspace"
          : effectiveExecutionWorkspaceMode === "operator_branch" ? "operator_branch" : "isolated_workspace",
        projectId: remoteSourceState.value!.projectId, projectWorkspaceId: remoteSourceState.value!.projectWorkspaceId,
        existingWorkspaceId: reusableExistingExecutionWorkspace?.id ?? existingExecutionWorkspace?.id ?? null,
        source: remoteSourceState.value!.source,
        ...(remoteFresh?.mode === "fresh_isolated_workspace" ? {
          fresh: { attemptId: remoteFresh.retryIntentId, previousWorkspaceId: remoteFreshBinding!.workspaceId,
            expectedBindingRevision: remoteFreshBinding!.revision },
          recoverySourceRunIds: [remoteFresh.sourceRunId],
        } : {}),
      }).catch(error => {
        if (!(error instanceof RemoteWorkspaceWriterActiveError)
          || remoteWorkspaceHoldRefusesStart({ kind: "held", writer: error.writer })) throw error;
        throw new WorkspaceBusyDeferral({ holder: error.writer, executionWorkspaceId: error.workspaceId,
          deferralAttempt: run.scheduledRetryReason === WORKSPACE_BUSY_RETRY_REASON ? run.scheduledRetryAttempt ?? 0 : 0,
          wasIssueAssignee: input.task.wasIssueAssignee, holderEnded: error.writer.ended === true });
      });
      persistedExecutionWorkspace = await executionWorkspacesSvc.getStoredById(agent.companyId, reserved.id);
      if (!persistedExecutionWorkspace?.cwd) throw new Error("remote_workspace_reservation_missing");
      persistedExecutionWorkspace = await executionWorkspacesSvc.update(reserved.id, {
        metadata: { ...reserved.metadata, ...nextExecutionWorkspaceMetadata,
          remoteWorkspace: reserved.metadata?.remoteWorkspace },
      });
      if (!persistedExecutionWorkspace?.cwd) throw new Error("remote_workspace_reservation_missing");
      executionWorkspace.cwd = persistedExecutionWorkspace.cwd;
      resolvedWorkspace.cwd = executionWorkspace.cwd;
    } else persistedExecutionWorkspace = sessionOnly ? null : managedWorkspace ? (managedAdmission?.workspace ?? managedWorkspace) as ExecutionWorkspace :
      pluginPrepared ? await executionWorkspacesSvc.update(pluginPrepared.id, { metadata: nextExecutionWorkspaceMetadata }) :
      freshTaskReservation ? await executionWorkspacesSvc.update(freshTaskReservation.id, { metadata: nextExecutionWorkspaceMetadata }) :
      resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace &&
      reusableExistingExecutionWorkspace
        ? await timeWorkspace("workspace_record_update", () => executionWorkspacesSvc.update(
            reusableExistingExecutionWorkspace.id,
            {
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: branchNameForInitialPersistence,
              providerType: pluginTaskWorkspace ? "adapter_managed" :
                executionWorkspace.strategy === "git_worktree"
                  ? "git_worktree"
                  : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              status: "active",
              lastUsedAt: new Date(),
              metadata: nextExecutionWorkspaceMetadata,
              projectWorkspaceId:
                reconcileReusedExecutionWorkspaceProjectWorkspaceId(
                  reusableExistingExecutionWorkspace.projectWorkspaceId,
                  resolvedProjectWorkspaceId,
                ),
            },
          ))
        : !controllerOnly && !persistedNativeExecutionInput && (resolvedProjectId || issueRef)
          ? await timeWorkspace("workspace_record_create", () => (createdExecutionWorkspaceThisRun = true, executionWorkspacesSvc.create({
              companyId: agent.companyId,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              mode:
                requestedExecutionWorkspaceMode === "isolated_workspace"
                  ? "isolated_workspace"
                  : requestedExecutionWorkspaceMode === "operator_branch"
                    ? "operator_branch"
                    : requestedExecutionWorkspaceMode === "agent_default"
                      ? "adapter_managed"
                      : "shared_workspace",
              strategyType: pluginTaskWorkspace ? latestWorkspaceStrategyType :
                executionWorkspace.strategy === "git_worktree"
                  ? "git_worktree"
                  : "project_primary",
              name:
                branchNameForInitialPersistence ??
                issueRef?.identifier ??
                `workspace-${agent.id.slice(0, 8)}`,
              status: "active",
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: branchNameForInitialPersistence,
              providerType: pluginTaskWorkspace ? "adapter_managed" :
                executionWorkspace.strategy === "git_worktree"
                  ? "git_worktree"
                  : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              lastUsedAt: new Date(),
              openedAt: new Date(),
              metadata: nextExecutionWorkspaceMetadata,
            })))
          : null;
  } catch (error) {
    if (executionWorkspace.created) {
      try {
        await cleanupExecutionWorkspaceArtifacts({
          workspace: {
            companyId: agent.companyId,
            id:
              reusableExistingExecutionWorkspace?.id ??
              workspaceReuseRequest.requestedExecutionWorkspaceId ??
              `transient-${run.id}`,
            cwd: executionWorkspace.cwd,
            providerType:
              executionWorkspace.strategy === "git_worktree"
                ? "git_worktree"
                : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            branchName: executionWorkspace.branchName,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            projectId: resolvedProjectId,
            projectWorkspaceId: resolvedProjectWorkspaceId,
            sourceIssueId: issueRef?.id ?? null,
            metadata: nextExecutionWorkspaceMetadata,
          },
          projectWorkspace: {
            cwd: resolvedWorkspace.cwd,
            cleanupCommand: null,
          },
          cleanupCommand: configSnapshot?.cleanupCommand ?? null,
          teardownCommand:
            configSnapshot?.teardownCommand ??
            projectExecutionWorkspacePolicy?.workspaceStrategy
              ?.teardownCommand ??
            null,
          recorder: workspaceOperationRecorder,
        });
      } catch (cleanupError) {
        logger.warn(
          {
            runId: run.id,
            issueId,
            executionWorkspaceCwd: executionWorkspace.cwd,
            cleanupError:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          },
          "Failed to cleanup realized execution workspace after persistence failure",
        );
      }
    }
    throw error;
  }
  await timeWorkspace("workspace_operation_binding", () => workspaceOperationRecorder.attachExecutionWorkspaceId(
    persistedExecutionWorkspace?.id ?? null,
  ));
  await timeWorkspace("workspace_config_recording", () => recordWorkspaceConfigFreshnessOperation({
    recorder: workspaceOperationRecorder,
    runId: run.id,
    decision: workspaceConfigFreshness,
    hasExistingWorkspace: Boolean(reusableExistingExecutionWorkspace),
    reuseRequested: requestedShouldReuseExisting,
    workspaceReused: Boolean(reusedExecutionWorkspace),
    configSnapshotRefreshed:
      resolvedWorkspaceReusePolicy.shouldRefreshWorkspaceConfigSnapshot,
    previousWorkspaceId:
      workspaceReuseRequest.requestedExecutionWorkspaceId,
    activeWorkspaceId: persistedExecutionWorkspace?.id ?? null,
  }));
  if (
    // A PM home is coordination storage, not a replacement for the borrowed
    // worker workspace. Retiring that workspace races the worker's admission.
    !preserveTaskWorkspace &&
    reusableExistingExecutionWorkspace &&
    persistedExecutionWorkspace &&
    reusableExistingExecutionWorkspace.id !==
      persistedExecutionWorkspace.id &&
    reusableExistingExecutionWorkspace.status === "active"
  ) {
    await timeWorkspace("workspace_record_update", () => executionWorkspacesSvc.update(
      reusableExistingExecutionWorkspace.id,
      {
        status: "idle",
        cleanupReason: null,
      },
    ));
  }
  await bindIssueToPersistedExecutionWorkspace(persistedExecutionWorkspace);
  if (issueId && persistedExecutionWorkspace && (pluginPrepared || pluginTaskWorkspace)) {
    const binding = readWorkspaceProviderBinding(persistedExecutionWorkspace.metadata);
    await claimSharedCheckout(db, { companyId: agent.companyId, agentId: agent.id,
      runId: run.id, issueId, projectWorkspaceId: persistedExecutionWorkspace.projectWorkspaceId,
      cwd: executionWorkspace.cwd, checkSourceHandoff: false,
      wasIssueAssignee: input.task.wasIssueAssignee,
      storageIdentity: binding ? { namespace: `plugin:${binding.pluginId}`, workspaceRef: binding.workspaceRef }
        : { namespace: "execution-workspace", workspaceRef: persistedExecutionWorkspace.id },
      deferralAttempt: run.scheduledRetryReason === WORKSPACE_BUSY_RETRY_REASON ? run.scheduledRetryAttempt ?? 0 : 0, context });
  }
  const projectRepositoryPaths: string[] = [];
  if (remoteAuthority) projectRepositoryPaths.push(...(remoteSourceState.value?.source.repositories ?? [])
    .filter(repository => !repository.readOnly).map(repository => repository.relativePath));
  if (!sessionOnly && !managedWorkspace && !pluginPrepared && !pluginTaskWorkspace && !remoteAuthority && !remoteWorkerHost && !controllerOnly && !preserveTaskWorkspace && persistedExecutionWorkspace && issueId && !persistedNativeExecutionInput && !nativeRecoveryExecutionWorkspaceId) {
    const taskRepositories = await timeWorkspace("workspace_repository_admission", () =>
      executionWorkspacesSvc.prepareTaskRepositoriesForAdmission({ companyId: agent.companyId,
        issueId, workspaceId: persistedExecutionWorkspace!.id, cwd: executionWorkspace.cwd,
        agentId: agent.id, runId: run.id, responsibleUserId,
        inheritRepositorySelections: createdExecutionWorkspaceThisRun && !resolvedProjectWorkspaceId }));
    projectRepositoryPaths.push(...taskRepositories.map(repository => repository.relativePath));
  }
  // Liveness-first rule 3 (workspace = directory): a shared local workspace whose directory holds
  // only an ignore-only .git (a main agent's home: /home/michael has just .git/info/exclude) is a
  // plain directory, not a repository. Sibling project repositories stay at their own directories
  // (workspace hints below keep their source cwd); copying them in failed every run at
  // `git rev-parse --git-path info/exclude` (HOM-377).
  const sharedLocalDirectory = persistedExecutionWorkspace?.mode === "shared_workspace"
    && persistedExecutionWorkspace.providerType === "local_fs"
    && await hasIgnoreOnlyGitDirectory(executionWorkspace.cwd);
  if (!sessionOnly && !managedWorkspace && !preserveTaskWorkspace && !pluginPrepared && !pluginTaskWorkspace && !remoteAuthority && !remoteWorkerHost && executionWorkspace.projectId
    && !sharedLocalDirectory
    && (resolvedWorkspace.source === "project_primary" || Boolean(reusableExistingExecutionWorkspace?.projectWorkspaceId))
    && !resolvedWorkspace.baseCwdFallback && !persistedNativeExecutionInput && !nativeRecoveryExecutionWorkspaceId) {
    const repositoryRows = await db.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.companyId, agent.companyId),
      eq(projectWorkspaces.projectId, executionWorkspace.projectId),
    )).orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
    const repositories = await timeWorkspace("workspace_project_repositories", () => prepareProjectRepositoryWorkspaces({
      cwd: executionWorkspace.cwd,
      anchorRepoUrl: executionWorkspace.repoUrl,
      workspaces: repositoryRows,
      restoredContents: persistedExecutionWorkspace ? readGitCacheRestoration(persistedExecutionWorkspace)?.contents : undefined,
      sharedBase: { companyId: agent.companyId, projectId: executionWorkspace.projectId! },
      resolveGitAuth: workspaceGitAuthProvider,
      prepareLocalSource: persistedExecutionWorkspace && issueId
        ? (sourceCwd, projectWorkspaceId) => executionWorkspacesSvc.prepareConfiguredRepositoryCopy({
            companyId: agent.companyId, issueId, workspaceId: persistedExecutionWorkspace!.id,
            cwd: executionWorkspace.cwd, agentId: agent.id, runId: run.id, sourceCwd, projectWorkspaceId,
          }) : undefined,
      beforePublish: persistedExecutionWorkspace && issueId && !nativeRecoveryExecutionWorkspaceId
        ? () => executionWorkspacesSvc.assertTaskRepositoryPublicationAllowed({
            companyId: agent.companyId, issueId, workspaceId: persistedExecutionWorkspace!.id,
            cwd: executionWorkspace.cwd, agentId: agent.id, runId: run.id,
          }) : undefined,
    }));
    const paths = new Map(repositories.map((repo) => [repo.workspaceId, repo.cwd]));
    const preparedRefs = new Map(repositories.map(repo => [repo.workspaceId, repo.repoRef]));
    projectRepositoryPaths.push(...repositories.map((repo) => path.relative(executionWorkspace.cwd, repo.cwd)));
    if (resolvedWorkspace.workspaceId) paths.set(resolvedWorkspace.workspaceId, executionWorkspace.cwd);
    resolvedWorkspace.workspaceHints = repositoryRows.map((source) => ({
      workspaceId: source.id,
      cwd: paths.get(source.id) ?? readNonEmptyString(source.cwd),
      repoUrl: readNonEmptyString(source.repoUrl),
      repoRef: preparedRefs.has(source.id) ? preparedRefs.get(source.id)! : readNonEmptyString(source.repoRef),
    }));
  }
  if (persistedExecutionWorkspace) {
    context.executionWorkspaceId = persistedExecutionWorkspace.id;
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: context,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run.id));
  }
  if (providerApiPlacement) {
    await controllerLease.assertOwned();
    return {
      resolvedWorkspace, hostExecutionWorkspaceConfig, skipHostProvision: true,
      latestWorkspaceConfigMetadata, workspaceConfigFreshness, workspaceOperationRecorder,
      executionWorkspace, reusedExecutionWorkspace, resolvedWorkspaceReusePolicy,
      persistedExecutionWorkspace: null, projectRepositoryPaths: [],
      environmentAcquireStartedAtMs: Date.now(), selectedEnvironment: null,
      activeEnvironmentLease: null,
      realizationResult: { remoteExecution: null, executionTarget: null, persistedExecutionWorkspace: null,
        lease: null, workspaceRealization: null },
      environmentRealizeEndedAtMs: Date.now(), workspaceRealization: null,
      executionTarget: null, workspaceRestoreSource: null,
    };
  }
  const environmentAcquireStartedAtMs = workspaceAcquireStartedAtMs ?? Date.now();
  let acquiredEnvironment: Awaited<
    ReturnType<typeof envOrchestrator.acquireForRun>
  >;
  try {
    await controllerLease.assertOwned();
    const remoteRecovery = runOptions.nativeRestartRecovery?.kind === "reattach_remote_runner"
      ? runOptions.nativeRestartRecovery : null;
    const sandboxRecovery = remoteRecovery && remoteRecovery.remote.kind !== "plugin_task" ? remoteRecovery.remote : null;
    const recoveryWorkspace = sandboxRecovery
      ? readNativeWorkspaceSyncReference(parseObject(run.runnerProfileJson).nativeWorkspaceSync) : null;
    const remoteRecoveryLocation = remoteAuthority
      ? readRemoteWorkspaceAuthority(persistedExecutionWorkspace?.metadata)?.location ?? null : null;
    if (remoteRecovery) {
      const saved = remoteAuthority ? remoteRecoveryLocation : recoveryWorkspace;
      const mismatch = remoteRecovery.runId !== run.id ? "run_id" as const
        : !sandboxRecovery ? null
        : !saved ? "workspace_reference" as const
        : saved.providerLeaseId !== sandboxRecovery.providerLeaseId ? "provider_lease_id" as const
        : saved.remoteCwd !== sandboxRecovery.remoteCwd ? "remote_cwd" as const : null;
      if (mismatch) throw remoteRecoveryLeaseMismatch("workspace_preparation", mismatch);
    }
    // A same-run resume whose inherited runner identity was retired keeps the
    // run's own retained sandbox, so its workspace and allocation carry over.
    const retainedSandbox = runOptions.nativeLeaseOwner && !runOptions.nativeRestartRecovery
      ? readInheritedRunnerRetainedSandbox(parseObject(run.runnerProfileJson)) : null;
    const acquireRetainedOrNew = async (input: Parameters<typeof envOrchestrator.acquireForRun>[0]) => {
      if (!retainedSandbox) return envOrchestrator.acquireForRun(input);
      try {
        return await envOrchestrator.acquireForRun({ ...input, reattachRemoteLease: retainedSandbox });
      } catch (error) {
        // Only proof that the retained sandbox is gone permits ordinary
        // acquisition. A live lease with another scope keeps the failure.
        if (!(error instanceof Error) || !RETAINED_SANDBOX_GONE.test(error.message)) throw error;
        logger.warn({ runId: run.id, detail: error.message }, "retained sandbox unavailable for same-run resume; acquiring");
        return envOrchestrator.acquireForRun(input);
      }
    };
    if (workspaceAcquisition && workspaceAcquisition.lease.executionWorkspaceId !== persistedExecutionWorkspace?.id)
      throw new Error("Workspace Launcher lease changed before task admission");
    acquiredEnvironment = workspaceAcquisition ?? await timeWorkspace("workspace_environment_acquire", () => acquireRetainedOrNew({
      ...environmentAcquisitionInput(persistedExecutionWorkspace, executionWorkspace.projectId, executionWorkspace.additionalWorkspaces),
      ...(pluginRecovery ? { reattachRemoteLease: pluginRecovery } : sandboxRecovery && (recoveryWorkspace || remoteRecoveryLocation) ? { reattachRemoteLease: {
        leaseId: (remoteRecoveryLocation ?? recoveryWorkspace)!.leaseId,
        providerLeaseId: sandboxRecovery.providerLeaseId,
        remoteCwd: sandboxRecovery.remoteCwd,
      } } : {}),
    }));
    await controllerLease.assertOwned();
    nativeRunnerPreparationSpans.push({
      name: "environment.acquire",
      parentName: "task.provider_session",
      startedAtMs: environmentAcquireStartedAtMs,
      endedAtMs: Date.now(),
      attributes: { adapter: agent.adapterType },
    });
  } catch (error) {
    nativeRunnerPreparationSpans.push({
      name: "environment.acquire",
      parentName: "task.provider_session",
      startedAtMs: environmentAcquireStartedAtMs,
      endedAtMs: Date.now(),
      outcome: "failed",
      attributes: { adapter: agent.adapterType },
    });
    throw error;
  }
  const selectedEnvironment = acquiredEnvironment.environment;
  // A sandbox's guest cwd is not a controller path. Reserve the actual provider
  // allocation before realization can write; the runtime retains its lease and
  // persistent-workspace cleanup gates. Independent allocations may run together.
  if (issueId && selectedEnvironment.driver === "sandbox") {
    const lease = acquiredEnvironment.lease;
    if (!lease.providerLeaseId || !lease.provider) throw new WorkspaceValidationFailure(
      "The sandbox did not provide a durable storage identity.",
      { workspaceValidation: { reason: "workspace_storage_identity_missing" } });
    await claimSharedCheckout(db, { companyId: agent.companyId, agentId: agent.id,
      runId: run.id, issueId, projectWorkspaceId: persistedExecutionWorkspace?.projectWorkspaceId ?? null,
      cwd: executionWorkspace.cwd, checkSourceHandoff: false,
      wasIssueAssignee: input.task.wasIssueAssignee,
      storageIdentity: { namespace: String(lease.metadata?.pluginId ?? lease.provider), workspaceRef: lease.providerLeaseId },
      deferralAttempt: run.scheduledRetryReason === WORKSPACE_BUSY_RETRY_REASON ? run.scheduledRetryAttempt ?? 0 : 0, context });
  }
  assertAllowedEnvironment(selectedEnvironment);
  let activeEnvironmentLease = {
    environment: acquiredEnvironment.environment,
    lease: acquiredEnvironment.lease,
    leaseContext: acquiredEnvironment.leaseContext,
    pluginTaskDescription: acquiredEnvironment.pluginTaskDescription,
  };
  const duplexObservabilityRecorder = createHostDuplexObservabilityRecorder(
    {
      tracer: getStartupTracer(),
      incrementCounter: (metric) => {
        void incrementToolRuntimeMetricCounter(db, {
          companyId: run.companyId,
          metric,
        }).catch(() => {});
      },
      emitTransportEvent: (event) => {
        void (async () => {
          await appendRunEvent(run, {
            eventType: event.name,
            stream: "system",
            level: event.dimensions.outcome === "error" ? "warn" : "info",
            payload: { ...event.dimensions },
          });
        })().catch(() => {});
      },
    },
  );
  const environmentRealizeStartedAtMs = Date.now();
  let realizationResult: Awaited<
    ReturnType<typeof envOrchestrator.realizeForRun>
  >;
  try {
    realizationResult = await timeWorkspace("workspace_environment_realize", () => envOrchestrator.realizeForRun({
      environment: selectedEnvironment,
      lease: activeEnvironmentLease.lease,
      sandboxLeaseAcquisition: acquiredEnvironment.sandboxLeaseAcquisition,
      adapterType: agent.adapterType,
      companyId: agent.companyId,
      issueId: issueId ?? null,
      heartbeatRunId: run.id,
      executionWorkspace,
      effectiveExecutionWorkspaceMode,
      persistedExecutionWorkspace,
      runnerTaskProjectIds: resolvedWorkspace.runnerTaskProjectIds,
      ...(input.signal ? { signal: input.signal } : {}),
      assertOwned: remoteAuthority ? assertRemotePreparationOwned : controllerLease.assertOwned,
      duplexObservabilityRecorder,
    }));
    nativeRunnerPreparationSpans.push({
      name: "environment.workspace.realize",
      parentName: "task.provider_session",
      startedAtMs: environmentRealizeStartedAtMs,
      endedAtMs: Date.now(),
      attributes: { driver: selectedEnvironment.driver },
    });
  } catch (error) {
    nativeRunnerPreparationSpans.push({
      name: "environment.workspace.realize",
      parentName: "task.provider_session",
      startedAtMs: environmentRealizeStartedAtMs,
      endedAtMs: Date.now(),
      outcome: "failed",
      attributes: { driver: selectedEnvironment.driver },
    });
    throw error;
  }
  const environmentRealizeEndedAtMs = Date.now();
  activeEnvironmentLease = {
    ...activeEnvironmentLease,
    lease: realizationResult.lease,
  };
  persistedExecutionWorkspace =
    realizationResult.persistedExecutionWorkspace;
  // A sandbox realization may materialize or replace the durable workspace
  // after the host-side provisioning boundary above. Bind that final ID to
  // the issue before dispatch so warm turns reuse the exact same workspace
  // and lease scope instead of silently creating a per-run replacement.
  await bindIssueToPersistedExecutionWorkspace(persistedExecutionWorkspace);
  const workspaceRealization = realizationResult.workspaceRealization;
  const executionTarget = realizationResult.executionTarget;
  const storageClaim = parseObject(context.sharedCheckoutClaim);
  if (storageClaim.kind === "storage") {
    const executionCwd = executionTarget?.kind === "remote" ? executionTarget.remoteCwd : executionWorkspace.cwd;
    const [recorded] = await db.update(heartbeatRuns).set({
      contextSnapshot: sql`jsonb_set(${heartbeatRuns.contextSnapshot}, '{sharedCheckoutClaim,executionCwd}', ${JSON.stringify(executionCwd)}::jsonb)`,
    }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, agent.companyId),
      sql`${heartbeatRuns.contextSnapshot}->'sharedCheckoutClaim' = ${JSON.stringify(storageClaim)}::jsonb`)).returning({ id: heartbeatRuns.id });
    if (!recorded) throw new Error("workspace_storage_claim_changed");
    context.sharedCheckoutClaim = { ...storageClaim, executionCwd };
  }
  if (ensureTaskWorkspace && executionTarget?.kind === "remote" && executionTarget.transport === "sandbox" && executionTarget.runnerTask) {
    if (executionTarget.leaseId !== acquiredEnvironment.lease.id) throw new Error("Workspace Launcher lease changed before task admission");
    const ensure = ensureTaskWorkspace;
    const runnerTask = executionTarget.runnerTask;
    executionTarget.runnerTask = (operation, options) => {
      const kind = parseObject(operation).kind;
      if (kind === "prepare" || kind === "resume") {
        if (!options?.expectedTaskId) throw new Error("Workspace Launcher task identity unavailable");
        input.signal?.throwIfAborted();
        const assertOwned = () => {
          input.signal?.throwIfAborted();
          const context = options.executionContext;
          if (context !== undefined) {
            if (!(context instanceof NativeExecutionContext)) throw new Error("native_execution_context_unavailable");
            context.assertScope({ companyId: agent.companyId, agentId: agent.id, runId: run.id });
          }
        };
        const preparation = ensure(options.expectedTaskId, assertOwned);
        if (preparation) return preparation.then(() => {
          assertOwned();
          return runnerTask(operation, options);
        });
      }
      return runnerTask(operation, options);
    };
  }
  if (remoteAuthority && persistedExecutionWorkspace && issueId && !persistedNativeExecutionInput && !nativeRecoveryExecutionWorkspaceId) {
    const repositories = await timeWorkspace("workspace_repository_admission", () =>
      executionWorkspacesSvc.prepareTaskRepositoriesForAdmission({ companyId: agent.companyId, issueId,
        workspaceId: persistedExecutionWorkspace!.id, cwd: executionWorkspace.cwd, agentId: agent.id, runId: run.id,
        responsibleUserId, remoteTarget: executionTarget, remoteLease: activeEnvironmentLease.lease,
        assertOwned: assertRemotePreparationOwned }));
    projectRepositoryPaths.push(...repositories.map(repository => repository.relativePath));
    persistedExecutionWorkspace = await executionWorkspacesSvc.getStoredById(agent.companyId, persistedExecutionWorkspace.id);
  }
  if (remoteAuthority && persistedExecutionWorkspace?.metadata?.remoteWorkspaceRecoveredFiles) {
    const recorded = persistedExecutionWorkspace?.metadata?.remoteWorkspaceRecoveredFiles;
    // Retired copies were removed from the workspace; they are kept only as records.
    const recoveredFiles = (Array.isArray(recorded) ? recorded : []).filter(value => parseObject(value).retired !== true).map(value => {
      const file = parseObject(value);
      if (typeof file.operationId !== "string" || typeof file.sourceRunId !== "string"
        || file.path !== `.paperclip-recovered/${file.operationId}` || !/^[a-f0-9-]{36}$/.test(file.operationId)) {
        throw new Error("remote_workspace_recovered_files_invalid");
      }
      return { operationId: file.operationId, sourceRunId: file.sourceRunId, path: file.path as string };
    });
    context.recoveredWorkspaceFiles = recoveredFiles;
    const continuation = context.executionContinuation as import("@paperclipai/shared").ExecutionContinuationEnvelope | null;
    if (continuation) {
      continuation.recoveredFiles = recoveredFiles;
      const wake = context.paperclipWake as Record<string, unknown> | undefined;
      if (wake) wake.executionContinuation = continuation;
    }
  }
  if (!pluginPrepared && !pluginTaskWorkspace && !remoteAuthority && !remoteWorkerHost && !controllerOnly && !preserveTaskWorkspace && issueId && (persistedNativeExecutionInput || nativeRecoveryExecutionWorkspaceId)
      && !(executionTarget?.kind === "remote" && (executionTarget.transport === "ssh"
        || (executionTarget.transport === "sandbox" && executionTarget.runnerTask)))) {
    const workspaceId = persistedNativeExecutionInput?.binding.executionWorkspaceId ?? nativeRecoveryExecutionWorkspaceId!;
    // Runtime selection persists the native input before it prepares the
    // sandbox sync, and commits this reference before any provider dispatch.
    // An absent reference therefore means preparation was interrupted (for
    // example by a server restart) before the sandbox received this run's work.
    // There is no remote copy-back to protect, so recovery re-admits the host
    // workspace that the fresh sync preparation will seed from.
    const reference = readNativeWorkspaceSyncReference(parseObject(run.runnerProfileJson).nativeWorkspaceSync);
    const cwd = reference
      ? await readNativeWorkspaceSyncLocalCwd({ companyId: agent.companyId, runId: run.id, workspaceId, reference })
      : nativeExecutionUsesTaskWorkspace(persistedNativeExecutionInput)
        && executionTarget?.kind !== "remote"
        ? persistedNativeExecutionInput.workspace.cwd
        : executionWorkspace.cwd;
    // The admitted native root/sync descriptor governs recovery; current source
    // repository settings do not turn that root into a Git checkout.
    await claimExecutionDirectory(cwd, false, true);
    await timeWorkspace("workspace_recovery_root", () => executionWorkspacesSvc.assertTaskRepositoryRecoveryBinding({ companyId: agent.companyId,
      issueId, workspaceId, cwd, agentId: agent.id, runId: run.id }));
  }
  // Preserve the host-owned source before adapter context can share lease
  // metadata. A later copy-back failure must not adopt a rebound source.
  const workspaceRestoreSource = structuredClone(realizationResult.lease);
  return {
    resolvedWorkspace,
    hostExecutionWorkspaceConfig,
    skipHostProvision,
    latestWorkspaceConfigMetadata,
    workspaceConfigFreshness,
    workspaceOperationRecorder,
    executionWorkspace,
    reusedExecutionWorkspace,
    resolvedWorkspaceReusePolicy,
    persistedExecutionWorkspace,
    projectRepositoryPaths,
    environmentAcquireStartedAtMs,
    selectedEnvironment,
    activeEnvironmentLease,
    realizationResult,
    environmentRealizeEndedAtMs,
    workspaceRealization,
    executionTarget,
    workspaceRestoreSource,
  };
}

/** A `.git` directory without HEAD (for example only `info/exclude`) is ignore metadata, not a repository. */
async function hasIgnoreOnlyGitDirectory(cwd: string): Promise<boolean> {
  const entry = await fs.lstat(path.join(cwd, ".git")).catch(() => null);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) return false;
  return !(await fs.lstat(path.join(cwd, ".git", "HEAD")).catch(() => null));
}
