import { notifyLiveRunRecovery } from "../live-run-recovery-notifications.js";
import { assertPendingLegacyDecision, deliverLegacyRuntimeDecision } from "./legacy-runtime-decision-bridge.js";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueThreadInteractions } from "@paperclipai/db";
import type {
  AskUserQuestionsInteraction,
  RespondIssueThreadInteraction,
} from "@paperclipai/shared";

import { questionSetToAskUserQuestionsPayload } from "@paperclipai/shared";

import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import {
  parsePaperclipQuestionSet,
  type PaperclipQuestionSet,
} from "../../vendor/paperclip-runner/index.js";
import { logger } from "../../middleware/logger.js";
import { unprocessable } from "../../errors.js";
import { conflict, forbidden } from "../../errors.js";
import { approvalReservedReasons, decisionFingerprint, readDecisionDelegation } from "../delegated-decision-policy.js";
import { readPendingNativeRuntimeRequest } from "./runtime-request-resolution-authority.js";
import { logActivity } from "../activity-log.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { questionResponseDeliveryService } from "../question-response-delivery.js";
import type { NativeRunStoreBinding } from "./native-run-coordinator-store.js";

import { parseQuestionInteractionAnswers, parseSavedQuestionInteractionAnswers } from "../question-interaction-answers.js";

const QUESTION_KEY_PREFIX = "paperclip-runner-question:";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export const NATIVE_QUESTION_CANCELLATION_CONTEXT_KEY = "nativeQuestionCancellation";

type QueueCommand = (
  type: string,
  payload?: Record<string, unknown>,
  commandId?: string,
) => { readonly commandId: string; readonly controllerSeq: number } | Promise<{ readonly commandId: string; readonly controllerSeq: number }>;

interface NativeQuestionCommandTarget {
  binding: Pick<NativeRunStoreBinding, "companyId" | "issueId" | "runId" | "agentId">;
  queueCommand: QueueCommand;
}

const activeTargets = new Map<string, NativeQuestionCommandTarget>();

interface NativeQuestionIdentity {
  idempotencyKey?: string | null;
  sourceRunId?: string | null;
  payload: unknown;
}

export interface NativeQuestionAuthorizationIdentity extends NativeQuestionIdentity {
  companyId: string;
  issueId: string;
}

export type NativeQuestionCancellationCause =
  | { kind: "issue_terminal"; issueStatus: string }
  | { kind: "interaction_withdrawn"; interactionId: string }
  | { kind: "interaction_cancelled"; interactionId: string };

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type NativeQuestionMutationDb = Pick<Db | DbTransaction, "select" | "update">;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requestIdForInteraction(
  interaction: NativeQuestionIdentity,
): string | null {
  const payload = record(interaction.payload);
  if (!interaction.sourceRunId || !payload?.questionSet) return null;
  const key = interaction.idempotencyKey;
  const expectedPrefix = `${QUESTION_KEY_PREFIX}${interaction.sourceRunId}:`;
  if (!key?.startsWith(expectedPrefix)) return null;
  const requestId = key.slice(expectedPrefix.length);
  if (!REQUEST_ID_PATTERN.test(requestId)) return null;
  return typeof payload.runtimeRequestId === "string" && payload.runtimeRequestId !== requestId
    ? null
    : requestId;
}

function toInteractionPayload(questionSet: PaperclipQuestionSet, runtimeRequestId: string) {
  return {
    ...questionSetToAskUserQuestionsPayload(questionSet),
    runtimeRequestId,
    // A generic task comment cannot satisfy this provider request.
    supersedeOnUserComment: false,
  };
}


async function authorizedNativeRun(
  db: Pick<Db | DbTransaction, "select">,
  interaction: NativeQuestionAuthorizationIdentity,
) {
  const requestId = requestIdForInteraction(interaction);
  if (!requestId || !interaction.sourceRunId) return null;
  const run = await db.select({
    id: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    issueId: heartbeatRuns.nativeIssueId,
    agentId: heartbeatRuns.agentId,
    runtimeMode: heartbeatRuns.runtimeMode,
    status: heartbeatRuns.status,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, interaction.sourceRunId),
    eq(heartbeatRuns.companyId, interaction.companyId),
    eq(heartbeatRuns.nativeIssueId, interaction.issueId),
    eq(heartbeatRuns.runtimeMode, "native"),
  )).limit(1).then((rows) => rows[0] ?? null);
  return run ? { ...run, requestId } : null;
}

/** Materialize new delegated requests; historical privileged cards keep their policy. */
export async function projectNativeRuntimeRequest(input: {
  db: Db;
  binding: Pick<NativeRunStoreBinding, "companyId" | "issueId" | "runId" | "agentId" | "normalizedSessionId" | "runnerSourceInstanceId">;
  event: PrpEvent;
}): Promise<AskUserQuestionsInteraction | null> {
  if (input.event.eventType !== "runtime_request.created") return null;
  if (
    input.event.runId !== input.binding.runId
    || input.event.normalizedSessionId !== input.binding.normalizedSessionId
    || input.event.sourceInstanceId !== input.binding.runnerSourceInstanceId
  ) {
    throw new Error("native_runtime_request_binding_mismatch");
  }
  const request = record(record(input.event.payload)?.request);
  if (
    !request
    || request.schema !== "paperclip.runtime_request.v2"
    || request.status !== "pending"
    || typeof request.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(request.requestId)
  ) {
    throw new Error("native_runtime_request_invalid");
  }
  const grant = await readDecisionDelegation(input.db, input.binding.companyId);
  const delegationEligible = Boolean(grant && Date.parse(input.event.emittedAt) >= Date.parse(grant.scope.activatedAt));
  let questionSet: PaperclipQuestionSet;
  if (["permission_approval", "command_approval", "file_approval"].includes(String(request.requestKind)) && request.type === "permission") {
    const choices = Array.isArray(request.choices) ? request.choices.map(record) : [];
    const supported = new Set(["accept", "accept_for_session", "decline", "cancel"]);
    if (
      typeof request.turnId !== "string"
      || request.turnId !== input.event.turnId
      || (request.itemId != null && typeof request.itemId !== "string")
      || (request.itemId ?? null) !== (input.event.itemId ?? null)
      || typeof request.prompt !== "string"
      || !request.prompt.trim()
      || request.prompt.length > 4000
      || choices.length === 0
      || choices.length > 4
      || choices.some((choice) => !choice
        || typeof choice.key !== "string" || !supported.has(choice.key)
        || typeof choice.label !== "string" || !choice.label.trim() || choice.label.length > 500)
      || new Set(choices.map((choice) => choice?.key)).size !== choices.length
      || (request.details !== undefined && !record(request.details))
    ) {
      throw new Error("native_runtime_permission_invalid");
    }
    if (!delegationEligible) return null;
    questionSet = parsePaperclipQuestionSet({ schema: "paperclip.question_set.v1", title: "Execution decision",
      description: JSON.stringify(request.details ?? {}).slice(0, 16_000),
      questions: [{ id: "decision", prompt: request.prompt, required: true, answerMode: "single_select",
        options: choices.map(choice => ({ id: choice!.key, label: choice!.label })) }] });
  } else if (request.requestKind === "runtime" && request.type === "input") {
    questionSet = parsePaperclipQuestionSet(request.input);
  } else {
    throw new Error("native_runtime_request_invalid");
  }
  if (questionSet.questions.some((question) => question.textValidation?.pattern !== undefined)) {
    // JavaScript regular expressions have no execution budget. Provider-authored
    // patterns therefore stay fail-closed until the runner contract supplies a
    // bounded regex dialect rather than exposing the server to catastrophic backtracking.
    throw new Error("native_runtime_question_pattern_unsupported");
  }
  const idempotencyKey = `${QUESTION_KEY_PREFIX}${input.binding.runId}:${request.requestId}`;
  const existing = await input.db.select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, input.binding.companyId),
      eq(issueThreadInteractions.issueId, input.binding.issueId),
      eq(issueThreadInteractions.idempotencyKey, idempotencyKey),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const interaction = await issueThreadInteractionService(input.db).create(
    { id: input.binding.issueId, companyId: input.binding.companyId },
    {
      kind: "ask_user_questions",
      idempotencyKey,
      ...(!delegationEligible ? { resolverPolicy: "human_only" as const } : {}),
      sourceRunId: input.binding.runId,
      continuationPolicy: "none",
      ...(questionSet.title ? { title: questionSet.title.slice(0, 240) } : {}),
      ...(typeof request.prompt === "string" ? { summary: request.prompt.slice(0, 1000) } : {}),
      payload: { ...toInteractionPayload(questionSet, request.requestId),
        runtimeRequestTurnId: String(request.turnId ?? input.event.turnId), runtimeRequestFingerprint: decisionFingerprint(request) },
    },
    { agentId: input.binding.agentId, runId: input.binding.runId },
    { supersedePendingSiblingInteractions: false, decisionRequestedAt: new Date(input.event.emittedAt),
      decisionReservedReasons: approvalReservedReasons("request_board_approval", record(request.details) ?? {}) },
  ) as AskUserQuestionsInteraction;
  if (!existing) {
    await logActivity(input.db, {
      companyId: input.binding.companyId,
      actorType: "agent",
      actorId: input.binding.agentId,
      agentId: input.binding.agentId,
      runId: input.binding.runId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: input.binding.issueId,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        runtimeMode: "native",
      },
    });
  }
  if (interaction.status === "answered") {
    await deliverNativeQuestionResponseDurably(input.db, interaction);
  }
  return interaction;
}

/** Validate untrusted board input before the existing interaction service persists it. */
export async function assertPendingNativeQuestionAnswer(db: Db, interaction: AskUserQuestionsInteraction,
  answers: RespondIssueThreadInteraction["answers"], agentId: string | null) {
  if (await assertPendingLegacyDecision(db, interaction)) return;
  if (!requestIdForInteraction(interaction)) return;
  const run = await authorizedNativeRun(db, interaction);
  if (!run || run.status !== "running") throw conflict("The source runtime turn is no longer running");
  const pending = await readPendingNativeRuntimeRequest(db, { companyId: interaction.companyId, runId: run.id, requestId: run.requestId });
  if (!pending || pending.fingerprint !== interaction.payload.runtimeRequestFingerprint
    || pending.turnId !== interaction.payload.runtimeRequestTurnId) throw conflict("The original runtime request changed or ended");
  if (pending.resolverPolicy === "instance_admin") {
    const parsed = await parseQuestionInteractionAnswers(interaction.payload.questionSet!, answers, interaction.payload.questions);
    const selected = parsed.answers.decision?.selectedOptionIds;
    const choices = pending.canonicalRequest?.choices as { key: string }[] | undefined;
    if (!selected || selected.length !== 1 || !choices?.some(choice => choice.key === selected[0])) throw unprocessable("Choose one of the original runtime decisions");
    if (agentId && selected[0] === "accept_for_session") throw forbidden("Session-wide permission changes require human approval; escalate this request");
  }
}

export async function validateNativeQuestionResponseInput(
  interaction: AskUserQuestionsInteraction,
  input: RespondIssueThreadInteraction,
): Promise<void> {
  if (!requestIdForInteraction(interaction) || !interaction.payload.questionSet) return;
  try {
    await parseQuestionInteractionAnswers(interaction.payload.questionSet, input.answers, interaction.payload.questions);
  } catch (error) {
    throw unprocessable(
      error instanceof Error ? error.message : "Invalid native question response",
      { code: "invalid_question_response" },
    );
  }
}

/** Recheck an already committed agent answer at the provider dispatch edge.
 * The deciding run may have finished; the exact grant and source request may not change. */
export async function assertNativeQuestionCommandAuthorized(db: Db,
  binding: NativeQuestionCommandTarget["binding"], commandId: string | undefined, requestId: string) {
  if (!commandId?.startsWith("question_")) throw forbidden("A durable question response identity is required");
  const interactionId = commandId.slice("question_".length);
  const [row] = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.companyId, binding.companyId),
    eq(issueThreadInteractions.issueId, binding.issueId), eq(issueThreadInteractions.sourceRunId, binding.runId),
  )).limit(1);
  if (!row || row.status !== "answered" || row.kind !== "ask_user_questions"
    || record(row.payload)?.runtimeRequestId !== requestId) throw conflict("The original question answer is unavailable");
  if (!row.delegation || !row.resolvedByAgentId) return;
  const grant = await readDecisionDelegation(db, binding.companyId);
  const context = row.delegation;
  if (!grant || grant.id !== context.grantId || grant.scope.revision !== context.grantRevision
    || grant.agentId !== context.delegateAgentId || context.recipientAgentId !== row.resolvedByAgentId
    || context.level === "human" || context.reservedReasons.length
    || !context.requiredScopes.every(scope => grant.scope.scopes.includes(scope))
    || context.sourceFingerprint !== decisionFingerprint({ kind: row.kind, payload: row.payload, sourceRunId: row.sourceRunId })) {
    throw forbidden("The delegated runtime answer is no longer authorized");
  }
}

/** Queue an answered interaction into the active durable PRP command stream. */
export async function deliverNativeQuestionResponse(
  db: Db,
  interaction: AskUserQuestionsInteraction,
): Promise<"not_native" | "pending" | "queued"> {
  if (interaction.status !== "answered" || !interaction.result || !interaction.payload.questionSet) {
    return "not_native";
  }
  const legacy = await deliverLegacyRuntimeDecision(db, interaction);
  if (legacy !== "not_native") return legacy;
  const run = await authorizedNativeRun(db, interaction);
  // A historical question can be answered after its provider turn has ended.
  // Fall through to durable fresh-wake delivery instead of waiting forever for
  // a command target that cannot return for this terminal run.
  if (!run || ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)) {
    if (interaction.delegation && requestIdForInteraction(interaction)) throw conflict("The original runtime turn ended; this decision cannot start a replacement run");
    return "not_native";
  }
  const response = parseSavedQuestionInteractionAnswers(interaction.payload.questionSet, interaction.result.answers, interaction.payload.questions);
  const pending = interaction.payload.runtimeRequestFingerprint
    ? await readPendingNativeRuntimeRequest(db, { companyId: interaction.companyId, runId: run.id, requestId: run.requestId }) : null;
  if (interaction.delegation) {
    if (!pending || pending.fingerprint !== interaction.payload.runtimeRequestFingerprint
      || pending.turnId !== interaction.payload.runtimeRequestTurnId) throw conflict("The original runtime request is no longer current");
    if (interaction.resolvedByAgentId) {
      const grant = await readDecisionDelegation(db, interaction.companyId);
      if (!grant || grant.id !== interaction.delegation.grantId || grant.scope.revision !== interaction.delegation.grantRevision
        || grant.agentId !== interaction.delegation.delegateAgentId
        || !interaction.delegation.requiredScopes.every(scope => grant.scope.scopes.includes(scope))
        || interaction.delegation.recipientAgentId !== interaction.resolvedByAgentId
        || interaction.delegation.level === "human" || interaction.delegation.reservedReasons.length
        || interaction.delegation.sourceFingerprint !== decisionFingerprint({ kind: interaction.kind,
          payload: interaction.payload, sourceRunId: interaction.sourceRunId })) throw forbidden("The delegated runtime decision is no longer authorized");
    }
  }
  let resolution: Record<string, unknown> | null = null;
  if (pending?.resolverPolicy === "instance_admin") {
    const selected = response.answers.decision?.selectedOptionIds;
    const choices = pending.canonicalRequest?.choices as { key: string }[] | undefined;
    if (!selected || selected.length !== 1 || !choices?.some(choice => choice.key === selected[0])) throw unprocessable("Choose one of the original runtime decisions");
    if (interaction.resolvedByAgentId && selected[0] === "accept_for_session") throw forbidden("Session-wide permission changes require the human Owner");
    resolution = { action: selected[0] };
  }
  const target = activeTargets.get(run.id);
  if (
    !target
    || target.binding.companyId !== run.companyId
    || target.binding.issueId !== run.issueId
    || target.binding.agentId !== run.agentId
  ) {
    return "pending";
  }
  try {
    await target.queueCommand(
      "request.resolve",
      { requestId: run.requestId, ...(pending ? { turnId: pending.turnId } : {}),
        ...(resolution ? { resolution } : { response: response as unknown as Record<string, unknown> }) },
      `question_${interaction.id}`,
    );
    return "queued";
  } catch (error) {
    logger.warn(
      { err: error, runId: run.id, interactionId: interaction.id },
      "native question response remains durable for session recovery",
    );
    return "pending";
  }
}

async function deliverNativeQuestionResponseDurably(
  db: Db,
  interaction: AskUserQuestionsInteraction,
): Promise<void> {
  await questionResponseDeliveryService(db, {
    heartbeat: {
      wakeup: async () => {
        throw new Error("native_question_wake_unreachable");
      },
    } as never,
    resolveNativeQuestion: (candidate) => deliverNativeQuestionResponse(db, candidate),
  }).deliver(interaction.id);
}

export async function flushNativeQuestionResponses(
  db: Db,
  runId: string,
): Promise<void> {
  const target = activeTargets.get(runId);
  if (!target) return;
  const interactions = await issueThreadInteractionService(db).listForIssue(target.binding.issueId);
  for (const interaction of interactions) {
    if (
      interaction.kind === "ask_user_questions"
      && interaction.sourceRunId === runId
      && interaction.status === "answered"
    ) {
      await deliverNativeQuestionResponseDurably(db, interaction);
    }
  }
}

export function registerNativeQuestionCommandTarget(target: NativeQuestionCommandTarget): () => void {
  const existing = activeTargets.get(target.binding.runId);
  if (existing) throw new Error("native_question_command_target_conflict");
  activeTargets.set(target.binding.runId, target);
  return () => {
    if (activeTargets.get(target.binding.runId) === target) {
      activeTargets.delete(target.binding.runId);
    }
  };
}

export async function nativeQuestionRunToCancel(
  db: Db,
  interaction: NativeQuestionAuthorizationIdentity,
): Promise<string | null> {
  const run = await authorizedNativeRun(db, interaction);
  return run && ["queued", "running"].includes(run.status) ? run.id : null;
}

/**
 * Persist cancellation intent in the same transaction that closes the issue.
 * The post-commit fast path and the heartbeat recovery sweep both consume this
 * marker, so process exit or a transient process-termination failure cannot
 * strand a native run after the task closes, even if its question is retained.
 */
export async function requestNativeQuestionRunCancellation(
  db: NativeQuestionMutationDb,
  interaction: NativeQuestionAuthorizationIdentity,
  cause: NativeQuestionCancellationCause,
): Promise<string | null> {
  const run = await authorizedNativeRun(db, interaction);
  if (!run || !["queued", "running"].includes(run.status)) return null;
  const marker = JSON.stringify({
    version: 1,
    issueId: interaction.issueId,
    ...cause,
    requestedAt: new Date().toISOString(),
  });
  await notifyLiveRunRecovery(db, { companyId: interaction.companyId, runId: run.id });
  return db.update(heartbeatRuns).set({
    contextSnapshot: sql`jsonb_set(
      case
        when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
          then ${heartbeatRuns.contextSnapshot}
        else '{}'::jsonb
      end,
      array[${NATIVE_QUESTION_CANCELLATION_CONTEXT_KEY}],
      ${marker}::jsonb,
      true
    )`,
    updatedAt: new Date(),
  }).where(and(
    eq(heartbeatRuns.id, run.id),
    eq(heartbeatRuns.companyId, interaction.companyId),
    eq(heartbeatRuns.nativeIssueId, interaction.issueId),
    eq(heartbeatRuns.runtimeMode, "native"),
    inArray(heartbeatRuns.status, ["queued", "running"]),
  )).returning({ id: heartbeatRuns.id }).then((rows) => rows[0]?.id ?? null);
}

/** Capture the minimum bound identity needed to cancel after the issue transaction commits. */
export function nativeQuestionCancellationIdentity(
  interaction: NativeQuestionAuthorizationIdentity,
): NativeQuestionAuthorizationIdentity | null {
  if (!requestIdForInteraction(interaction)) return null;
  return {
    companyId: interaction.companyId,
    issueId: interaction.issueId,
    sourceRunId: interaction.sourceRunId,
    payload: interaction.payload,
    idempotencyKey: interaction.idempotencyKey,
  };
}

export const nativeQuestionBridgeInternals = {
  resetForTests: () => activeTargets.clear(),
};
