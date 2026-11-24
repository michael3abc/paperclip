import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { forbidden } from "../errors.js";
import { companyService } from "../services/companies.js";
import { listTerminalHosts } from "../services/host-terminal-registry.js";
import type { HostTerminalSessions } from "../services/host-terminal-sessions.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

export function hostTerminalRoutes(db: Db, sessions: HostTerminalSessions) {
  const router = Router();
  router.use("/companies/:companyId/host-terminals", async (req, res, next) => {
    // No implicit local board, board API key, agent JWT or delegated run token.
    if (req.actor.type !== "board" || req.actor.source !== "session" || !req.actor.userId) throw forbidden("A signed-in human administrator is required");
    assertInstanceAdmin(req);
    assertCompanyAccess(req, req.params.companyId as string);
    if (!await companyService(db).getById(req.params.companyId as string)) {
      res.status(404).json({ error: "Company not found" }); return;
    }
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });
  router.get("/companies/:companyId/host-terminals", async (req, res) => {
    res.json((await listTerminalHosts(req.params.companyId as string)).map(({ id, label }) => ({ id, label })));
  });
  router.post("/companies/:companyId/host-terminals/:hostId/sessions", async (req, res) => {
    if (!z.object({}).strict().safeParse(req.body ?? {}).success) {
      res.status(400).json({ error: "Only the registered host ID is accepted" }); return;
    }
    const companyId = req.params.companyId as string, hostId = req.params.hostId as string;
    const session = await sessions.create({ companyId, hostId, userId: req.actor.userId! });
    res.status(201).json({ ...session, wsPath: `/api/companies/${encodeURIComponent(companyId)}/host-terminals/${encodeURIComponent(hostId)}/ws` });
  });
  return router;
}
