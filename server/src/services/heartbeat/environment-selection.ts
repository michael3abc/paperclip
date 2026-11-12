import { assertProviderApiPlacementPolicy, resolveProviderApiPlacement } from "../native-runtime/provider-api-placement.js";
import { heartbeatExternalProvider, nativeExecutionUsesTaskWorkspace } from "./external-provider.js";
import { heartbeatRuns, issues, type Db, type agents } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { readGitCacheExpiration } from "../git-workspace-restoration.js";
import type { ExecutionWorkspace, IssueExecutionWorkspaceSettings, ProjectExecutionWorkspacePolicy } from "@paperclipai/shared";
import { isMainManagedExecutionWorkspace, readMainManagedWorktree } from "@paperclipai/shared";
import { isMainAgent } from "../main-agent-workers.js";
import { parseObject } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { isExecutionForcedToKubernetes } from "../execution-allowlist.js";
import { parseExecutionPolicyBootstrapEnv } from "../execution-policy-bootstrap.js";
import {
  parseIssueExecutionWorkspaceSettings,
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceEnvironmentId,
  resolveExecutionWorkspaceMode,
  type ParsedExecutionWorkspaceMode,
} from "../execution-workspace-policy.js";
import { assertTaskWorkspaceExecutionAccess, assertTaskWorkspaceSourceProjectAccess } from "../task-workspace-access.js";
import { isBoundIsolatedTaskDirectory, shouldUseIsolatedTaskDirectory } from "../isolated-task-directory.js";
import { readTaskDirectoryRetention } from "../isolated-task-directory-retention.js";
import { isBoundFreshPluginTaskDirectory } from "../provider-fresh-workspace.js";
import {
  findNativeChatWorkspaceScope,
  nativeChatWorkspaceCwd,
  nativeChatWorkspaceMatches,
} from "../native-runtime/native-chat-workspace.js";
import { NativeRunnerOwnershipUnverifiedError } from "../native-runtime/native-runner-ownership.js";
import type { environmentService } from "../environments.js";
import type { executionWorkspaceService } from "../execution-workspaces.js";
import type { instanceSettingsService } from "../instance-settings.js";
import type { TrustPresetResolution } from "../trust-preset-resolver.js";
import { WORKSPACE_BUSY_RETRY_REASON } from "../../modules/run-dispatch/index.js";
import { WorkspaceBusyDeferral, type createHeartbeatRetries } from "./retries.js";
import { ConfigurationIncompleteFailure } from "./run-preparation.js";
import { resolveNativeRecoveryExecutionWorkspaceBinding, resolveExecutionWorkspaceReuseRequestForIssue, WorkspaceValidationFailure } from "./workspaces.js";
import { assertFixedWorkspacePolicy, isExternalWorkspaceTask, readWorkspaceBinding, workspaceBindingConflict, fixedWorkspaceMatchesRun } from "../agent-workspace-binding.js";

type Issue = typeof issues.$inferSelect;

/** Selects policy and reuse inputs; lease acquisition and cleanup belong to the executor. */
export interface HeartbeatEnvironmentSelectionInput {
  run: Pick<typeof heartbeatRuns.$inferSelect,
    "id" | "runtimeMode" | "runnerProfileJson" | "scheduledRetryReason" | "scheduledRetryAttempt"> & { contextSnapshot?: Record<string, unknown> | null };
  agent: Pick<typeof agents.$inferSelect,
    "id" | "companyId" | "adapterType" | "adapterConfig" | "defaultEnvironmentId"> & { runtimeConfig?: Record<string, unknown> };
  task: {
    freshWorkspace?: import("../fresh-workspace-continuation.js").ContinuationReadiness | null;
    issueRef: Pick<Issue, "id" | "projectId" | "projectWorkspaceId" | "executionWorkspaceId" | "executionWorkspacePreference"> | null;
    issueContext: Pick<Issue, "assigneeAgentId" | "executionWorkspaceSettings"> & Partial<Pick<Issue, "conversationAgentId">> | null;
    issueId: string | null;
    context: Record<string, unknown>;
    executionProjectId: string | null;
    workspaceProjectContext: { hasWorkspace: boolean } | null;
    boundSourceWorkspace: ExecutionWorkspace | null;
    hasSelectedWorkspaceSource: boolean;
    taskWorkspaceIntent: Issue["workspaceSelection"];
    responsibleUserId: string | null;
  };
  policy: {
    trustPreset: TrustPresetResolution;
    requestedExecutionWorkspaceMode: ParsedExecutionWorkspaceMode;
    isolatedWorkspacesEnabled: boolean;
    projectExecutionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
    issueExecutionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  };
  config: {
    config: Record<string, unknown>;
    sourceWorkspaceConfig: Record<string, unknown>;
    issueAssigneeOverrides: { adapterConfig: Record<string, unknown> | null } | null;
  };
  services: {
    executionWorkspacesSvc: Pick<ReturnType<typeof executionWorkspaceService>, "getStoredById" | "validateStoredSelectionForRun"
      | "reopenClosedIsolatedExecutionWorkspaceForIssue" | "clearReopenPendingConsumptionForUnconsumedReopen">;
    environmentsSvc: Pick<ReturnType<typeof environmentService>,
      "ensureLocalEnvironment" | "findManagedSandboxEnvironment" | "findKubernetesEnvironment" | "ensureKubernetesEnvironment" | "getById">;
    instanceSettings: Pick<ReturnType<typeof instanceSettingsService>, "get" | "getExperimental">;
    findSharedWorkspaceHolder: ReturnType<typeof createHeartbeatRetries>["findSharedWorkspaceHolder"];
    findExecutionWorkspaceHolder: ReturnType<typeof createHeartbeatRetries>["findExecutionWorkspaceHolder"];
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function selectHeartbeatEnvironment(db: Db, input: HeartbeatEnvironmentSelectionInput) {
  const { run, agent } = input;
  const { issueRef, issueContext, issueId, context, executionProjectId, workspaceProjectContext, boundSourceWorkspace, hasSelectedWorkspaceSource, taskWorkspaceIntent, responsibleUserId } = input.task;
  const {
    trustPreset, requestedExecutionWorkspaceMode, isolatedWorkspacesEnabled: runtimeWorkspaceSelectionEnabled,
    projectExecutionWorkspacePolicy, issueExecutionWorkspaceSettings,
  } = input.policy;
  const { config, sourceWorkspaceConfig, issueAssigneeOverrides } = input.config;
  const { executionWorkspacesSvc, environmentsSvc, instanceSettings, findExecutionWorkspaceHolder } = input.services;
  // A native run's execution input is immutable once persisted. Recovery must therefore
  // restore the workspace bound to that input rather than consulting the issue's current
  // workspace pointer: a newer run may already have moved or cleared the issue binding while
  // this older provider session is still recoverable.
  const persistedRunnerProfile = parseObject(run.runnerProfileJson);
  const persistedNativeExecutionInput =
    run.runtimeMode === "native" &&
    persistedRunnerProfile.nativeExecutionInput !== undefined
      ? parseNativeExecutionInput(
          persistedRunnerProfile.nativeExecutionInput,
        )
      : null;
  // This retained name covers both external bridges; neither adopts task files.
  const isDotRun = heartbeatExternalProvider({ run, agent }) !== null;
  const providerApiPlacement = resolveProviderApiPlacement({ run, agent });
  const controllerOnly = isDotRun || providerApiPlacement !== null;
  const persistedNativeExecutionWorkspaceId =
    providerApiPlacement ? null : persistedNativeExecutionInput?.binding.executionWorkspaceId ?? null;
  const fresh = input.task.freshWorkspace?.mode === "fresh_isolated_workspace";
  const explicitSessionOnly = issueExecutionWorkspaceSettings?.sessionOnly === true && !persistedNativeExecutionInput;
  const requestedExecutionWorkspaceId = controllerOnly || explicitSessionOnly ? null :
    persistedNativeExecutionWorkspaceId ??
    readNonEmptyString(issueRef?.executionWorkspaceId);
  let existingExecutionWorkspace = requestedExecutionWorkspaceId
    ? await executionWorkspacesSvc.getStoredById(agent.companyId, requestedExecutionWorkspaceId)
    : null;
  if (isMainAgent(agent) && !persistedNativeExecutionInput && (!issueRef || issueContext?.conversationAgentId === agent.id)
    && !isMainManagedExecutionWorkspace(existingExecutionWorkspace)) existingExecutionWorkspace = null;
  if (isMainManagedExecutionWorkspace(existingExecutionWorkspace)) {
    const managed = readMainManagedWorktree(existingExecutionWorkspace?.metadata);
    if (!managed) throw new WorkspaceValidationFailure("The worktree marker requires reconciliation.", { reason: "worktree_marker_unrecognized" });
    if (managed.phase !== "open") throw new WorkspaceValidationFailure("The project main has closed this worktree to new participation.", { reason: "workspace_converging" });
    if (managed.pendingOperationId) throw new WorkspaceValidationFailure("Reconcile the original worktree operation before admitting work.", { reason: "worktree_operation_reconciliation_required" });
  }
  if (existingExecutionWorkspace && !isMainManagedExecutionWorkspace(existingExecutionWorkspace) && issueId && !controllerOnly && !fresh
    && existingExecutionWorkspace.id === readNonEmptyString(issueRef?.executionWorkspaceId)
    && (existingExecutionWorkspace.status === "archived" || existingExecutionWorkspace.status === "cleanup_failed")
    && (readGitCacheExpiration(existingExecutionWorkspace as Parameters<typeof readGitCacheExpiration>[0])?.workspaceRemoved
      || readTaskDirectoryRetention(existingExecutionWorkspace) !== null)) {
    const [boundIssue] = await db.select({ id: issues.id, companyId: issues.companyId, projectId: issues.projectId })
      .from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)));
    if (!boundIssue) throw new Error("Execution workspace issue is unavailable");
    const actor = { agentId: agent.id, actorType: "agent" };
    const reopened = await executionWorkspacesSvc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId: existingExecutionWorkspace.id,
      issue: boundIssue,
      actor,
      authorizationActor: { type: "agent", agentId: agent.id, companyId: agent.companyId, source: "agent_jwt", runId: run.id,
        onBehalfOfUserId: responsibleUserId === "local-board" ? null : responsibleUserId },
    });
    if (!reopened.ok) throw new Error(reopened.message);
    if (reopened.reopened) {
      await executionWorkspacesSvc.clearReopenPendingConsumptionForUnconsumedReopen({
        workspaceId: existingExecutionWorkspace.id, issue: boundIssue, actor, expectedGeneration: reopened.generation,
      });
    }
    existingExecutionWorkspace = await executionWorkspacesSvc.getStoredById(agent.companyId, existingExecutionWorkspace.id);
  }
  const retainedDirectory = input.task.freshWorkspace?.mode === "reuse_current_workspace" ? input.task.freshWorkspace : null;
  if (retainedDirectory && (issueRef?.executionWorkspaceId !== retainedDirectory.workspaceId ||
      existingExecutionWorkspace?.id !== retainedDirectory.workspaceId || existingExecutionWorkspace.cwd !== retainedDirectory.cwd)) {
    throw new WorkspaceValidationFailure("The saved Retry workspace binding changed.", {
      workspaceValidation: { reason: "isolated_task_directory_binding_mismatch", issueId },
    });
  }
  const nativeRecoveryExecutionWorkspaceId =
    resolveNativeRecoveryExecutionWorkspaceBinding({
      bindingId: persistedNativeExecutionWorkspaceId,
      persistedWorkspaceFound: existingExecutionWorkspace !== null,
    });
  const workspaceReuseRequest =
    resolveExecutionWorkspaceReuseRequestForIssue({
      issueExecutionWorkspaceId: requestedExecutionWorkspaceId,
      issueExecutionWorkspacePreference: controllerOnly ? null : nativeRecoveryExecutionWorkspaceId
        ? "reuse_existing"
        : (issueRef?.executionWorkspacePreference ?? null),
      existingExecutionWorkspaceStatus:
        existingExecutionWorkspace?.status ?? null,
    });
  const requestedShouldReuseExisting =
    workspaceReuseRequest.requestedShouldReuseExisting;
  const reusableExistingExecutionWorkspace =
    workspaceReuseRequest.existingExecutionWorkspaceAvailable
      ? existingExecutionWorkspace
      : null;
  const workspaceAuthorizationActor = { type: "agent" as const, agentId: agent.id, companyId: agent.companyId,
    source: "agent_jwt" as const, runId: run.id, onBehalfOfUserId: responsibleUserId === "local-board" ? null : responsibleUserId };
  if (!controllerOnly && !persistedNativeExecutionInput && !nativeRecoveryExecutionWorkspaceId) {
    const workspaceRequiringAccess = reusableExistingExecutionWorkspace ?? boundSourceWorkspace;
    if (workspaceRequiringAccess && issueId) {
      await assertTaskWorkspaceExecutionAccess(db, workspaceAuthorizationActor, agent.companyId, { issueId, workspaceId: workspaceRequiringAccess.id });
    } else if (!controllerOnly && executionProjectId && (hasSelectedWorkspaceSource || workspaceProjectContext?.hasWorkspace)) {
      await assertTaskWorkspaceSourceProjectAccess(db, workspaceAuthorizationActor, agent.companyId, executionProjectId);
    }
  }
  const requestedReusableExecutionWorkspaceConfig =
    reusableExistingExecutionWorkspace?.config ?? null;
  const localEnvironment = await environmentsSvc.ensureLocalEnvironment(
    agent.companyId,
  );
  const resolvedInstanceSettings = await instanceSettings.get();
  // Managed-sandbox-only policy: a run that would land on the local
  // environment is redirected onto the platform-managed sandbox row, and
  // with no active managed row the resolution fails closed
  // (ManagedSandboxUnavailableError) — never local. Mirrors the forced
  // kubernetes execution mode below, which takes precedence when both
  // regimes are active.
  const managedSandboxOnly =
    (await instanceSettings.getExperimental()).enableManagedSandboxOnly ===
    true;
  const managedSandboxEnvironment = managedSandboxOnly && !providerApiPlacement
    ? await environmentsSvc.findManagedSandboxEnvironment(agent.companyId)
    : null;
  const environmentResolution = providerApiPlacement
    ? { environmentId: null, source: "default" as const }
    : resolveExecutionWorkspaceEnvironmentId({
    lowTrustIssueEnvironmentId: trustPreset.kind === "low_trust_review"
      ? parseIssueExecutionWorkspaceSettings(issueContext?.executionWorkspaceSettings, {includeEnvironmentId: true})?.environmentId : null,
    agentDefaultEnvironmentId: agent.defaultEnvironmentId,
    instanceDefaultEnvironmentId:
      resolvedInstanceSettings.defaultEnvironmentId ?? null,
    localDefaultEnvironmentId: localEnvironment.id,
    managedSandboxOnly,
    managedSandboxEnvironmentId: managedSandboxEnvironment?.id ?? null,
  });
  const effectiveExecutionWorkspaceMode: ReturnType<
    typeof resolveExecutionWorkspaceMode
  > = requestedExecutionWorkspaceMode;
  const executionPolicy = {
    executionMode: resolvedInstanceSettings.general.executionMode,
    // Backstop behind the resolver's local→managed redirect: the run-time
    // allowlist below fails any run that still resolved to a `local`
    // environment under managed-sandbox-only, so no selection path or
    // tenant-set env var can land untrusted execution on the tenant
    // container.
    managedSandboxOnly,
  };
  const executionForcedToKubernetes =
    isExecutionForcedToKubernetes(executionPolicy);
  if (providerApiPlacement) assertProviderApiPlacementPolicy(executionPolicy);
  let selectedEnvironmentId = environmentResolution.environmentId;
  if (executionForcedToKubernetes && !providerApiPlacement) {
    let kubernetesEnvironment =
      await environmentsSvc.findKubernetesEnvironment(agent.companyId);
    if (!kubernetesEnvironment) {
      // Lazy recovery for companies created after the startup bootstrap ran
      // (the boot hook only provisions environments for companies that exist
      // at boot). Re-derive the managed-env config from the bootstrap env.
      // If the process env no longer forces Kubernetes (rollback / config
      // drift relative to the persisted executionMode setting), skip the
      // provisioning gracefully: the guard below still refuses local
      // fallback with the explicit error, instead of crashing here on
      // undefined config.
      let bootstrap: ReturnType<typeof parseExecutionPolicyBootstrapEnv> =
        null;
      let bootstrapSkipReason: string | null = null;
      try {
        bootstrap = parseExecutionPolicyBootstrapEnv(process.env);
        if (!bootstrap) {
          bootstrapSkipReason =
            'PAPERCLIP_EXECUTION_MODE bootstrap env is not kubernetes-forced (absent or "any")';
        }
      } catch (err) {
        bootstrapSkipReason = `PAPERCLIP_EXECUTION_MODE bootstrap env failed to parse: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      if (bootstrap) {
        await environmentsSvc.ensureKubernetesEnvironment(
          agent.companyId,
          bootstrap.kubernetesConfig,
        );
        kubernetesEnvironment =
          await environmentsSvc.findKubernetesEnvironment(agent.companyId);
      } else {
        logger.warn(
          {
            runId: run.id,
            agentId: agent.id,
            companyId: agent.companyId,
            reason: bootstrapSkipReason,
          },
          "executionMode=kubernetes is persisted but the bootstrap env cannot provision a managed Kubernetes environment; skipping lazy provisioning for this company (the run will fail with the explicit no-managed-environment error)",
        );
      }
    }
    if (!kubernetesEnvironment) {
      throw new Error(
        "Instance execution policy requires the Kubernetes sandbox provider " +
          "(executionMode=kubernetes) but no managed Kubernetes environment is " +
          "configured for this company. Configure one (PAPERCLIP_K8S_* env on the " +
          "cloud instance) before running agents; refusing to fall back to local execution.",
      );
    }
    if (kubernetesEnvironment.id !== selectedEnvironmentId) {
      logger.info(
        {
          runId: run.id,
          issueId,
          agentId: agent.id,
          resolvedEnvironmentId: selectedEnvironmentId,
          forcedKubernetesEnvironmentId: kubernetesEnvironment.id,
        },
        "Forcing run onto the managed Kubernetes environment (executionMode=kubernetes)",
      );
    }
    selectedEnvironmentId = kubernetesEnvironment.id;
  }
  const selectedEnvironmentForConfig =
    selectedEnvironmentId === localEnvironment.id
      ? localEnvironment
      : selectedEnvironmentId
        ? await environmentsSvc.getById(selectedEnvironmentId)
        : null;
  const fixedBinding = readWorkspaceBinding(agent.runtimeConfig, context);
  if (fixedBinding) {
    assertFixedWorkspacePolicy({
      binding: fixedBinding, environment: selectedEnvironmentForConfig,
      trustPreset: trustPreset.kind, mode: requestedExecutionWorkspaceMode, isDot: isDotRun,
      external: await isExternalWorkspaceTask(db, agent.companyId, issueId),
      strategies: [config, config.workspaceStrategy, issueAssigneeOverrides?.adapterConfig?.workspaceStrategy,
        projectExecutionWorkspacePolicy?.workspaceStrategy, issueExecutionWorkspaceSettings?.workspaceStrategy],
    });
    if (persistedNativeExecutionInput && !fixedWorkspaceMatchesRun({
      binding: fixedBinding, environment: selectedEnvironmentForConfig,
      run: { runnerProfileJson: run.runnerProfileJson, contextSnapshot: run.contextSnapshot },
    })) {
      workspaceBindingConflict("admitted_session_conflict", "This execution is already bound to another host or directory. Stop and reconcile its ownership before starting a new session; its saved binding will not be rewritten.");
    }
  }
  const nativeChatWorkspaceScope = controllerOnly ? null : await findNativeChatWorkspaceScope(db, {
    adapterType: agent.adapterType,
    environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
    companyId: agent.companyId,
    agentId: agent.id,
    issueId,
    ...(fresh ? { freshAttemptId: run.id } : {}),
    admittedCwd: nativeExecutionUsesTaskWorkspace(persistedNativeExecutionInput)
      ? persistedNativeExecutionInput.workspace.cwd : null,
  });
  let nativeChatExpectedCwd = nativeChatWorkspaceScope
    ? nativeChatWorkspaceCwd(
        nativeChatWorkspaceScope,
        reusableExistingExecutionWorkspace,
        requestedShouldReuseExisting,
      )
    : null;
  if (
    nativeChatWorkspaceScope &&
    nativeExecutionUsesTaskWorkspace(persistedNativeExecutionInput) &&
    !nativeChatWorkspaceMatches({
      scope: nativeChatWorkspaceScope,
      expectedCwd: nativeChatExpectedCwd,
      execution: persistedNativeExecutionInput,
    })
  ) {
    // Never rewrite an admitted provider input or release ownership of an
    // older process whose permissions still include the shared agent home.
    throw new NativeRunnerOwnershipUnverifiedError(
      "native_chat_workspace_scope_mismatch",
    );
  }
  const materializeNativeChatWorktree = Boolean(
    nativeChatWorkspaceScope?.projectId && !persistedNativeExecutionInput && !existingExecutionWorkspace &&
    taskWorkspaceIntent?.selection.kind === "configured_source" &&
    taskWorkspaceIntent.selection.mode === "managed_isolated" &&
    requestedExecutionWorkspaceMode === "isolated_workspace" &&
    resolveEffectiveWorkspaceStrategyType(requestedExecutionWorkspaceMode, sourceWorkspaceConfig) === "git_worktree",
  );
  if (
    nativeChatWorkspaceScope &&
    ((!nativeChatExpectedCwd && !materializeNativeChatWorktree) ||
      executionProjectId !== nativeChatWorkspaceScope.projectId)
  ) {
    throw new ConfigurationIncompleteFailure(
      "External chat requires a task-owned isolated workspace. Select a managed isolated source or an existing task-owned isolated worktree; shared project workspaces cannot be used for external chat.",
      {
        configurationIncomplete: {
          reason: "native_chat_workspace_isolation_required",
          issueId,
        },
      },
    );
  }
  // A reused durable workspace keeps its runtime lease gate. Presentation
  // preferences and holder silence cannot authorize another writer.
  if (!nativeRecoveryExecutionWorkspaceId && reusableExistingExecutionWorkspace && !isMainManagedExecutionWorkspace(reusableExistingExecutionWorkspace) &&
      effectiveExecutionWorkspaceMode === "shared_workspace" &&
      selectedEnvironmentForConfig?.driver !== "local" && selectedEnvironmentForConfig?.driver !== "ssh") {
    const executionWorkspaceHolder = await findExecutionWorkspaceHolder({
      companyId: agent.companyId,
      executionWorkspaceId: reusableExistingExecutionWorkspace.id,
      excludeRunId: run.id,
    });
    if (executionWorkspaceHolder) {
      throw new WorkspaceBusyDeferral({
        holder: executionWorkspaceHolder,
        discloseHolder: executionWorkspaceHolder.issueId === issueId,
        executionWorkspaceId: reusableExistingExecutionWorkspace.id,
        deferralAttempt:
          run.scheduledRetryReason === WORKSPACE_BUSY_RETRY_REASON
            ? (run.scheduledRetryAttempt ?? 0)
            : 0,
        wasIssueAssignee: issueContext?.assigneeAgentId === agent.id,
      });
    }
  }
  // Source/project identity is a recipe, not ownership of a physical directory.
  // Workspace preparation claims the realized host path; managed runtimes retain
  // their workspace/lease gates. Independent copies of one source may overlap.
  if (!explicitSessionOnly && !controllerOnly && taskWorkspaceIntent && !boundSourceWorkspace && !nativeRecoveryExecutionWorkspaceId) {
    await executionWorkspacesSvc.validateStoredSelectionForRun({ companyId: agent.companyId,
      actor: { type: "agent", agentId: agent.id, companyId: agent.companyId, runId: run.id, source: "agent_jwt", onBehalfOfUserId: responsibleUserId === "local-board" ? null : responsibleUserId },
      selection: taskWorkspaceIntent.selection, issueId,
      preserveImplicitDefaultSettings: ["project", "task_default"].includes(taskWorkspaceIntent.source) });
  }
  const explicitTaskDirectory = !controllerOnly && taskWorkspaceIntent?.selection.kind === "task_directory";
  const explicitDirectoryStrategies = [
    ...(reusableExistingExecutionWorkspace?.providerType === "adapter_managed" ? [config.workspaceStrategy] : []),
    issueAssigneeOverrides?.adapterConfig?.workspaceStrategy,
    projectExecutionWorkspacePolicy?.workspaceStrategy, issueExecutionWorkspaceSettings?.workspaceStrategy];
  // Recovery may materialize a configured source as a task-owned directory.
  // Its saved realization, not today's project default, governs continuation.
  const savedRecoveryDirectory = !controllerOnly && !fresh && !nativeRecoveryExecutionWorkspaceId &&
    requestedShouldReuseExisting && requestedExecutionWorkspaceMode === "isolated_workspace" &&
    issueId !== null && issueRef !== null &&
    issueRef.projectId !== null && issueRef.projectWorkspaceId !== null &&
    reusableExistingExecutionWorkspace !== null &&
    reusableExistingExecutionWorkspace.projectId === issueRef.projectId &&
    reusableExistingExecutionWorkspace.projectWorkspaceId === issueRef.projectWorkspaceId &&
    reusableExistingExecutionWorkspace.metadata?._controllerProvisionCopyOnly === true &&
    await isBoundIsolatedTaskDirectory({ companyId: agent.companyId, issueId,
      workspaceId: issueRef.executionWorkspaceId, workspace: reusableExistingExecutionWorkspace });
  const boundTaskDirectory = !controllerOnly && !fresh && !nativeRecoveryExecutionWorkspaceId && issueId !== null && issueRef !== null &&
    requestedShouldReuseExisting && requestedExecutionWorkspaceMode === "isolated_workspace" &&
    !workspaceProjectContext?.hasWorkspace && !issueRef.projectWorkspaceId &&
    taskWorkspaceIntent?.selection.kind !== "configured_source" &&
    (taskWorkspaceIntent?.selection.kind !== "existing" || taskWorkspaceIntent.selection.workspaceId === issueRef.executionWorkspaceId) &&
    (await isBoundIsolatedTaskDirectory({ companyId: agent.companyId, issueId,
      workspaceId: issueRef.executionWorkspaceId, workspace: reusableExistingExecutionWorkspace }) ||
      (selectedEnvironmentForConfig?.driver === "plugin" && agent.adapterType === "paperclip_runner" &&
        isBoundFreshPluginTaskDirectory({ companyId: agent.companyId, issueId,
          workspaceId: issueRef.executionWorkspaceId, workspace: reusableExistingExecutionWorkspace,
          owner: { agentId: agent.id, environmentId: selectedEnvironmentForConfig.id,
            pluginKey: parseObject(selectedEnvironmentForConfig.config).pluginKey ?? null,
            driverKey: parseObject(selectedEnvironmentForConfig.config).driverKey ?? null } })));
  const reuseTaskDirectory = savedRecoveryDirectory || boundTaskDirectory && explicitDirectoryStrategies.every(value => {
    const strategy = parseObject(value);
    return Object.keys(strategy).length === 0 || (Object.keys(strategy).length === 1 && strategy.type === "project_primary");
  });
  if (retainedDirectory && !boundTaskDirectory && !savedRecoveryDirectory) throw new WorkspaceValidationFailure("The saved Retry task directory is unavailable.", {
    workspaceValidation: { reason: "isolated_task_directory_binding_mismatch", issueId },
  });
  const useIsolatedTaskDirectory = !controllerOnly && issueRef !== null && (reuseTaskDirectory || (fresh && !workspaceProjectContext?.hasWorkspace && !issueRef.projectWorkspaceId) || shouldUseIsolatedTaskDirectory({
    trustPreset: trustPreset.kind,
    environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
    mode: requestedExecutionWorkspaceMode,
    hasProjectWorkspace: workspaceProjectContext?.hasWorkspace ?? false,
    projectWorkspaceId: issueRef.projectWorkspaceId,
    workspaceStrategies: [
      config.workspaceStrategy,
      issueAssigneeOverrides?.adapterConfig?.workspaceStrategy,
      projectExecutionWorkspacePolicy?.workspaceStrategy,
      issueExecutionWorkspaceSettings?.workspaceStrategy,
    ],
  }));
  return {
    persistedRunnerProfile,
    persistedNativeExecutionInput,
    isDotRun,
    providerApiPlacement,
    existingExecutionWorkspace,
    nativeRecoveryExecutionWorkspaceId,
    workspaceReuseRequest,
    requestedShouldReuseExisting,
    reusableExistingExecutionWorkspace,
    requestedReusableExecutionWorkspaceConfig,
    localEnvironment,
    resolvedInstanceSettings,
    environmentResolution,
    effectiveExecutionWorkspaceMode,
    executionPolicy,
    selectedEnvironmentId,
    selectedEnvironmentForConfig,
    nativeChatWorkspaceScope,
    nativeChatExpectedCwd,
    materializeNativeChatWorktree,
    explicitTaskDirectory,
    useIsolatedTaskDirectory,
  };
}
