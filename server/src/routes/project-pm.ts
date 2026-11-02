import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, type Db } from "@paperclipai/db";
import {
  createPmIntakeSchema,
  isUuidLike,
  pmIntakeDedupeIdSchema,
  type CreatePmIntake,
  type PmIntakeLookup,
  type PmIntakeResult,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { heartbeatService, issueService, logActivity } from "../services/index.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { resolveActorSourceTrustForIssue } from "../services/source-trust.js";
import {
  buildPmIntakeCommentBody,
  findPmIntakeComment,
  isInPmReportsToChain,
  listPmWorkspaces,
  lockPmInbox,
  PM_INTAKE_MARKER_PREFIX,
  PM_INTAKE_WAKE_REASON,
  pmIntakeClientRequestId,
  pmIntakeWakeIdempotencyKey,
  resolvePmInbox,
  type PmInbox,
} from "../services/project-pm-intake.js";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

/**
 * Project PM endpoints (PM v2 contract §1): owner intake into the PM inbox and the
 * PM directory listing. Everything is scoped to the PM agent's company.
 */
export function projectPmRoutes(db: Db, opts: { pluginWorkerManager?: PluginWorkerManager } = {}) {
  const router = Router();
  const issues = issueService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: opts.pluginWorkerManager });

  /** 404 for a missing or cross-company PM (no existence oracle), then the write/read membership checks. */
  async function loadPmAgent(req: Request, pmAgentId: string) {
    const [pm] = isUuidLike(pmAgentId)
      ? await db.select({ id: agents.id, companyId: agents.companyId, name: agents.name, runtimeConfig: agents.runtimeConfig })
        .from(agents).where(eq(agents.id, pmAgentId)).limit(1)
      : [];
    if (!pm || !hasCompanyAccess(req, pm.companyId)) throw notFound("Agent not found");
    assertCompanyAccess(req, pm.companyId);
    return pm;
  }

  /** Board users of the company, or an agent that the PM reports to (directly or through its managers). */
  async function assertIntakeCaller(req: Request, pm: { id: string; companyId: string }) {
    if (req.actor.type === "board") return;
    if (req.actor.type === "agent" && req.actor.agentId
      && await isInPmReportsToChain(db, { companyId: pm.companyId, pmAgentId: pm.id, candidateAgentId: req.actor.agentId })) {
      return;
    }
    throw forbidden("Only a board user of the company or a manager in the PM's reportsTo chain can use the PM inbox");
  }

  async function wakePmForIntake(req: Request, pmAgentId: string, inbox: PmInbox, commentId: string, body: CreatePmIntake) {
    const actor = getActorInfo(req);
    const pmIntake = { dedupeId: body.dedupeId, source: body.source, sourceRef: body.sourceRef ?? null };
    try {
      const run = await heartbeat.wakeup(pmAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: PM_INTAKE_WAKE_REASON,
        payload: { issueId: inbox.id, commentId, mutation: "pm_intake", pmIntake },
        idempotencyKey: pmIntakeWakeIdempotencyKey(pmAgentId, body.dedupeId),
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: inbox.id,
          taskId: inbox.id,
          commentId,
          wakeCommentId: commentId,
          source: "pm.intake",
          wakeReason: PM_INTAKE_WAKE_REASON,
          pmIntake,
        },
      });
      return run?.id ?? null;
    } catch (err) {
      // The comment is committed. A retry with the same dedupeId re-enqueues the
      // wake when no wake request was recorded (see the duplicate branch).
      logger.warn({ err, pmAgentId, inboxIssueId: inbox.id, commentId }, "failed to enqueue PM intake wake");
      return null;
    }
  }

  router.post("/agents/:pmAgentId/pm-intake", validate(createPmIntakeSchema), async (req, res) => {
    const body = req.body as CreatePmIntake;
    const pm = await loadPmAgent(req, req.params.pmAgentId as string);
    await assertIntakeCaller(req, pm);
    // A marker inside the text could make a later receipt look like a duplicate.
    if (body.text.includes(PM_INTAKE_MARKER_PREFIX)) {
      throw unprocessable("text must not contain a ccpocket-intake receipt marker", { code: "pm_intake_marker_in_text" });
    }
    const { inbox } = await resolvePmInbox(db, pm);
    const actor = getActorInfo(req);
    const sourceTrust = await resolveActorSourceTrustForIssue({ db, issue: inbox, actor });
    const publications: ActivityPublication[] = [];
    const outcome = await db.transaction(async (tx) => {
      await lockPmInbox(tx, inbox.id);
      const existing = await findPmIntakeComment(tx, { companyId: pm.companyId, inboxIssueId: inbox.id, dedupeId: body.dedupeId });
      if (existing) return { kind: "duplicate" as const, commentId: existing.id };
      const comment = await issues.addComment(inbox.id, buildPmIntakeCommentBody(body), {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId,
        onBehalfOfUserId: req.actor.type === "agent" ? (req.actor.onBehalfOfUserId ?? null) : undefined,
      }, {
        authorType: actor.actorType === "agent" ? "agent" : "user",
        clientRequestId: pmIntakeClientRequestId(body.dedupeId),
        sourceTrust,
      }, tx);
      await logActivity(tx as unknown as Db, {
        companyId: pm.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        responsibleUserIdOverride: req.actor.type === "agent" ? (req.actor.onBehalfOfUserId ?? null) : undefined,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: inbox.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: inbox.identifier,
          issueTitle: inbox.title,
          pmAgentId: pm.id,
          pmIntake: { dedupeId: body.dedupeId, source: body.source, sourceRef: body.sourceRef ?? null },
        },
      }, publications);
      return { kind: "created" as const, commentId: comment.id };
    });
    for (const publication of publications) publishActivity(publication);

    if (outcome.kind === "duplicate") {
      // At-least-once wake: a first attempt that committed the comment but never
      // recorded its wake request (crash, wake failure) is completed by the retry.
      const [wakeRecorded] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, pm.companyId),
        eq(agentWakeupRequests.agentId, pm.id),
        eq(agentWakeupRequests.idempotencyKey, pmIntakeWakeIdempotencyKey(pm.id, body.dedupeId)),
      )).limit(1);
      if (!wakeRecorded) await wakePmForIntake(req, pm.id, inbox, outcome.commentId, body);
      res.status(200).json({ status: "duplicate", commentId: outcome.commentId, issueId: inbox.id, dedupeId: body.dedupeId } satisfies PmIntakeResult);
      return;
    }
    const runId = await wakePmForIntake(req, pm.id, inbox, outcome.commentId, body);
    res.status(201).json({ status: "created", commentId: outcome.commentId, issueId: inbox.id, runId, dedupeId: body.dedupeId } satisfies PmIntakeResult);
  });

  router.get("/agents/:pmAgentId/pm-intake/:dedupeId", async (req, res) => {
    const pm = await loadPmAgent(req, req.params.pmAgentId as string);
    await assertIntakeCaller(req, pm);
    const dedupeId = pmIntakeDedupeIdSchema.safeParse(req.params.dedupeId);
    if (!dedupeId.success) throw unprocessable("dedupeId must be 8-128 characters of [A-Za-z0-9:_-]");
    const { inbox } = await resolvePmInbox(db, pm);
    const found = await findPmIntakeComment(db, { companyId: pm.companyId, inboxIssueId: inbox.id, dedupeId: dedupeId.data });
    if (!found) {
      res.status(404).json({ status: "not_found" } satisfies PmIntakeLookup);
      return;
    }
    res.json({ status: "found", commentId: found.id, issueId: found.issueId, createdAt: new Date(found.createdAt).toISOString() } satisfies PmIntakeLookup);
  });

  router.get("/companies/:companyId/pm-workspaces", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!isUuidLike(companyId)) {
      res.json([]);
      return;
    }
    res.json(await listPmWorkspaces(db, companyId));
  });

  return router;
}
