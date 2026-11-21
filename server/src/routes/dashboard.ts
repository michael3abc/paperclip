import { Router, type RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { companyService } from "../services/companies.js";
import { fetchHostSubscriptionQuotas } from "../services/host-subscription-quotas.js";
import { listHostClaudeLogins, checkHostClaudeLogin, startHostClaudeLogin, hostClaudeSession } from "../services/host-claude-login.js";
import { listHostCodexLogins, checkHostCodexLogin, startHostCodexLogin, hostCodexSession } from "../services/host-codex-login.js";
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
  // Literal paths keep the mounted-route OpenAPI coverage scanner exact.
  const hostLoginGuard: RequestHandler = async (req, res, next) => {
    assertInstanceAdmin(req);
    assertCompanyAccess(req, req.params.companyId as string);
    if (!await companyService(db).getById(req.params.companyId as string)) {
      res.status(404).json({ error: "Company not found" }); return;
    }
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    next();
  };
  router.use("/companies/:companyId/dashboard/host-claude", hostLoginGuard);
  router.use("/companies/:companyId/dashboard/host-codex", hostLoginGuard);
  router.get("/companies/:companyId/dashboard/host-claude", async (req, res) => {
    res.json(await listHostClaudeLogins(req.params.companyId as string));
  });
  router.post("/companies/:companyId/dashboard/host-claude/:hostId/check", async (req, res) => {
    res.json(await checkHostClaudeLogin(req.params.companyId as string, req.params.hostId as string));
  });
  router.post("/companies/:companyId/dashboard/host-claude/:hostId/login", async (req, res) => {
    res.json(await startHostClaudeLogin(req.params.companyId as string, req.actor.userId ?? "local", req.params.hostId as string));
  });
  router.get("/companies/:companyId/dashboard/host-claude/sessions/:id", (req, res) => {
    res.json(hostClaudeSession(req.params.companyId as string, req.actor.userId ?? "local", req.params.id as string));
  });
  router.post("/companies/:companyId/dashboard/host-claude/sessions/:id/code", (req, res) => {
    res.json(hostClaudeSession(req.params.companyId as string, req.actor.userId ?? "local", req.params.id as string, "code", req.body?.browserCode));
  });
  router.post("/companies/:companyId/dashboard/host-claude/sessions/:id/cancel", (req, res) => {
    res.json(hostClaudeSession(req.params.companyId as string, req.actor.userId ?? "local", req.params.id as string, "cancel", req.body?.browserCode));
  });
  // Codex uses device authorization: the view shows the device page and one-time
  // code, and the native CLI completes by itself, so there is no code submission.
  router.get("/companies/:companyId/dashboard/host-codex", async (req, res) => {
    res.json(await listHostCodexLogins(req.params.companyId as string));
  });
  router.post("/companies/:companyId/dashboard/host-codex/:hostId/check", async (req, res) => {
    res.json(await checkHostCodexLogin(req.params.companyId as string, req.params.hostId as string));
  });
  router.post("/companies/:companyId/dashboard/host-codex/:hostId/login", async (req, res) => {
    res.json(await startHostCodexLogin(req.params.companyId as string, req.actor.userId ?? "local", req.params.hostId as string));
  });
  router.get("/companies/:companyId/dashboard/host-codex/sessions/:id", (req, res) => {
    res.json(hostCodexSession(req.params.companyId as string, req.actor.userId ?? "local", req.params.id as string));
  });
  router.post("/companies/:companyId/dashboard/host-codex/sessions/:id/cancel", (req, res) => {
    res.json(hostCodexSession(req.params.companyId as string, req.actor.userId ?? "local", req.params.id as string, "cancel"));
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
