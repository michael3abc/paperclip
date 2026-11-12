import type { RequestHandler } from "express";
import { forbidden } from "../errors.js";

/**
 * Closed HTTP surface for `session_bridge` agent keys.
 *
 * A session-bridge key is a long-lived credential that lives on a Bridge host
 * and is readable by the model that runs there, so it must not be able to reach
 * any route that was not deliberately opened for it. This guard is a default-deny
 * allowlist evaluated before routing; it is the first of two layers. The second
 * layer is `access.decide` (`decideSessionBridgeAccess`) and the route-level
 * project checks, which still narrow what an allowed route may do. The guard
 * exists because several list/search routes build their SQL from privacy rules
 * that are not key-scope aware, so a route the key could name but that is not in
 * this list must never run.
 *
 * Requests from any other actor pass through untouched, so behavior is
 * unchanged when no `session_bridge` key is in use.
 */

const SESSION_BRIDGE_API_DENIED = "SESSION_BRIDGE_API_DENIED";

// A single path segment holding a uuid or an issue/project identifier; never
// dots, slashes or percent escapes.
const ID = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const DOC_KEY = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";

type Rule = { method: string; pattern: RegExp; companyGroup?: number };

const rules: Rule[] = [
  { method: "GET", pattern: /^\/api\/agents\/me\/session-bridge\/workers$/i },
  { method: "GET", pattern: /^\/api\/agents\/me\/session-bridge\/worker-card-proof$/i },
  { method: "POST", pattern: /^\/api\/agents\/me\/session-bridge\/(receipt|tools-search|tools-call)$/i },
  { method: "GET", pattern: /^\/api\/health$/i },
  { method: "GET", pattern: /^\/api\/agents\/me$/i },
  { method: "GET", pattern: /^\/api\/agents\/me\/inbox-lite$/i },
  { method: "GET", pattern: /^\/api\/agents\/me\/session-bridge\/events$/i },
  { method: "GET", pattern: new RegExp(`^/api/companies/(${ID})/projects$`, "i"), companyGroup: 1 },
  { method: "GET", pattern: new RegExp(`^/api/projects/${ID}$`, "i") },
  { method: "GET", pattern: new RegExp(`^/api/companies/(${ID})/issues$`, "i"), companyGroup: 1 },
  { method: "GET", pattern: new RegExp(`^/api/issues/${ID}$`, "i") },
  { method: "GET", pattern: new RegExp(`^/api/issues/${ID}/heartbeat-context$`, "i") },
  { method: "GET", pattern: new RegExp(`^/api/issues/${ID}/comments$`, "i") },
  { method: "GET", pattern: new RegExp(`^/api/issues/${ID}/comments/${ID}$`, "i") },
  { method: "GET", pattern: new RegExp(`^/api/issues/${ID}/documents$`, "i") },
  { method: "GET", pattern: new RegExp(`^/api/issues/${ID}/documents/${DOC_KEY}$`, "i") },
  { method: "GET", pattern: new RegExp(`^/api/issues/${ID}/documents/${DOC_KEY}/revisions$`, "i") },
  { method: "POST", pattern: new RegExp(`^/api/issues/${ID}/comments$`, "i") },
  { method: "POST", pattern: new RegExp(`^/api/issues/${ID}/external-turns$`, "i") },
  { method: "POST", pattern: new RegExp(`^/api/companies/(${ID})/issues$`, "i"), companyGroup: 1 },
  { method: "PUT", pattern: new RegExp(`^/api/issues/${ID}/documents/${DOC_KEY}$`, "i") },
  { method: "PATCH", pattern: new RegExp(`^/api/issues/${ID}$`, "i") },
];

// Query parameters the issue list route may carry for a session-bridge key.
// Anything else (ids, parentIds, attention, view, touchedByUserId, ...) widens
// the read beyond what the key's project scope bounds and is refused.
const LIST_QUERY_KEYS = new Set([
  "projectId",
  "status",
  "assigneeAgentId",
  "limit",
  "offset",
  "sortField",
  "sortDir",
]);

function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function sessionBridgeApiDenied(message = "This API operation is outside the session bridge scope"): Error {
  return forbidden(message, { code: SESSION_BRIDGE_API_DENIED });
}

export type SessionBridgeRequestShape = {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body?: Record<string, unknown>;
  companyId: string;
  projectIds: string[];
};

/** Throws when the request is outside the session-bridge allowlist. */
export function assertSessionBridgeApiRequest(request: SessionBridgeRequestShape): void {
  const path = normalizePath(request.path);
  const method = request.method.toUpperCase();
  const rule = rules.find((candidate) => candidate.method === method && candidate.pattern.test(path));
  if (!rule) throw sessionBridgeApiDenied();
  if (method === "PATCH" && /^\/api\/issues\/[^/]+$/i.test(path)) {
    const allowed = new Set(["title", "description", "priority", "status", "comment", "commentClientRequestId", "expectedStatusVersion"]);
    if (Object.keys(request.body ?? {}).some(key => !allowed.has(key)))
      throw sessionBridgeApiDenied("Session bridge task updates cannot replace worker, model, workspace or approval policy");
  }

  if (rule.companyGroup) {
    const match = path.match(rule.pattern);
    const pathCompanyId = match?.[rule.companyGroup];
    if (!pathCompanyId || pathCompanyId.toLowerCase() !== request.companyId.toLowerCase()) {
      throw sessionBridgeApiDenied("Session bridge keys are limited to their own company");
    }
  }

  if (method === "GET" && /^\/api\/companies\/[^/]+\/issues$/i.test(path)) {
    for (const key of Object.keys(request.query)) {
      if (!LIST_QUERY_KEYS.has(key)) {
        throw sessionBridgeApiDenied(`Session bridge keys cannot use the "${key}" issue filter`);
      }
    }
    const projectId = request.query.projectId;
    if (typeof projectId !== "string" || !request.projectIds.includes(projectId)) {
      throw sessionBridgeApiDenied("Session bridge keys can only list issues in their own projects");
    }
  }
}

export function sessionBridgeGuardMiddleware(): RequestHandler {
  return (req, _res, next) => {
    try {
      const actor = req.actor;
      if (actor?.type === "agent" && actor.keyScope?.kind === "session_bridge") {
        if (!actor.companyId || !actor.agentId || !actor.keyId) throw sessionBridgeApiDenied();
        assertSessionBridgeApiRequest({
          method: req.method,
          path: req.path,
          query: req.query as Record<string, unknown>,
          body: req.body,
          companyId: actor.companyId,
          projectIds: actor.keyScope.projectIds,
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
