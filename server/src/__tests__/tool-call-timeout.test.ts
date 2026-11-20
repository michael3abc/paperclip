import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests, agents, companies, companyMemberships, createDb, heartbeatRuns, issueThreadInteractions, issues,
  toolActionRequests, toolCatalogEntries, toolConnections, toolInvocations,
} from "@paperclipai/db";
import { toolActionDeliveryService } from "../services/tool-action-delivery.js";
import { configuredToolCallTimeoutMs, toolCallTimeoutConfigIssues } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService, TOOL_TIMEOUT_UNKNOWN_OUTCOME } from "../services/tool-gateway.js";
import { toolAccessRoutes } from "../routes/tool-access.js";

// HOM-411: per-connection call deadlines, approval that answers at once while
// the approved call runs afterwards, and "outcome unknown" for timed-out writes.
const actor = { actorType: "user" as const, actorId: "timeout-test-user", actorSource: "local_implicit" as const };
const writeTool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } });
const readTool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });

describe("tool call deadlines (unit)", () => {
  it("reads the per-tool override before the connection deadline and ignores invalid values", () => {
    expect(configuredToolCallTimeoutMs({}, "x")).toBeNull();
    expect(configuredToolCallTimeoutMs({ callTimeoutMs: 120_000 }, "x")).toBe(120_000);
    expect(configuredToolCallTimeoutMs({ callTimeoutMs: 120_000, callTimeoutMsByTool: { x: 90_000 } }, "x")).toBe(90_000);
    expect(configuredToolCallTimeoutMs({ callTimeoutMs: 999_999 }, "x")).toBeNull();
  });
  it("rejects deadlines outside 1 s to 180 s", () => {
    expect(toolCallTimeoutConfigIssues({ callTimeoutMs: 180_000 })).toEqual([]);
    expect(toolCallTimeoutConfigIssues({ callTimeoutMs: 180_001 })).toHaveLength(1);
    expect(toolCallTimeoutConfigIssues({ callTimeoutMsByTool: { slow: 0 } })).toHaveLength(1);
    expect(toolCallTimeoutConfigIssues({ callTimeoutMsByTool: [] })).toHaveLength(1);
  });
});

describe("tool call deadlines", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let keyDir: string;
  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "tool-call-timeout-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    fixture = await startEmbeddedPostgresTestDatabase("tool-call-timeout-test-");
    db = createDb(fixture.connectionString);
  });
  afterAll(async () => { await fixture?.cleanup(); vi.unstubAllEnvs(); if (keyDir) await rm(keyDir, { recursive: true, force: true }); });

  /** A remote MCP app whose tools take `delays[name]` ms and stop when the caller aborts. */
  async function slowApp(delays: Record<string, number>) {
    const [org] = await db.insert(companies).values({ name: `Timeout ${randomUUID()}`, issuePrefix: `T${randomUUID().slice(0, 5)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: org.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    const [agent] = await db.insert(agents).values({ companyId: org.id, name: "Career", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    const calls: { name: string; startedAt: number; finishedAt?: number; aborted?: boolean }[] = [];
    const send = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") return Response.json({ id: body.id, result: { protocolVersion: "2025-06-18" } }, { headers: { "Mcp-Session-Id": "slow-session" } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "server/discover") return Response.json({ id: body.id, error: { code: -32601, message: "Method not found" } }, { status: 404 });
      if (body.method === "tools/list") return Response.json({ id: body.id, result: { tools: [writeTool("slow_write"), readTool("slow_read")] } });
      const call: (typeof calls)[number] = { name: body.params.name, startedAt: Date.now() };
      calls.push(call);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delays[body.params.name] ?? 0);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer); call.aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
      call.finishedAt = Date.now();
      return Response.json({ id: body.id, result: { content: [{ type: "text", text: `${body.params.name} done` }] } });
    };
    const service = toolAccessService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }], remoteHttpRequest: send });
    const connection = await service.connectGalleryApp(org.id, { galleryKey: "executor", connectionMethodKey: "mcp", link: `https://executor.sh/${randomUUID()}/mcp`, authMode: "none" }, actor);
    const ids = Object.fromEntries(connection.catalog.map((entry) => [entry.toolName, entry.id]));
    await service.finishGalleryAppConnection(org.id, connection.connectionId, {
      enabledCatalogEntryIds: [ids.slow_write, ids.slow_read], askFirstCatalogEntryIds: [ids.slow_write], access: { agentIds: [agent.id] },
    }, actor);
    // Pin risk levels so the read/write branches do not depend on catalog inference.
    await db.update(toolCatalogEntries).set({ riskLevel: "write", isWrite: true, isReadOnly: false }).where(eq(toolCatalogEntries.id, ids.slow_write));
    await db.update(toolCatalogEntries).set({ riskLevel: "read", isWrite: false, isReadOnly: true }).where(eq(toolCatalogEntries.id, ids.slow_read));
    const setConfig = async (extra: Record<string, unknown>) => {
      const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection.connectionId));
      await db.update(toolConnections).set({ config: { ...row.config, ...extra } }).where(eq(toolConnections.id, row.id));
    };
    return { org, agent, connectionId: connection.connectionId, calls, send, setConfig };
  }

  async function agentApproval(app: Awaited<ReturnType<typeof slowApp>>, gateway: ReturnType<typeof createToolGatewayService>) {
    const [issue] = await db.insert(issues).values({ companyId: app.org.id, title: "Update resume", status: "in_progress", assigneeAgentId: app.agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: app.org.id, agentId: app.agent.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue.id } }).returning();
    const session = await gateway.createSession({ companyId: app.org.id, agentId: app.agent.id, runId: run.id });
    const target = (await gateway.listToolsForSession(session.token)).find((entry) => entry.upstreamToolName === "slow_write")!;
    let actionRequestId = "";
    try { await gateway.executeTool({ sessionToken: session.token, tool: target.name, parameters: {} }); }
    catch (error) {
      expect(error).toMatchObject({ reasonCode: "approval_required" });
      actionRequestId = (error as { details: { actionRequestId: string } }).details.actionRequestId;
    }
    expect(actionRequestId).not.toBe("");
    // The run yields, as it does while a person reviews the card.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    return { issue, run, actionRequestId };
  }

  async function projection(actionRequestId: string) {
    const [requestRow] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, actionRequestId));
    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, requestRow.interactionId!));
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, requestRow.invocationId));
    return { request: requestRow, invocation, toolAction: (interaction.result as { toolAction?: Record<string, unknown> } | null)?.toolAction };
  }

  it("answers an approval at once, runs the call within the connection deadline, and settles the card once", async () => {
    const app = await slowApp({ slow_write: 1_500 });
    await app.setConfig({ callTimeoutMs: 3_000 });
    const wakes: { at: number; payload: Record<string, any> }[] = [];
    const wakeup = vi.fn(async (agentId: string, input: any) => {
      wakes.push({ at: Date.now(), payload: input.payload });
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: app.org.id, agentId, source: input.source, idempotencyKey: input.idempotencyKey, payload: input.payload }).returning();
      return wake as any;
    });
    const deliveries = toolActionDeliveryService(db, { wakeup });
    const gateway = createToolGatewayService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", remoteHttpRequest: app.send,
      toolActionSigningSecret: "timeout-signing-key", approvedExecutionMode: "background",
      onToolActionSettled: (id) => deliveries.deliver(id) });
    const { actionRequestId } = await agentApproval(app, gateway);

    const startedAt = Date.now();
    await gateway.approveActionRequest({ companyId: app.org.id, actionRequestId, actor: { userId: actor.actorId } });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect((await projection(actionRequestId)).toolAction?.status).toMatch(/^(approved|executing)$/);
    expect(wakes).toHaveLength(0);
    // A second accept while it runs never starts the call again.
    await gateway.approveActionRequest({ companyId: app.org.id, actionRequestId, actor: { userId: actor.actorId } });

    await gateway.settleBackgroundApprovedExecutions();
    const done = await projection(actionRequestId);
    expect(done.request.status).toBe("executed");
    expect(done.toolAction?.status).toBe("executed");
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0].aborted).toBeUndefined();
    // The assignee is woken exactly once, after the result, and the wake carries it.
    await deliveries.deliver(actionRequestId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].at).toBeGreaterThanOrEqual(app.calls[0].finishedAt!);
    expect(wakes[0].payload.toolAction).toMatchObject({ actionRequestId, executionStatus: "executed" });
  });

  it("records a timed-out approved write as outcome unknown and never sends it again", async () => {
    const app = await slowApp({ slow_write: 2_500 });
    await app.setConfig({ callTimeoutMs: 120_000, callTimeoutMsByTool: { slow_write: 1_000 } });
    const gateway = createToolGatewayService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", remoteHttpRequest: app.send,
      toolActionSigningSecret: "timeout-signing-key", approvedExecutionMode: "background" });
    const { actionRequestId } = await agentApproval(app, gateway);
    await gateway.approveActionRequest({ companyId: app.org.id, actionRequestId, actor: { userId: actor.actorId } });
    await gateway.settleBackgroundApprovedExecutions();
    const done = await projection(actionRequestId);
    expect(done.request.status).toBe("failed");
    expect(done.invocation.errorCode).toBe(TOOL_TIMEOUT_UNKNOWN_OUTCOME);
    expect(done.toolAction).toMatchObject({ status: "unknown", errorCode: TOOL_TIMEOUT_UNKNOWN_OUTCOME });
    expect(String(done.toolAction?.errorMessage)).toMatch(/may already have been made/);
    expect(app.calls).toHaveLength(1);
    // Repairs and repeated approval do not resend it.
    await gateway.repairActionReviewProjections();
    await gateway.approveActionRequest({ companyId: app.org.id, actionRequestId, actor: { userId: actor.actorId } }).catch(() => undefined);
    await gateway.settleBackgroundApprovedExecutions();
    expect(app.calls).toHaveLength(1);
    expect((await projection(actionRequestId)).toolAction?.status).toBe("unknown");
  });

  it("uses the connection deadline for Test calls and keeps read-only timeouts as failures", async () => {
    const app = await slowApp({ slow_read: 1_500 });
    const gateway = createToolGatewayService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", remoteHttpRequest: app.send, toolActionSigningSecret: "timeout-signing-key" });
    const call = () => gateway.executeTestCall({ companyId: app.org.id, connectionId: app.connectionId, agentId: app.agent.id, userId: actor.actorId, toolName: "slow_read", parameters: {} });
    await app.setConfig({ callTimeoutMs: 1_000 });
    expect(await call()).toMatchObject({ error: { reasonCode: "tool_timeout" } });
    await app.setConfig({ callTimeoutMs: 3_000 });
    expect(await call()).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
  });

  it("settles an execution left running by a previous server process as outcome unknown without rerunning it", async () => {
    const app = await slowApp({ slow_write: 0 });
    const before = createToolGatewayService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", remoteHttpRequest: app.send, toolActionSigningSecret: "timeout-signing-key" });
    const { actionRequestId } = await agentApproval(app, before);
    // Simulate a process that claimed and started the call, then died.
    const [requestRow] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, actionRequestId));
    const claimedAt = new Date(Date.now() - 5_000);
    await db.update(toolActionRequests).set({ status: "executing", decidedByUserId: actor.actorId, decidedAt: claimedAt, updatedAt: claimedAt }).where(eq(toolActionRequests.id, actionRequestId));
    await db.update(toolInvocations).set({ status: "executing", startedAt: claimedAt }).where(eq(toolInvocations.id, requestRow.invocationId));
    await db.update(issueThreadInteractions).set({ status: "accepted", result: { version: 1, outcome: "accepted", toolAction: { version: 1, status: "executing", updatedAt: claimedAt.toISOString() } } as never })
      .where(eq(issueThreadInteractions.id, requestRow.interactionId!));

    // An inline gateway keeps the stale window; the restarted background one settles at once.
    const inline = createToolGatewayService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", remoteHttpRequest: app.send, toolActionSigningSecret: "timeout-signing-key" });
    await inline.settleInterruptedActionReviews();
    expect((await projection(actionRequestId)).request.status).toBe("executing");
    const restarted = createToolGatewayService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", remoteHttpRequest: app.send,
      toolActionSigningSecret: "timeout-signing-key", approvedExecutionMode: "background" });
    expect(await restarted.nextActionReviewInterruptionAt()).toBeLessThanOrEqual(Date.now());
    await restarted.settleInterruptedActionReviews();
    const done = await projection(actionRequestId);
    expect(done.request.status).toBe("failed");
    expect(done.toolAction).toMatchObject({ status: "unknown", errorCode: "tool_execution_outcome_unknown" });
    expect(app.calls).toHaveLength(0);
  });

  it("rejects a connection deadline above 180 s with 422", async () => {
    const app = await slowApp({});
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { req.actor = { type: "board", userId: actor.actorId, source: "local_implicit", isInstanceAdmin: true }; next(); });
    server.use("/api", toolAccessRoutes(db, { paperclipCloudConnector: null }));
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, app.connectionId));
    const tooLong = await request(server).patch(`/api/tool-connections/${app.connectionId}`).send({ config: { ...row.config, callTimeoutMs: 180_001 } });
    expect(tooLong.status).toBe(422);
    const accepted = await request(server).patch(`/api/tool-connections/${app.connectionId}`).send({ config: { ...row.config, callTimeoutMs: 120_000 } });
    expect(accepted.status).toBe(200);
    const [saved] = await db.select().from(toolConnections).where(eq(toolConnections.id, app.connectionId));
    expect(saved.config.callTimeoutMs).toBe(120_000);
  });
});
