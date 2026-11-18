import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { companyService } from "../services/companies.js";
import { fetchHostSubscriptionQuotas } from "../services/host-subscription-quotas.js";
import { listHostClaudeLogins, checkHostClaudeLogin, startHostClaudeLogin, hostClaudeSession } from "../services/host-claude-login.js";
import {
  DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT,
  MAX_WINDOW_WEEKS,
  recoveryObservabilityService,
} from "../services/recovery-observability.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

function parsePositiveNumber(
  value: unknown,
  fallback: number,
  max?: number,
): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return max != null ? Math.min(parsed, max) : parsed;
}

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);
  const recoveryObservability = recoveryObservabilityService(db);
  const loginPath = "/companies/:companyId/dashboard/host-claude";
  router.use(loginPath, async (req, res, next) => {
    assertInstanceAdmin(req);
    assertCompanyAccess(req, req.params.companyId as string);
    if (!await companyService(db).getById(req.params.companyId as string)) {
      res.status(404).json({ error: "Company not found" }); return;
    }
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });
  router.get(loginPath, async (req, res) => {
    res.json(await listHostClaudeLogins(req.params.companyId as string));
  });
  router.post(loginPath + "/:hostId/check", async (req, res) => {
    res.json(await checkHostClaudeLogin(req.params.companyId as string, req.params.hostId as string));
  });
  router.post(loginPath + "/:hostId/login", async (req, res) => {
    res.json(await startHostClaudeLogin(req.params.companyId as string, req.actor.userId ?? "local", req.params.hostId as string));
  });
  router.get(loginPath + "/sessions/:id", (req, res) => {
    res.json(hostClaudeSession(req.params.companyId as string, req.actor.userId ?? "local", req.params.id as string));
  });
  router.post(loginPath + "/sessions/:id/:action", (req, res) => {
    const action = req.params.action;
    if (action !== "code" && action !== "cancel") { res.status(404).end(); return; }
    res.json(hostClaudeSession(req.params.companyId as string, req.actor.userId ?? "local", req.params.id as string, action, req.body?.browserCode));
  });

  router.get("/companies/:companyId/dashboard/subscription-quotas", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertInstanceAdmin(req);
    if (!await companyService(db).getById(companyId)) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json(await fetchHostSubscriptionQuotas(companyId));
  });

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  router.get("/companies/:companyId/recovery-observability", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const weeks = parsePositiveNumber(req.query.weeks, 8, MAX_WINDOW_WEEKS);
    const thresholdPercent = parsePositiveNumber(
      req.query.threshold,
      DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT,
    );
    const report = await recoveryObservability.report(companyId, {
      weeks,
      thresholdPercent,
    });
    res.json(report);
  });

  return router;
}
