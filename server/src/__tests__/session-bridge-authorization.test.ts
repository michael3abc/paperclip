import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issues,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import type { SessionBridgeAgentKeyScope } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import {
  CONNECTION_MANAGEMENT_PERMISSIONS,
  type ConnectionManagementAction,
} from "../services/connection-management-policy.js";
import {
  SESSION_BRIDGE_WRITE_ACTIVITY,
  SESSION_BRIDGE_WRITE_LIMIT,
  SESSION_BRIDGE_WRITE_REJECTED_ACTIVITY,
  observeSessionBridgeWrite,
} from "../services/session-bridge-write-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

async function createCompany(db: TestDb, label: string) {
  return db
    .insert(companies)
    .values({
      name: `SessionBridge ${label} ${randomUUID()}`,
      issuePrefix: `SB${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: TestDb, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      permissions: {},
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createProject(db: TestDb, companyId: string, label: string) {
  return db
    .insert(projects)
    .values({ companyId, name: `Project ${label} ${randomUUID()}`, visibility: "open" })
    .returning()
    .then((rows) => rows[0]!);
}

async function createIssue(
  db: TestDb,
  companyId: string,
  input: {
    projectId?: string | null;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    originKind?: string | null;
    originId?: string | null;
  } = {},
) {
  return db
    .insert(issues)
    .values({
      id: randomUUID(),
      companyId,
      title: `Issue ${randomUUID()}`,
      status: "todo",
      priority: "medium",
      projectId: input.projectId ?? null,
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      visibility: "open",
      originKind: input.originKind ?? "manual",
      originId: input.originId ?? null,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createConversationIssue(db: TestDb, companyId: string, agentId: string) {
  return db
    .insert(issues)
    .values({
      id: randomUUID(),
      companyId,
      title: `Chat ${randomUUID()}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      conversationAgentId: agentId,
      conversationUserId: `user-${randomUUID()}`,
      conversationState: "active",
      visibility: "open",
      originKind: "agent_conversation",
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("session bridge authorization", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-session-bridge-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function bridgeActor(input: {
    companyId: string;
    agentId: string;
    scope: SessionBridgeAgentKeyScope;
    keyId?: string | null;
  }): AuthorizationActor {
    return {
      type: "agent",
      agentId: input.agentId,
      companyId: input.companyId,
      source: "agent_key",
      keyId: input.keyId === null ? undefined : (input.keyId ?? randomUUID()),
      keyScope: input.scope,
    } as AuthorizationActor;
  }

  async function setup(options: { allowCreateTasks?: boolean; bindConversation?: boolean } = {}) {
    const company = await createCompany(db, "Scope");
    const agent = await createAgent(db, company.id);
    const project = await createProject(db, company.id, "InScope");
    const otherProject = await createProject(db, company.id, "OutOfScope");
    const keyId = randomUUID();
    const scope: SessionBridgeAgentKeyScope = {
      kind: "session_bridge",
      projectIds: [project.id],
      ...(options.bindConversation === false ? {} : { conversationAgentId: agent.id }),
      ...(options.allowCreateTasks ? { allowCreateTasks: true } : {}),
    };
    const actor = bridgeActor({ companyId: company.id, agentId: agent.id, scope, keyId });
    return { company, agent, project, otherProject, keyId, scope, actor, authz: authorizationService(db) };
  }

  it("reads projects only inside the key boundary", async () => {
    const { company, project, otherProject, actor, authz } = await setup();

    await expect(
      authz.decide({
        actor,
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      }),
    ).resolves.toMatchObject({ allowed: true });

    await expect(
      authz.decide({
        actor,
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: otherProject.id },
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
  });

  it("reads and comments on in-scope issues but not out-of-scope ones", async () => {
    const { company, project, otherProject, actor, authz } = await setup();
    const inScope = await createIssue(db, company.id, { projectId: project.id });
    const outOfScope = await createIssue(db, company.id, { projectId: otherProject.id });
    const noProject = await createIssue(db, company.id);

    for (const action of ["issue:read", "issue:comment"] as const) {
      await expect(
        authz.decide({ actor, action, resource: { type: "issue", companyId: company.id, issueId: inScope.id } }),
      ).resolves.toMatchObject({ allowed: true });
      for (const blocked of [outOfScope, noProject]) {
        await expect(
          authz.decide({ actor, action, resource: { type: "issue", companyId: company.id, issueId: blocked.id } }),
        ).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
      }
    }
  });

  it("denies an issue from another company even when its project id is in scope", async () => {
    const { company, actor, authz } = await setup();
    const otherCompany = await createCompany(db, "Other");
    const foreign = await createIssue(db, otherCompany.id);

    await expect(
      authz.decide({
        actor,
        action: "issue:read",
        resource: { type: "issue", companyId: company.id, issueId: foreign.id },
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("reaches the agent's own conversation issue only when the key is bound to that agent", async () => {
    const { company, agent, actor, authz } = await setup();
    const own = await createConversationIssue(db, company.id, agent.id);
    const peer = await createAgent(db, company.id);
    const peerConversation = await createConversationIssue(db, company.id, peer.id);

    await expect(
      authz.decide({ actor, action: "issue:read", resource: { type: "issue", companyId: company.id, issueId: own.id } }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authz.decide({ actor, action: "issue:comment", resource: { type: "issue", companyId: company.id, issueId: own.id } }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authz.decide({
        actor,
        action: "issue:read",
        resource: { type: "issue", companyId: company.id, issueId: peerConversation.id },
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });

    const unbound = await setup({ bindConversation: false });
    const unboundOwn = await createConversationIssue(db, unbound.company.id, unbound.agent.id);
    await expect(
      unbound.authz.decide({
        actor: unbound.actor,
        action: "issue:read",
        resource: { type: "issue", companyId: unbound.company.id, issueId: unboundOwn.id },
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
  });

  it("allows issue mutation only for key-created issues or an explicit document write", async () => {
    const { company, project, otherProject, keyId, actor, authz } = await setup();
    const inScope = await createIssue(db, company.id, { projectId: project.id });
    const created = await createIssue(db, company.id, { originKind: "session_bridge", originId: keyId });
    const createdByOtherKey = await createIssue(db, company.id, {
      originKind: "session_bridge",
      originId: randomUUID(),
    });
    const outOfScope = await createIssue(db, company.id, { projectId: otherProject.id });
    const mutate = (issueId: string, intent?: "document_write") =>
      authz.decide({
        actor,
        action: "issue:mutate",
        resource: { type: "issue", companyId: company.id, issueId, ...(intent ? { intent } : {}) },
      });

    await expect(mutate(created.id)).resolves.toMatchObject({ allowed: true });
    await expect(mutate(inScope.id)).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    await expect(mutate(inScope.id, "document_write")).resolves.toMatchObject({ allowed: true });
    await expect(mutate(createdByOtherKey.id)).resolves.toMatchObject({ allowed: false });
    await expect(mutate(outOfScope.id, "document_write")).resolves.toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });
  });

  describe("tasks:assign", () => {
    it("is denied unless the key allows task creation", async () => {
      const { company, project, agent, actor, authz } = await setup();
      await expect(
        authz.decide({
          actor,
          action: "tasks:assign",
          resource: { type: "issue", companyId: company.id, projectId: project.id, assigneeAgentId: agent.id },
        }),
      ).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    });

    it("creates inside the project boundary, assigned to itself only", async () => {
      const { company, project, otherProject, agent, actor, authz } = await setup({ allowCreateTasks: true });
      const peer = await createAgent(db, company.id);

      await expect(
        authz.decide({
          actor,
          action: "tasks:assign",
          resource: { type: "issue", companyId: company.id, projectId: project.id, assigneeAgentId: agent.id },
        }),
      ).resolves.toMatchObject({ allowed: true });
      await expect(
        authz.decide({
          actor,
          action: "tasks:assign",
          resource: { type: "issue", companyId: company.id, projectId: project.id },
        }),
      ).resolves.toMatchObject({ allowed: true });
      await expect(
        authz.decide({
          actor,
          action: "tasks:assign",
          resource: { type: "issue", companyId: company.id, projectId: project.id, assigneeAgentId: peer.id },
        }),
      ).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
      await expect(
        authz.decide({
          actor,
          action: "tasks:assign",
          resource: {
            type: "issue",
            companyId: company.id,
            projectId: project.id,
            assigneeUserId: `user-${randomUUID()}`,
          },
        }),
      ).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
      await expect(
        authz.decide({
          actor,
          action: "tasks:assign",
          resource: { type: "issue", companyId: company.id, projectId: otherProject.id, assigneeAgentId: agent.id },
        }),
      ).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    });

    it("accepts a parent in scope and reassigns only issues this key created", async () => {
      const { company, project, otherProject, agent, keyId, actor, authz } = await setup({ allowCreateTasks: true });
      const parentInScope = await createIssue(db, company.id, { projectId: project.id });
      const parentOutOfScope = await createIssue(db, company.id, { projectId: otherProject.id });
      const created = await createIssue(db, company.id, { originKind: "session_bridge", originId: keyId });
      const manual = await createIssue(db, company.id, { projectId: project.id });

      await expect(
        authz.decide({
          actor,
          action: "tasks:assign",
          resource: { type: "issue", companyId: company.id, parentIssueId: parentInScope.id, assigneeAgentId: agent.id },
        }),
      ).resolves.toMatchObject({ allowed: true });
      await expect(
        authz.decide({
          actor,
          action: "tasks:assign",
          resource: { type: "issue", companyId: company.id, parentIssueId: parentOutOfScope.id },
        }),
      ).resolves.toMatchObject({ allowed: false });
      await expect(
        authz.decide({
          actor,
          action: "tasks:assign",
          resource: { type: "issue", companyId: company.id, issueId: created.id, assigneeAgentId: agent.id },
        }),
      ).resolves.toMatchObject({ allowed: true });
      await expect(
        authz.decide({
          actor,
          action: "tasks:assign",
          resource: { type: "issue", companyId: company.id, issueId: manual.id, assigneeAgentId: agent.id },
        }),
      ).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    });
  });

  it("denies everything outside the allowlisted actions", async () => {
    const { company, agent, actor, authz } = await setup({ allowCreateTasks: true });

    await expect(
      authz.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId: company.id } }),
    ).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    await expect(
      authz.decide({
        actor,
        action: "agent_config:read",
        resource: { type: "agent", companyId: company.id, agentId: agent.id },
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
  });

  it.each(Object.keys(CONNECTION_MANAGEMENT_PERMISSIONS) as ConnectionManagementAction[])(
    "denies the %s connection action even when read-only",
    async (action) => {
      const { company, actor, authz } = await setup({ allowCreateTasks: true });
      // Keys are always created with a responsible user, which is what lets the
      // decision reach the key-scope branch instead of the missing-user guard.
      const keyedActor = { ...actor, onBehalfOfUserId: `user-${randomUUID()}` } as AuthorizationActor;
      await expect(
        authz.decide({
          actor: keyedActor,
          action,
          resource: { type: "connection_management", companyId: company.id, operation: "test", readOnly: true },
        }),
      ).resolves.toMatchObject({
        allowed: false,
        reason: "deny_scope",
        explanation: expect.stringContaining("session bridge"),
      });
    },
  );

  it("denies when the key context has no key id", async () => {
    const { company, project, scope, agent, authz } = await setup();
    const actor = bridgeActor({ companyId: company.id, agentId: agent.id, scope, keyId: null });
    await expect(
      authz.decide({
        actor,
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
  });

  describe("observeSessionBridgeWrite", () => {
    async function observe(
      ctx: { company: { id: string }; agent: { id: string }; keyId: string },
      issueId: string,
      now?: Date,
    ) {
      return observeSessionBridgeWrite(db, {
        companyId: ctx.company.id,
        keyId: ctx.keyId,
        agentId: ctx.agent.id,
        targetIssueId: issueId,
        kind: "comment",
        now,
      });
    }

    it("records an allowed attempt with the key id", async () => {
      const ctx = await setup();
      const issue = await createIssue(db, ctx.company.id, { projectId: ctx.project.id });

      await expect(observe(ctx, issue.id)).resolves.toMatchObject({ allowed: true, count: 1 });

      const rows = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, ctx.company.id), eq(activityLog.action, SESSION_BRIDGE_WRITE_ACTIVITY)));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.details).toMatchObject({ sessionBridge: true, keyId: ctx.keyId, kind: "comment", allowed: true });
    });

    it("rejects after the cap and records the rejection without counting it", async () => {
      const ctx = await setup();
      const issue = await createIssue(db, ctx.company.id, { projectId: ctx.project.id });
      const now = new Date();
      await db.insert(activityLog).values(
        Array.from({ length: SESSION_BRIDGE_WRITE_LIMIT }, () => ({
          companyId: ctx.company.id,
          actorType: "agent" as const,
          actorId: ctx.agent.id,
          agentId: ctx.agent.id,
          action: SESSION_BRIDGE_WRITE_ACTIVITY,
          entityType: "issue",
          entityId: issue.id,
          details: { sessionBridge: true, keyId: ctx.keyId },
        })),
      );

      await expect(observe(ctx, issue.id, now)).resolves.toMatchObject({
        allowed: false,
        count: SESSION_BRIDGE_WRITE_LIMIT + 1,
      });
      await expect(observe(ctx, issue.id, now)).resolves.toMatchObject({ allowed: false });

      const rejected = await db
        .select()
        .from(activityLog)
        .where(
          and(eq(activityLog.companyId, ctx.company.id), eq(activityLog.action, SESSION_BRIDGE_WRITE_REJECTED_ACTIVITY)),
        );
      expect(rejected).toHaveLength(2);
    });

    it("counts per key and ignores attempts outside the window", async () => {
      const ctx = await setup();
      const issue = await createIssue(db, ctx.company.id, { projectId: ctx.project.id });
      const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await db.insert(activityLog).values(
        Array.from({ length: SESSION_BRIDGE_WRITE_LIMIT }, () => ({
          companyId: ctx.company.id,
          actorType: "agent" as const,
          actorId: ctx.agent.id,
          agentId: ctx.agent.id,
          action: SESSION_BRIDGE_WRITE_ACTIVITY,
          entityType: "issue",
          entityId: issue.id,
          details: { sessionBridge: true, keyId: ctx.keyId },
          createdAt: staleAt,
        })),
      );
      const otherKey = { ...ctx, keyId: randomUUID() };

      await expect(observe(ctx, issue.id)).resolves.toMatchObject({ allowed: true, count: 1 });
      await expect(observe(otherKey, issue.id)).resolves.toMatchObject({ allowed: true, count: 1 });
    });

    it("serializes concurrent attempts from one key", async () => {
      const ctx = await setup();
      const issue = await createIssue(db, ctx.company.id, { projectId: ctx.project.id });

      const decisions = await Promise.all(Array.from({ length: 8 }, () => observe(ctx, issue.id)));

      expect(decisions.map((decision) => decision.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });
  });
});
