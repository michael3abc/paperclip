import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { upsertCompanySidebarPreferenceSchema, upsertSidebarOrderPreferenceSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, sidebarPreferenceService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function requireBoardUserId(req: Request, res: Response): string | null {
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function sidebarPreferenceRoutes(db: Db) {
  const router = Router();
  const svc = sidebarPreferenceService(db);

  router.get("/sidebar-preferences/me", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await svc.getCompanyOrder(userId));
  });

  router.put("/sidebar-preferences/me", validate(upsertSidebarOrderPreferenceSchema), async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await svc.upsertCompanyOrder(userId, req.body.orderedIds));
  });

  router.get("/companies/:companyId/sidebar-preferences/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await svc.getProjectOrder(companyId, userId));
  });

  router.put(
    "/companies/:companyId/sidebar-preferences/me",
    validate(upsertCompanySidebarPreferenceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireBoardUserId(req, res);
      if (!userId) return;

      const { orderedIds, excludedPmStatusAgentIds } = req.body as {
        orderedIds?: string[];
        excludedPmStatusAgentIds?: string[];
      };
      const result = await svc.upsertCompanyPreference(companyId, userId, {
        orderedIds,
        excludedPmStatusAgentIds,
      });
      const actor = getActorInfo(req);
      const audit = {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        entityType: "company",
        entityId: companyId,
      } as const;
      if (orderedIds !== undefined) {
        await logActivity(db, {
          ...audit,
          action: "sidebar_preferences.project_order_updated",
          details: { userId, orderedIds: result.orderedIds },
        });
      }
      if (excludedPmStatusAgentIds !== undefined) {
        await logActivity(db, {
          ...audit,
          action: "sidebar_preferences.pm_status_exclusions_updated",
          details: { userId, excludedPmStatusAgentIds: result.excludedPmStatusAgentIds },
        });
      }
      res.json(result);
    },
  );

  return router;
}
