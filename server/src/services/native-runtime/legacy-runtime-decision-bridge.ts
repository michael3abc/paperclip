import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { questionSetToAskUserQuestionsPayload, type AskUserQuestionsInteraction } from "@paperclipai/shared";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { conflict, forbidden } from "../../errors.js";
import { normalizeAcpFormElicitation, parsePaperclipQuestionSet } from "../../vendor/paperclip-runner/index.js";
import { decisionFingerprint, readDecisionAuthority } from "../delegated-decision-policy.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { parseSavedQuestionInteractionAnswers } from "../question-interaction-answers.js";

const PREFIX = "paperclip-adapter-question:";
type Decision = Parameters<NonNullable<AdapterExecutionContext["onRuntimeDecision"]>>[0];
type Binding = { companyId: string; issueId: string; agentId: string; runId: string };
type Pending = Binding & {
  fingerprint: string; signal: AbortSignal; responseDelivery: Promise<void>;
  resolve: (value: Record<string, unknown>) => void;
  convert: (interaction: AskUserQuestionsInteraction) => Record<string, unknown>;
  answerFingerprint?: string;
};
const pending = new Map<string, Pending>();
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** One live callback owns the original provider request. No new task or wake
 * can substitute for a lost pipe after a process restart. */
export async function requestLegacyRuntimeDecision(db: Db, binding: Binding, input: Decision) {
  const raw = record(input.request);
  const tool = record(raw.toolCall);
  if (input.kind === "permission" && !["ExitPlanMode", "AskUserQuestion"].includes(String(tool.name ?? record(tool.rawInput).toolName))) return undefined;
  if (!input.responseDelivery) throw conflict("This adapter cannot acknowledge delivery to the original provider request");
  input.signal.throwIfAborted();
  const form = input.kind === "elicitation" ? normalizeAcpFormElicitation(raw as { mode: string }) : null;
  if (input.kind === "elicitation" && !form) throw conflict("Unsupported provider decision form");
  const questionSet = form?.questionSet ?? parsePaperclipQuestionSet({
    schema: "paperclip.question_set.v1", title: "Plan execution decision",
    description: JSON.stringify(tool.rawInput ?? {}).slice(0, 16_000),
    questions: [{ id: "decision", prompt: String(tool.title ?? tool.name ?? "Allow this plan?").slice(0, 4000), required: true,
      answerMode: "single_select", options: [{ id: "accept", label: "Allow once" }, { id: "decline", label: "Return for revision" }] }],
  });
  const requestId = createHash("sha256").update(`${input.kind}:${input.requestId}`).digest("hex");
  const key = `${PREFIX}${binding.runId}:${requestId}`;
  if (pending.has(key)) throw conflict("The provider decision already has an active response owner");
  let resolve!: Pending["resolve"];
  let reject!: (error: Error) => void;
  const response = new Promise<Record<string, unknown>>((yes, no) => { resolve = yes; reject = no; });
  // Creation can fail before a caller starts awaiting the deferred promise.
  void response.catch(() => {});
  const entry: Pending = { ...binding, fingerprint: decisionFingerprint(raw), signal: input.signal,
    responseDelivery: input.responseDelivery, resolve,
    convert(interaction) {
      const parsed = parseSavedQuestionInteractionAnswers(questionSet, interaction.result!.answers, interaction.payload.questions);
      if (form) return form.accept(parsed) as unknown as Record<string, unknown>;
      const choices = parsed.answers.decision?.selectedOptionIds;
      if (choices?.length !== 1 || !["accept", "decline"].includes(choices[0]!)) throw conflict("Choose one of the original plan decisions");
      return { outcome: choices[0] === "accept" ? "allow_once" : "reject_once" };
    },
  };
  const cleanup = () => { if (pending.get(key) === entry) pending.delete(key); input.signal.removeEventListener("abort", abort); };
  const abort = () => { cleanup(); reject(new Error("The original provider decision was cancelled")); };
  pending.set(key, entry);
  input.signal.addEventListener("abort", abort, { once: true });
  void input.responseDelivery.then(cleanup, error => { cleanup(); reject(error instanceof Error ? error : new Error("Provider response delivery failed")); });
  try {
    await issueThreadInteractionService(db).create({ id: binding.issueId, companyId: binding.companyId }, {
      kind: "ask_user_questions", sourceRunId: binding.runId, idempotencyKey: key, continuationPolicy: "none",
      title: questionSet.title?.slice(0, 240), payload: { ...questionSetToAskUserQuestionsPayload(questionSet),
        runtimeRequestId: requestId, runtimeRequestTurnId: binding.runId, runtimeRequestFingerprint: entry.fingerprint,
        supersedeOnUserComment: false },
    }, { agentId: binding.agentId, runId: binding.runId }, { supersedePendingSiblingInteractions: false, decisionRequestedAt: new Date() });
  } catch (error) { cleanup(); throw error; }
  return response;
}

export async function assertPendingLegacyDecision(db: Db, interaction: AskUserQuestionsInteraction) {
  if (!interaction.idempotencyKey?.startsWith(PREFIX)) return null;
  const entry = pending.get(interaction.idempotencyKey);
  if (!entry || entry.signal.aborted || entry.companyId !== interaction.companyId || entry.issueId !== interaction.issueId
    || entry.runId !== interaction.sourceRunId || entry.fingerprint !== interaction.payload.runtimeRequestFingerprint) {
    throw conflict("The original provider request is no longer active; no replacement run is permitted");
  }
  const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, entry.runId), eq(heartbeatRuns.agentId, entry.agentId), eq(heartbeatRuns.companyId, entry.companyId),
  )).limit(1);
  if (run?.status !== "running") throw conflict("The source worker run ended");
  return entry;
}

export async function deliverLegacyRuntimeDecision(db: Db, interaction: AskUserQuestionsInteraction): Promise<"not_native" | "queued"> {
  const entry = await assertPendingLegacyDecision(db, interaction);
  if (!entry) return "not_native";
  if (!interaction.result || interaction.status !== "answered") throw conflict("The provider request has no committed answer");
  if (interaction.resolvedByAgentId) {
    const context = interaction.delegation;
    const grant = context ? await readDecisionAuthority(db, interaction.companyId, context) : null;
    if (!grant || !context || grant.id !== context.grantId || grant.scope.revision !== context.grantRevision
      || context.recipientAgentId !== interaction.resolvedByAgentId || context.level === "human" || context.reservedReasons.length
      || !context.requiredScopes.every(scope => grant.scope.scopes.includes(scope))
      || context.sourceFingerprint !== decisionFingerprint({ kind: interaction.kind, payload: interaction.payload, sourceRunId: interaction.sourceRunId })) {
      throw forbidden("The delegated provider answer is no longer authorized");
    }
  }
  const fingerprint = decisionFingerprint(interaction.result);
  if (entry.answerFingerprint && entry.answerFingerprint !== fingerprint) throw conflict("The provider request already has another answer");
  const answer = entry.convert(interaction);
  entry.answerFingerprint = fingerprint;
  entry.resolve(answer);
  await entry.responseDelivery;
  return "queued";
}
