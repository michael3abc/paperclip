import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { projects, type Db } from "@paperclipai/db";
import { z } from "zod";
import { mainManagedWorktreeService } from "../services/main-managed-worktrees.js";
import { validate } from "../middleware/validate.js";
import { getAccessibleResource } from "./authz.js";

import { managedWorktreeOperationSchema, managedWorktreeRecheckSchema } from "@paperclipai/shared";

export function mainManagedWorktreeRoutes(db: Db) {
  const router = Router(), service = mainManagedWorktreeService(db);
  async function scope(req: Request, res: Response) {
    const projectId = z.string().uuid().parse(req.params.projectId), workspaceId = z.string().uuid().parse(req.params.id);
    const project = await getAccessibleResource(req, res, db.select().from(projects).where(and(eq(projects.id, projectId)))
      .then(rows => rows[0] ?? null), "Project not found");
    return project ? { companyId: project.companyId, projectId, workspaceId, actor: req.actor } : null;
  }
  router.get("/projects/:projectId/worktrees/:id", async (req, res) => {
    const bound = await scope(req, res); if (!bound) return;
    res.json(await service.inspect(bound));
  });
  router.post("/projects/:projectId/worktrees/:id/operations", validate(managedWorktreeOperationSchema), async (req, res) => {
    const bound = await scope(req, res); if (!bound) return;
    res.json(await service.operate(bound, req.body));
  });
  router.post("/projects/:projectId/worktrees/:id/recheck", validate(managedWorktreeRecheckSchema), async (req, res) => {
    const bound = await scope(req, res); if (!bound) return;
    res.json(await service.recheck(bound, req.body.operationId, req.body.expectedGeneration));
  });
  return router;
}
