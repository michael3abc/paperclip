import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { principalPermissionGrants, type Db } from "@paperclipai/db";
import type { AttentionSortMode } from "@paperclipai/shared";
import { accessService } from "../services/access.js";
import { attentionService } from "../services/attention.js";
import { decisionHistoryService } from "../services/decision-history.js";
import { z } from "zod";
import { badRequest, forbidden } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function optionalQueryString(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} must be a non-empty string`);
  return value.trim();
}

export function attentionRoutes(db: Db) {
  const router = Router();
  const svc = attentionService(db);
  const access = accessService(db);

  /**
   * Resolves whose attention set a read covers. Board users read their own.
   * An agent may read only its run's responsible user's set, and only with an
   * explicit `inbox:manage` grant that the responsible user's inbox policy
   * still admits. The result is further limited to tasks the agent can read;
   * it never grants resolution authority (decide, dismiss and triage routes
   * stay board-only).
   */
  async function attentionReader(req: Request, companyId: string): Promise<string> {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (!req.actor.userId) throw forbidden("Board user context required");
      return req.actor.userId;
    }
    if (req.actor.type !== "agent" || !req.actor.agentId) throw forbidden("Board access required");
    const userId = req.actor.onBehalfOfUserId?.trim();
    if (!userId) {
      throw forbidden("Attention reads require a responsible user", { code: "inbox_target_user_unresolved" });
    }
    const grant = await db.select({ id: principalPermissionGrants.id }).from(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.companyId, companyId),
      eq(principalPermissionGrants.principalType, "agent"),
      eq(principalPermissionGrants.principalId, req.actor.agentId),
      eq(principalPermissionGrants.permissionKey, "inbox:manage"),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (!grant) throw forbidden("Missing permission: inbox:manage", { code: "inbox_agent_not_allowed" });
    const decision = await access.decide({
      actor: req.actor,
      action: "inbox:manage",
      resource: { type: "company", companyId },
      scope: { userId },
    });
    if (!decision.allowed) {
      throw forbidden(decision.explanation, {
        code: decision.reason === "inbox_management_disabled" ? "inbox_management_disabled" : "inbox_agent_not_allowed",
        reason: decision.reason,
      });
    }
    return userId;
  }

  router.get("/companies/:companyId/attention/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = await attentionReader(req, companyId);
    res.json(await svc.summary(companyId, { userId: userId, actor: req.actor }));
  });

  router.get("/companies/:companyId/attention/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = await attentionReader(req, companyId);
    res.json(await svc.taskIndex(companyId, { userId: userId, actor: req.actor }));
  });

  router.get("/companies/:companyId/attention/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) { res.status(403).json({ error: "Board user context required" }); return; }
    const query = z.object({
      cursor: z.string().max(1000).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
      search: z.string().trim().max(200).optional(), outcome: z.string().max(40).optional(),
      agentId: z.string().uuid().optional(), projectId: z.string().uuid().optional(),
      sort: z.enum(["newest", "oldest"]).optional(), since: z.string().datetime().optional(),
    }).strict().safeParse(req.query);
    if (!query.success) throw badRequest("Invalid decision history filters");
    res.json(await decisionHistoryService(db).list(companyId, { ...query.data, actor: req.actor, userId: req.actor.userId }));
  });

  router.get("/companies/:companyId/attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = await attentionReader(req, companyId);

    const includeDismissed = req.query.includeDismissed === "true";
    const archived = req.query.archived === "true";
    const all = req.query.all === "true";
    const activitySince = optionalQueryString(req.query.activitySince, "activitySince");
    const activityUntil = optionalQueryString(req.query.activityUntil, "activityUntil");
    const queue = optionalQueryString(req.query.queue, "queue");
    const cursor = optionalQueryString(req.query.cursor, "cursor");
    const sortValue = optionalQueryString(req.query.sort, "sort");
    if (sortValue !== undefined && sortValue !== "activity" && sortValue !== "decide") {
      throw badRequest("sort must be 'activity' or 'decide'");
    }
    const limitValue = optionalQueryString(req.query.limit, "limit");
    const limit = limitValue === undefined ? undefined : Number(limitValue);
    if (limit !== undefined && !Number.isInteger(limit)) throw badRequest("limit must be an integer");
    const feed = await svc.list(companyId, {
      userId,
      includeDismissed,
      actor: req.actor,
      archived,
      all,
      allowUnscopedAll: all,
      activitySince,
      activityUntil,
      queue,
      cursor,
      sort: sortValue as AttentionSortMode | undefined,
      limit,
    });
    res.json(feed);
  });

  return router;
}
