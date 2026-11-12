import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { sessionBridgeAgentKeyScopeSchema, normalizeAgentApiKeyScope } from "@paperclipai/shared";
import {
  assertSessionBridgeApiRequest,
  sessionBridgeGuardMiddleware,
} from "../middleware/session-bridge-guard.js";
import {
  SESSION_BRIDGE_WRITE_LIMIT,
  SESSION_BRIDGE_WRITE_WINDOW_MS,
  evaluateSessionBridgeWriteLimit,
} from "../services/session-bridge-write-limit.js";

const companyId = randomUUID();
const projectId = randomUUID();
const otherProjectId = randomUUID();
const issueId = randomUUID();

function check(
  method: string,
  path: string,
  overrides: { query?: Record<string, unknown>; body?: Record<string, unknown>; companyId?: string; projectIds?: string[] } = {},
) {
  assertSessionBridgeApiRequest({
    method,
    path,
    query: overrides.query ?? {},
    body: overrides.body,
    companyId: overrides.companyId ?? companyId,
    projectIds: overrides.projectIds ?? [projectId],
  });
}

describe("sessionBridgeAgentKeyScopeSchema", () => {
  it("never broadens unsupported observer scopes into a standard key", () => {
    expect(normalizeAgentApiKeyScope(null)).toEqual({ kind: "standard" });
    expect(() => normalizeAgentApiKeyScope({ kind: "session_bridge", projectIds: [projectId], workerCardOnly: "true" })).toThrow(/Unsupported/);
    expect(() => normalizeAgentApiKeyScope({ kind: "future_observer" })).toThrow(/Unsupported/);
    expect(() => normalizeAgentApiKeyScope({ kind: "session_bridge", projectIds: [projectId], unknownCapability: true })).toThrow(/Unsupported/);
  });
  it("accepts a project-bounded scope", () => {
    const parsed = sessionBridgeAgentKeyScopeSchema.parse({
      kind: "session_bridge",
      projectIds: [projectId],
      conversationAgentId: randomUUID(),
      allowCreateTasks: true,
    });
    expect(parsed.projectIds).toEqual([projectId]);
  });

  it("requires at least one project", () => {
    expect(sessionBridgeAgentKeyScopeSchema.safeParse({ kind: "session_bridge", projectIds: [] }).success).toBe(false);
  });

  it("rejects more than 50 projects", () => {
    const projectIds = Array.from({ length: 51 }, () => randomUUID());
    expect(sessionBridgeAgentKeyScopeSchema.safeParse({ kind: "session_bridge", projectIds }).success).toBe(false);
  });

  it("rejects non-uuid project ids and unknown fields", () => {
    expect(
      sessionBridgeAgentKeyScopeSchema.safeParse({ kind: "session_bridge", projectIds: ["not-a-uuid"] }).success,
    ).toBe(false);
    expect(
      sessionBridgeAgentKeyScopeSchema.safeParse({
        kind: "session_bridge",
        projectIds: [projectId],
        allowEverything: true,
      }).success,
    ).toBe(false);
  });
});

describe("assertSessionBridgeApiRequest", () => {
  it("restricts worker-card observer credentials to their read-only endpoints", () => {
    const observer = { companyId, projectIds: [projectId], workerCardOnly: true, query: {} };
    expect(sessionBridgeAgentKeyScopeSchema.parse({ kind: "session_bridge", projectIds: [projectId], workerCardOnly: true }).workerCardOnly).toBe(true);
    for (const path of ["/api/agents/me/session-bridge/events", "/api/agents/me/session-bridge/worker-card-proof"])
      expect(() => assertSessionBridgeApiRequest({ ...observer, method: "GET", path })).not.toThrow();
    for (const [method, path] of [["POST", `/api/issues/${issueId}/comments`], ["GET", `/api/issues/${issueId}`],
      ["GET", "/api/agents/me/session-bridge/workers"], ["POST", "/api/agents/me/session-bridge/tools-call"],
      ["POST", "/api/agents/me/session-bridge/events"]])
      expect(() => assertSessionBridgeApiRequest({ ...observer, method: method!, path: path! })).toThrow(/observers may only/);
  });
  it.each([
    ["GET", "/api/health"],
    ["GET", "/api/agents/me"],
    ["GET", "/api/agents/me/inbox-lite"],
    ["GET", "/api/agents/me/session-bridge/events"],
    ["GET", `/api/companies/${companyId}/projects`],
    ["GET", `/api/projects/${projectId}`],
    ["GET", `/api/issues/${issueId}`],
    ["GET", "/api/issues/AIV-12"],
    ["GET", `/api/issues/${issueId}/heartbeat-context`],
    ["GET", `/api/issues/${issueId}/comments`],
    ["GET", `/api/issues/${issueId}/comments/${randomUUID()}`],
    ["GET", `/api/issues/${issueId}/documents`],
    ["GET", `/api/issues/${issueId}/documents/plan`],
    ["GET", `/api/issues/${issueId}/documents/plan/revisions`],
    ["POST", `/api/issues/${issueId}/comments`],
    ["POST", `/api/issues/${issueId}/external-turns`],
    ["POST", `/api/companies/${companyId}/issues`],
    ["PUT", `/api/issues/${issueId}/documents/plan`],
    ["PATCH", `/api/issues/${issueId}`],
  ])("allows %s %s", (method, path) => {
    expect(() => check(method, path)).not.toThrow();
  });

  it("tolerates trailing slashes and lowercase methods", () => {
    expect(() => check("get", `/api/issues/${issueId}/`)).not.toThrow();
  });

  it.each(["assigneeAgentId", "assigneeAdapterOverrides", "workspaceSelection", "executionPolicy", "projectId"])(
    "rejects replacing %s through task updates", (key) => {
      expect(() => check("PATCH", `/api/issues/${issueId}`, { body: { [key]: {} } })).toThrow(/cannot replace/);
    },
  );

  it("allows ordinary task progress updates", () => {
    expect(() => check("PATCH", `/api/issues/${issueId}`, { body: { status: "in_review", comment: "Ready", expectedStatusVersion: 2 } })).not.toThrow();
  });

  it.each([
    ["POST", `/api/agents/${randomUUID()}/keys`],
    ["GET", `/api/agents/${randomUUID()}`],
    ["GET", `/api/companies/${companyId}/agents`],
    ["GET", `/api/companies/${companyId}/connections`],
    ["POST", `/api/companies/${companyId}/connections`],
    ["GET", `/api/companies/${companyId}/secrets`],
    ["POST", `/api/issues/${issueId}/checkout`],
    ["POST", `/api/issues/${issueId}/release`],
    ["POST", `/api/issues/${issueId}/interactions`],
    ["DELETE", `/api/issues/${issueId}`],
    ["DELETE", `/api/issues/${issueId}/documents/plan`],
    ["GET", `/api/issues/${issueId}/activity`],
    ["GET", `/api/companies/${companyId}/issues/summaries`],
    ["GET", `/api/companies/${companyId}/issues/count`],
    ["GET", `/api/companies/${companyId}/approvals`],
    ["POST", `/api/companies/${companyId}/approvals`],
    ["GET", `/api/companies/${companyId}/costs`],
    ["PATCH", `/api/agents/${randomUUID()}`],
    ["PUT", `/api/agents/${randomUUID()}/worker-policy`],
    ["GET", "/api/issues/../agents/me"],
    ["GET", `/api/issues/${issueId}/comments/..%2Fkeys`],
    ["POST", "/api/issues/a.b/comments"],
  ])("denies %s %s", (method, path) => {
    expect(() => check(method, path)).toThrow(/session bridge scope|own company|issue filter|own projects/i);
  });

  it("denies company-scoped routes for another company", () => {
    expect(() => check("GET", `/api/companies/${randomUUID()}/projects`)).toThrow(/own company/i);
    expect(() => check("POST", `/api/companies/${randomUUID()}/issues`)).toThrow(/own company/i);
  });

  it("matches the company id case-insensitively", () => {
    expect(() => check("GET", `/api/companies/${companyId.toUpperCase()}/projects`)).not.toThrow();
  });

  describe("issue list filters", () => {
    const listPath = `/api/companies/${companyId}/issues`;

    it("requires a project in the key scope", () => {
      expect(() => check("GET", listPath)).toThrow(/own projects/i);
      expect(() => check("GET", listPath, { query: { projectId: otherProjectId } })).toThrow(/own projects/i);
      expect(() => check("GET", listPath, { query: { projectId: [projectId, otherProjectId] } })).toThrow(
        /own projects/i,
      );
      expect(() => check("GET", listPath, { query: { projectId } })).not.toThrow();
    });

    it("allows the bounded filter set", () => {
      expect(() =>
        check("GET", listPath, {
          query: {
            projectId,
            status: "todo,in_progress",
            assigneeAgentId: randomUUID(),
            limit: "20",
            offset: "0",
            sortField: "updatedAt",
            sortDir: "desc",
          },
        }),
      ).not.toThrow();
    });

    it.each(["ids", "parentId", "touchedByUserId", "q", "view", "attention", "includeRoutineExecutions"])(
      "refuses the %s filter",
      (key) => {
        expect(() => check("GET", listPath, { query: { projectId, [key]: "x" } })).toThrow(/issue filter/i);
      },
    );

    it("does not apply the project requirement to creating issues", () => {
      expect(() => check("POST", listPath)).not.toThrow();
    });
  });
});

describe("sessionBridgeGuardMiddleware", () => {
  function run(actor: unknown, request: { method: string; path: string; query?: Record<string, unknown> }) {
    const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
    const req = { actor, method: request.method, path: request.path, query: request.query ?? {} } as unknown as Request;
    sessionBridgeGuardMiddleware()(req, {} as Response, next);
    return next as ReturnType<typeof vi.fn>;
  }

  const sessionBridgeActor = {
    type: "agent",
    agentId: randomUUID(),
    companyId,
    keyId: randomUUID(),
    source: "agent_key",
    keyScope: { kind: "session_bridge", projectIds: [projectId] },
  };

  it("passes an allowed request through", () => {
    const next = run(sessionBridgeActor, { method: "GET", path: `/api/issues/${issueId}` });
    expect(next).toHaveBeenCalledWith();
  });

  it("forwards a 403 for a request outside the allowlist", () => {
    const next = run(sessionBridgeActor, { method: "POST", path: `/api/issues/${issueId}/checkout` });
    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0]?.[0] as { status?: number; details?: { code?: string } };
    expect(error.status).toBe(403);
    expect(error.details?.code).toBe("SESSION_BRIDGE_API_DENIED");
  });

  it("denies a session-bridge actor that lacks a key id", () => {
    const next = run({ ...sessionBridgeActor, keyId: undefined }, { method: "GET", path: "/api/health" });
    const error = next.mock.calls[0]?.[0] as { status?: number };
    expect(error?.status).toBe(403);
  });

  it.each([
    ["standard agent key", { type: "agent", agentId: randomUUID(), companyId, keyScope: { kind: "standard" } }],
    ["agent jwt", { type: "agent", agentId: randomUUID(), companyId, source: "agent_jwt" }],
    ["board", { type: "board", userId: "user-1", source: "session" }],
    ["unauthenticated", { type: "none", source: "none" }],
    ["missing actor", undefined],
  ])("is a no-op for a %s", (_label, actor) => {
    const next = run(actor, { method: "POST", path: `/api/issues/${issueId}/checkout` });
    expect(next).toHaveBeenCalledWith();
  });
});

describe("evaluateSessionBridgeWriteLimit", () => {
  it("allows writes up to the cap and rejects the next one", () => {
    expect(evaluateSessionBridgeWriteLimit({ priorCount: 0 })).toMatchObject({ allowed: true, count: 1 });
    expect(evaluateSessionBridgeWriteLimit({ priorCount: SESSION_BRIDGE_WRITE_LIMIT - 1 })).toMatchObject({
      allowed: true,
      count: SESSION_BRIDGE_WRITE_LIMIT,
    });
    expect(evaluateSessionBridgeWriteLimit({ priorCount: SESSION_BRIDGE_WRITE_LIMIT })).toMatchObject({
      allowed: false,
      count: SESSION_BRIDGE_WRITE_LIMIT + 1,
    });
  });

  it("reports the cap and window it applied", () => {
    expect(evaluateSessionBridgeWriteLimit({ priorCount: 0 })).toMatchObject({
      cap: SESSION_BRIDGE_WRITE_LIMIT,
      windowMs: SESSION_BRIDGE_WRITE_WINDOW_MS,
    });
  });
});
