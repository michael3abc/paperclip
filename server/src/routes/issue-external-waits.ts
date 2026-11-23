import type { Request, Response, Router } from "express";
import type { Db, issues } from "@paperclipai/db";
import { completeIssueExternalWaitSchema, registerIssueExternalWaitSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertExternalWaitActor, issueExternalWaitService } from "../services/issue-external-waits.js";
import type { heartbeatService } from "../services/heartbeat.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function registerIssueExternalWaitRoutes(router: Router, db: Db, options: {
  heartbeat: Pick<ReturnType<typeof heartbeatService>, "wakeup">;
  read(req: Request, res: Response): Promise<typeof issues.$inferSelect | null>;
  mutate(req: Request, res: Response, issue: typeof issues.$inferSelect): Promise<boolean>;
}) {
  const service = issueExternalWaitService(db, options.heartbeat.wakeup);
  router.get("/issues/:id/external-waits", async (req, res) => {
    const issue = await options.read(req, res);
    if (!issue) return;
    assertCompanyAccess(req, issue.companyId);
    res.json(await service.list(issue));
  });
  const mutate = (operation: "register" | "complete" | "cancel") => async (req: Request, res: Response) => {
    const issue = await options.read(req, res);
    if (!issue) return;
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    assertExternalWaitActor(issue, actor);
    if (!await options.mutate(req, res, issue)) return;
    res.json(await service[operation](issue, actor, req.body));
  };
  router.post("/issues/:id/external-waits", validate(registerIssueExternalWaitSchema), mutate("register"));
  router.post("/issues/:id/external-waits/complete", validate(completeIssueExternalWaitSchema), mutate("complete"));
  router.post("/issues/:id/external-waits/cancel", validate(registerIssueExternalWaitSchema), mutate("cancel"));
}
