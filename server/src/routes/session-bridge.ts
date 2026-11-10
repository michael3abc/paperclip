import { Router, type ErrorRequestHandler, type Request } from "express";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents, projectWorkspaces, issues } from "@paperclipai/db";
import { sessionBridgeChatBinding, sessionBridgeChatService } from "../services/session-bridge-chat.js";
import { mainAgentDispatchScope } from "../services/main-agent-workers.js";
import { pmDispatchDiagnostics } from "../services/pm-dispatch-diagnostics.js";
import { getAssignedMcpGateway } from "../services/native-runtime/assigned-mcp-tools.js";
import { ToolGatewayHttpError } from "../services/tool-gateway.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { accessService } from "../services/access.js";
import {
  SESSION_BRIDGE_MIRROR_MAX_BODY_CHARS,
  sessionBridgeMirrorService,
} from "../services/session-bridge-mirror.js";
import {
  clampSessionBridgeEventsWaitSec,
  parseSessionBridgeEventCursor,
  sessionBridgeEventsService,
} from "../services/session-bridge-events.js";

/**
 * Endpoints that exist only for a long-lived `session_bridge` agent key held by
 * a CC Pocket Bridge. Both are also on the edge allowlist in
 * `middleware/session-bridge-guard.ts`; every other actor gets a 403 here.
 */

// Accept far more than the stored limit so the service, not the schema,
// decides how an oversized turn is truncated (with an explicit marker).
const EXTERNAL_TURN_INPUT_MAX_CHARS = SESSION_BRIDGE_MIRROR_MAX_BODY_CHARS * 10;

export const sessionBridgeExternalTurnSchema = z
  .object({
    externalId: z.string().trim().min(1).max(200),
    role: z.enum(["user", "assistant"]),
    body: z.string().max(EXTERNAL_TURN_INPUT_MAX_CHARS),
    sessionId: z.string().trim().min(1).max(200),
    ts: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

function sessionBridgeKeyIdentity(req: Request) {
  const actor = req.actor;
  if (
    actor.type !== "agent"
    || actor.source !== "agent_key"
    || actor.keyScope?.kind !== "session_bridge"
    || !actor.agentId
    || !actor.companyId
    || !actor.keyId
  ) {
    return null;
  }
  return {
    agentId: actor.agentId,
    companyId: actor.companyId,
    keyId: actor.keyId,
    onBehalfOfUserId: actor.onBehalfOfUserId ?? null,
    scopeConversationAgentId: actor.keyScope.conversationAgentId ?? null,
    projectIds: actor.keyScope.projectIds,
  };
}

export function sessionBridgeRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const mirror = sessionBridgeMirrorService(db);
  const events = sessionBridgeEventsService(db);
  const chat = sessionBridgeChatService(db);

  router.post("/agents/me/session-bridge/receipt", async (req, res) => {
    const identity = sessionBridgeKeyIdentity(req);
    if (!identity || identity.scopeConversationAgentId !== identity.agentId) throw forbidden("Session bridge conversation key required");
    const input = z.object({ commentId: z.uuid(), nativeSessionId: z.string().min(1).max(200),
      claimId: z.uuid(), state: z.enum(["delivering", "delivered"]) }).strict().parse(req.body);
    res.json(await chat.receipt({ ...identity, userId: identity.onBehalfOfUserId }, input));
  });

  router.get("/agents/me/session-bridge/workers", async (req, res) => {
    const identity = sessionBridgeKeyIdentity(req);
    if (!identity || req.actor.keyScope?.kind !== "session_bridge" || !req.actor.keyScope.allowCreateTasks)
      throw forbidden("Task creation is not enabled for this key");
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, identity.agentId), eq(agents.companyId, identity.companyId)));
    const scope = agent && mainAgentDispatchScope(agent);
    if (!scope || !req.actor.keyScope.projectIds.includes(scope.projectId)) throw forbidden("No authorized worker policy in this project");
    const sources = await db.select({ id: projectWorkspaces.id, name: projectWorkspaces.name, sourceType: projectWorkspaces.sourceType, metadata: projectWorkspaces.metadata })
      .from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, identity.companyId), eq(projectWorkspaces.projectId, scope.projectId)));
    res.json({ projectId: scope.projectId, ...await pmDispatchDiagnostics(db, scope),
      sources: sources.map(s => ({ id: s.id, name: s.name, sourceType: s.sourceType, usage: s.metadata?.usage ?? null })) });
  });

  for (const operation of ["tools-search", "tools-call"] as const) router.post(`/agents/me/session-bridge/${operation}`, async (req, res) => {
    const identity = sessionBridgeKeyIdentity(req);
    if (!identity || req.actor.keyScope?.kind !== "session_bridge" || !req.actor.keyScope.allowAssignedTools)
      throw forbidden("Assigned connectors are not enabled for this key");
    const gateway = getAssignedMcpGateway(db);
    const token = req.headers.authorization?.replace(/^Bearer /i, "") ?? "";
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    const listed = (await gateway.listToolsForSession(token, { signal: abort.signal, sessionBridge: true })).filter(t => t.connectionId);
    if (operation === "tools-search") {
      const input = z.object({ query: z.string().max(200).default(""), offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(20).default(5) }).strict().parse(req.body);
      const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = listed.filter(t => terms.every(q => [t.name, t.displayName, t.description].join(" ").toLowerCase().includes(q)));
      res.json({ tools: matches.slice(input.offset, input.offset + input.limit).map(t => ({ name: t.name, description: t.description, inputSchema: t.parametersSchema, risk: t.risk })),
        nextOffset: input.offset + input.limit < matches.length ? input.offset + input.limit : null });
    } else {
      const input = z.object({ name: z.string().min(1).max(300), arguments: z.record(z.string(), z.unknown()),
        idempotencyKey: z.string().min(1).max(200), approvedActionRequestId: z.uuid().optional() }).strict().parse(req.body);
      if (!listed.some(t => t.name === input.name)) throw forbidden("Tool is not currently assigned to this agent");
      res.json(await gateway.executeTool({ sessionToken: token, sessionBridge: true, tool: input.name, parameters: input.arguments,
        idempotencyKey: "session-bridge:" + createHash("sha256").update(JSON.stringify([identity.companyId, identity.agentId, identity.onBehalfOfUserId, input.idempotencyKey])).digest("hex"),
        approvedActionRequestId: input.approvedActionRequestId, signal: abort.signal }));
    }
  });

  // Preserve the configured gateway's public failure contract, just as its
  // ordinary HTTP route does. Unknown failures still use the global handler.
  router.use(["/agents/me/session-bridge/tools-search", "/agents/me/session-bridge/tools-call"],
    ((err, _req, res, next) => {
      if (!(err instanceof ToolGatewayHttpError)) return next(err);
      if (res.destroyed) return;
      res.status(err.status).json({ error: err.message, reasonCode: err.reasonCode, ...err.details });
    }) satisfies ErrorRequestHandler);

  router.post("/issues/:id/external-turns", async (req, res) => {
    const identity = sessionBridgeKeyIdentity(req);
    if (!identity) throw forbidden("Only a session bridge key can write mirrored turns");
    const issueId = z.uuid().parse(req.params.id);
    const turn = sessionBridgeExternalTurnSchema.parse(req.body);
    if (turn.body.trim().length === 0) throw badRequest("Mirrored turn body is empty");

    // Scope the lookup to the key's own company so a foreign id and a missing id
    // are indistinguishable.
    const issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        status: issues.status,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, identity.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    const decision = await access.decide({
      actor: req.actor,
      action: "issue:comment",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
      scope: {
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
      },
    });
    if (!decision.allowed) throw forbidden(decision.explanation);

    const result = await mirror.mirrorTurn({
      companyId: issue.companyId,
      issueId: issue.id,
      actor: {
        agentId: identity.agentId,
        keyId: identity.keyId,
        onBehalfOfUserId: identity.onBehalfOfUserId,
        scopeConversationAgentId: identity.scopeConversationAgentId,
      },
      turn: {
        externalId: turn.externalId,
        role: turn.role,
        body: turn.body,
        sessionId: turn.sessionId,
        ts: turn.ts ? new Date(turn.ts) : null,
      },
    });

    // The mirror never echoes the stored body back: the caller already has it.
    res.status(result.created ? 201 : 200).json({
      created: result.created,
      comment: {
        id: result.comment.id,
        issueId: result.comment.issueId,
        role: turn.role,
        origin: result.comment.origin,
        createdAt: result.comment.createdAt,
      },
    });
  });

  router.get("/agents/me/session-bridge/events", async (req, res) => {
    const identity = sessionBridgeKeyIdentity(req);
    if (!identity) throw forbidden("Only a session bridge key can read control events");

    const afterRaw = typeof req.query.after === "string" && req.query.after.length > 0 ? req.query.after : null;
    const after = afterRaw ? parseSessionBridgeEventCursor(afterRaw) : null;
    if (afterRaw && !after) throw badRequest("Invalid events cursor");
    const waitMs = clampSessionBridgeEventsWaitSec(req.query.wait) * 1000;

    // Stop waiting (and release the live-event subscription) when the Bridge
    // hangs up before the poll returns.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    const binding = await sessionBridgeChatBinding(db, identity.companyId, identity.agentId);
    const page = await events.poll({
      companyId: identity.companyId,
      agentId: identity.agentId,
      conversationIssueId: binding?.conversationIssueId,
      after,
      waitMs,
      signal: abort.signal,
    });
    if (!page || abort.signal.aborted) return;

    res.setHeader("Cache-Control", "no-store");
    const inbox = identity.scopeConversationAgentId === identity.agentId ? await chat.pending(identity.companyId, identity.agentId, identity.onBehalfOfUserId, identity.projectIds) : null;
    res.json({ ...page, inbox });
  });

  return router;
}
