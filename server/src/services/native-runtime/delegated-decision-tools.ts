import { z } from "zod";
import { escalateDelegatedRequestSchema, resolveDelegatedRequestSchema } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { conflict, forbidden, HttpError } from "../../errors.js";
import { escalateDelegatedRequest, getDelegatedRequest, listDelegatedRequests, type DelegatedRequestActor } from "../delegated-requests.js";

const getSchema = z.object({ kind: z.enum(["interaction", "approval"]), requestId: z.string().uuid() }).strict();
export const DELEGATED_DECISION_TOOLS = [
  { name: "list_delegated_requests", description: "List pending decisions explicitly assigned to you. Do this on a delegated-decision wake; several requests may share a wake. Read each request before deciding.", inputSchema: z.toJSONSchema(z.object({}).strict()) },
  { name: "get_delegated_request", description: "Read the exact delegated request, source task, current revision and decision authority. This does not claim or reassign the worker's task.", inputSchema: z.toJSONSchema(getSchema) },
  { name: "resolve_delegated_request", description: "Answer or decide one assigned request at its observed revision. Include a reason. Use action=answer and response.answers for questions, accept/reject for plans and approvals. This resumes the original request; it grants no general administrator rights.", inputSchema: z.toJSONSchema(resolveDelegatedRequestSchema) },
  { name: "escalate_delegated_request", description: "Escalate an undecidable request once: project PM to the company delegate, delegate to the human Owner. Reserved or uncertain matters stay pending for the human. Never create a replacement task or imply approval.", inputSchema: z.toJSONSchema(escalateDelegatedRequestSchema) },
];

export async function executeDelegatedDecisionTool(input: {
  db: Db; actor: DelegatedRequestActor; name: string; arguments: unknown;
  apiUrl: string; token: string;
}) {
  if (input.name === "list_delegated_requests") return listDelegatedRequests(input.db, input.actor);
  if (input.name === "get_delegated_request") {
    const request = getSchema.parse(input.arguments);
    return getDelegatedRequest(input.db, input.actor, request.kind, request.requestId);
  }
  if (input.name === "escalate_delegated_request") return escalateDelegatedRequest(input.db, input.actor, input.arguments);
  const request = resolveDelegatedRequestSchema.parse(input.arguments);
  if (request.kind === "runtime") throw forbidden("Use the interaction linked to this runtime request");
  const current = await getDelegatedRequest(input.db, input.actor, request.kind, request.requestId);
  if (current.revision !== request.revision) throw conflict("The delegated request changed; reread it before deciding");
  let path: string;
  let body: Record<string, unknown>;
  if (request.kind === "approval") {
    if (request.action !== "accept" && request.action !== "reject") throw forbidden("An approval requires accept or reject");
    path = `/approvals/${request.requestId}/${request.action === "accept" ? "approve" : "reject"}`;
    body = { decisionNote: request.reason, delegationRevision: request.revision,
      ...("type" in current.request && current.request.type === "budget_override_required" ? { budgetResolution: request.response?.budgetResolution } : {}) };
  } else {
    if (!current.issueId) throw forbidden("The source task is unavailable");
    const interaction = current.request as { kind?: string; payload?: { runtimeRequestId?: string; questionSet?: { questions: { id: string; options?: { id: string }[] }[] } } };
    const permission = interaction.kind === "ask_user_questions" && interaction.payload?.runtimeRequestId
      && interaction.payload.questionSet?.questions.length === 1 && interaction.payload.questionSet.questions[0]?.id === "decision";
    const decision = permission && ["allow", "accept", "reject"].includes(request.action)
      ? request.action === "reject" ? "decline" : "accept" : null;
    if (decision && !interaction.payload!.questionSet!.questions[0]!.options?.some(option => option.id === decision)) throw forbidden("This original request does not offer the requested decision");
    const action = decision ? "answer" : request.action;
    const verdicts = interaction.kind === "request_item_verdicts";
    if (verdicts && action !== "answer") throw forbidden("Item review requires action=answer with response.verdicts");
    path = `/issues/${current.issueId}/interactions/${request.requestId}/${verdicts ? "verdicts" : action === "answer" ? "respond" : action === "allow" ? "accept" : action}`;
    body = { ...request.response, ...(decision ? { answers: [{ questionId: "decision", optionIds: [decision] }] } : {}),
      ...(action === "answer" && !verdicts ? { summaryMarkdown: request.reason } : { reason: request.reason }), delegationRevision: request.revision };
  }
  // Existing endpoints own continuation, task-plan effects, original runtime
  // response delivery and activity. Do not duplicate that pipeline in tools.
  if (!input.apiUrl || !input.token) throw conflict("The controlled decision API binding is unavailable; the request remains pending");
  const response = await fetch(`${input.apiUrl.replace(/\/$/, "")}/api${path}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json", "X-Paperclip-Run-Id": input.actor.runId },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new HttpError(response.status, typeof result.error === "string" ? result.error : "Delegated decision rejected", result.details);
  return result;
}
