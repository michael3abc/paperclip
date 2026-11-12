import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agentTaskSessions, heartbeatRuns, heartbeatRunEvents, issues, type Db } from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { isUuidLike } from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";

export const ADAPTER_SESSION_AUTHORITY = "adapterSessionAuthority";
const schema = "paperclip.adapter-session-authority.v1" as const;
type Claim = Parameters<NonNullable<AdapterExecutionContext["onSessionAuthority"]>>[0];
type Receipt = Awaited<ReturnType<NonNullable<AdapterExecutionContext["onSessionAuthority"]>>>;
type Authority = Receipt & { hostId: string; provider: string; nativeSessionId: string | null; bridgeSessionId: string;
  taskKey: string; previousRunId: string | null; previousGeneration: number; revoked?: true;
  legacySessionRecovery?: { sourceRunId: string; sourceEventId: number } };
export const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function readAdapterSessionAuthority(value: unknown): Authority | null {
  const v = object(object(value)[ADAPTER_SESSION_AUTHORITY]);
  return v.schema === schema && typeof v.runId === "string" && typeof v.bindingKey === "string"
    && Number.isSafeInteger(v.generation) && Number(v.generation) > 0 && typeof v.operationId === "string"
    && typeof v.taskKey === "string" && (v.nativeSessionId === null || typeof v.nativeSessionId === "string") ? v as Authority : null;
}
const denied = () => forbidden("This run no longer owns the native session", { code: "agent_run_superseded" });

/** Try-lock when a caller already owns business rows. Contention fails explicitly,
 * instead of reversing the binding -> issue -> session -> run lock order. */
export async function lockAdapterSessionAuthority(db: Db, keys: string[]) {
  for (const key of [...new Set(keys)].sort()) {
    const [row] = await db.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`adapter-session:${key}`}, 0)) as acquired`);
    if (!row?.acquired) throw conflict("Session authority is changing; inspect the original operation receipt", { code: "session_authority_busy" });
  }
}

/** Only heartbeat supplies this callback. There is deliberately no agent-callable claim API. */
export async function claimAdapterSessionAuthority(db: Db, bound: { companyId: string; agentId: string; runId: string; taskKey: string }, input: Claim): Promise<Receipt> {
  for (const value of [input.hostId, input.provider, input.bridgeSessionId, input.operationId,
    ...(input.nativeSessionId === null ? [] : [input.nativeSessionId])]) {
    if (typeof value !== "string" || !value.trim() || value.length > 512) throw conflict("Invalid native identity", { code: "binding_reconciliation_required" });
  }
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) throw conflict("Invalid binding generation");
  if (input.expectedPreviousRunId !== null && !isUuidLike(input.expectedPreviousRunId)) throw conflict("Invalid previous run");
  const bindingKey = createHash("sha256").update(JSON.stringify([bound.companyId, bound.agentId, "ccpocket_bridge",
    input.hostId, input.provider, input.nativeSessionId === null ? ["new_bridge", input.bridgeSessionId] : ["native", input.nativeSessionId]])).digest("hex");
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const scope = and(eq(agentTaskSessions.companyId, bound.companyId), eq(agentTaskSessions.agentId, bound.agentId),
      eq(agentTaskSessions.adapterType, "ccpocket_bridge"));
    const sameIdentity = (owner: Authority | null) => !!owner && (owner.bindingKey === bindingKey ||
      owner.nativeSessionId === null && owner.hostId === input.hostId && owner.provider === input.provider && owner.bridgeSessionId === input.bridgeSessionId);
    const selectedSessions = and(scope, or(
      eq(agentTaskSessions.taskKey, bound.taskKey), sql`${agentTaskSessions.sessionParamsJson}->${ADAPTER_SESSION_AUTHORITY}->>'bindingKey' = ${bindingKey}`,
      sql`(${agentTaskSessions.sessionParamsJson}->>'nativeSessionId' = ${input.nativeSessionId}
        AND ${agentTaskSessions.sessionParamsJson}->>'hostId' = ${input.hostId}
        AND ${agentTaskSessions.sessionParamsJson}->>'provider' = ${input.provider})`,
      sql`(${agentTaskSessions.sessionParamsJson}->${ADAPTER_SESSION_AUTHORITY}->>'nativeSessionId' IS NULL
        AND ${agentTaskSessions.sessionParamsJson}->${ADAPTER_SESSION_AUTHORITY}->>'hostId' = ${input.hostId}
        AND ${agentTaskSessions.sessionParamsJson}->${ADAPTER_SESSION_AUTHORITY}->>'provider' = ${input.provider}
        AND ${agentTaskSessions.sessionParamsJson}->${ADAPTER_SESSION_AUTHORITY}->>'bridgeSessionId' = ${input.bridgeSessionId})`,
    ));
    const candidates = await tx.select().from(agentTaskSessions).where(selectedSessions);
    await lockAdapterSessionAuthority(tx, [bindingKey, ...candidates.flatMap(row => {
      const saved = readAdapterSessionAuthority(row.sessionParamsJson); return saved ? [saved.bindingKey] : [];
    })]);
    const issueIds = [...new Set([bound.taskKey, ...candidates.map(row => row.taskKey)])].sort();
    const lockedIssues = await tx.select().from(issues).where(and(eq(issues.companyId, bound.companyId),
      inArray(sql`${issues.id}::text`, issueIds))).orderBy(issues.id).for("update");
    const sessions = await tx.select().from(agentTaskSessions).where(selectedSessions).orderBy(agentTaskSessions.id).for("update");
    // Another binding cannot enter the selected task between discovery and locking.
    if (sessions.some(row => !candidates.some(old => old.id === row.id))) throw conflict("Task binding changed", { code: "session_authority_busy" });
    const existing = sessions.find(row => row.taskKey === bound.taskKey);
    const saved = readAdapterSessionAuthority(existing?.sessionParamsJson);
    if (!saved && object(existing?.sessionParamsJson)[ADAPTER_SESSION_AUTHORITY] !== undefined)
      throw conflict("Unrecognized server binding receipt", { code: "binding_reconciliation_required" });
    const nativeOwner = sessions.map(row => readAdapterSessionAuthority(row.sessionParamsJson))
      .find(owner => sameIdentity(owner) && !owner!.revoked);
    const runIds = [bound.runId, input.expectedPreviousRunId, saved?.runId, nativeOwner?.runId].filter((v): v is string => !!v);
    const runs = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, bound.companyId),
      eq(heartbeatRuns.agentId, bound.agentId), inArray(heartbeatRuns.id, [...new Set(runIds)]))).orderBy(heartbeatRuns.id).for("update");
    const run = runs.find(row => row.id === bound.runId);
    const oldReceipt = readAdapterSessionAuthority(run?.runnerProfileJson);
    if (oldReceipt) {
      if (oldReceipt.operationId !== input.operationId || oldReceipt.bindingKey !== bindingKey || !saved ||
          oldReceipt.previousRunId !== input.expectedPreviousRunId || oldReceipt.previousGeneration !== input.expectedGeneration ||
          saved.runId !== bound.runId || saved.generation !== oldReceipt.generation || saved.revoked || run?.status === "cancelled"
          || object(run?.resultJson?.executionCancellation).state === "requested") throw denied();
      return oldReceipt;
    }
    if (!run || run.status !== "running" || object(run.resultJson?.executionCancellation).state === "requested") throw denied();
    const issueId = run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId;
    if (issueId && issueId !== bound.taskKey) throw conflict("Task does not match the admitted run");
    const issue = lockedIssues.find(row => row.id === bound.taskKey);
    if (issue && ((issue.executionRunId && issue.executionRunId !== bound.runId) ||
        (issue.conversationAgentId && (issue.conversationAgentId !== bound.agentId ||
          run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration)))) throw denied();
    const previous = nativeOwner ?? saved;
    // Claude reports a native ID only after its first input. Bootstrap authority
    // is tied to that exact new card; it cannot replace an existing native owner.
    if (input.nativeSessionId === null && (previous || input.expectedPreviousRunId)) throw denied();
    if (previous?.nativeSessionId === null && (previous.hostId !== input.hostId || previous.provider !== input.provider
        || previous.bridgeSessionId !== input.bridgeSessionId)) throw denied();
    if (previous) {
      if (previous.generation !== input.expectedGeneration || previous.runId !== input.expectedPreviousRunId ||
          (previous.revoked && previous.bindingKey === bindingKey)) throw denied();
    } else if (input.expectedGeneration !== 0) throw denied();
    if (nativeOwner && nativeOwner.runId !== input.expectedPreviousRunId) throw denied();
    let legacySessionRecovery: Authority["legacySessionRecovery"];
    if (!previous && input.expectedPreviousRunId) {
      // Backfill only from the host's currentRunId plus its original result identity.
      // lastRunId is a publication pointer, never authority. Missing proof fails closed.
      const prior = runs.find(row => row.id === input.expectedPreviousRunId);
      const rejectLegacy = () => conflict("Original host binding needs reconciliation", { code: "binding_reconciliation_required" });
      if (!prior || prior.resultJson?.nativeSessionId !== input.nativeSessionId
          || typeof prior.resultJson?.bridgeSessionId !== "string") throw rejectLegacy();
      if (existing) {
        if (object(existing.sessionParamsJson).nativeSessionId !== input.nativeSessionId
            || object(existing.sessionParamsJson).hostId !== input.hostId
            || object(existing.sessionParamsJson).provider !== input.provider) throw rejectLegacy();
      } else {
        // A legacy Chat index may have been cleared independently of the host's
        // exact currentRunId. Require original server invocation/result identity.
        if ((prior.issueId ?? prior.nativeIssueId ?? prior.contextSnapshot?.issueId) !== bound.taskKey
            || object(prior.runnerProfileJson)[ADAPTER_SESSION_AUTHORITY] !== undefined
            || object(object(prior.runnerProfileJson).adapterDispatch).adapterType !== "ccpocket_bridge"
            || prior.contextSnapshot?.conversationSessionGeneration !== run.contextSnapshot?.conversationSessionGeneration)
          throw rejectLegacy();
        const priorAuthority = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, bound.companyId), eq(heartbeatRuns.agentId, bound.agentId),
          sql`${heartbeatRuns.runnerProfileJson}->${ADAPTER_SESSION_AUTHORITY}->>'bindingKey' = ${bindingKey}`)).limit(1);
        // A deleted feature-era binding must never reenroll as generation zero.
        if (priorAuthority.length) throw rejectLegacy();
        if (sessions.some(row => row.taskKey !== bound.taskKey
            && object(row.sessionParamsJson).nativeSessionId === input.nativeSessionId
            && object(row.sessionParamsJson).hostId === input.hostId
            && object(row.sessionParamsJson).provider === input.provider)) throw rejectLegacy();
        const invocation = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
          eq(heartbeatRunEvents.companyId, bound.companyId), eq(heartbeatRunEvents.agentId, bound.agentId),
          eq(heartbeatRunEvents.runId, prior.id), eq(heartbeatRunEvents.eventType, "adapter.invoke"),
          sql`${heartbeatRunEvents.payload}->>'adapterType' = 'ccpocket_bridge'`,
          sql`${heartbeatRunEvents.payload}#>>'{context,hostId}' = ${input.hostId}`,
          sql`${heartbeatRunEvents.payload}#>>'{context,provider}' = ${input.provider}`,
          sql`${heartbeatRunEvents.payload}#>>'{context,bridgeSessionId}' = ${prior.resultJson.bridgeSessionId}`)).limit(1);
        if (!invocation.length) throw rejectLegacy();
        legacySessionRecovery = { sourceRunId: prior.id, sourceEventId: invocation[0].id };
      }
    }
    const generation = Math.max(saved?.generation ?? 0, nativeOwner?.generation ?? 0) + 1;
    const authority: Authority = { schema, runId: bound.runId, generation, operationId: input.operationId, bindingKey,
      previousRunId: input.expectedPreviousRunId, previousGeneration: input.expectedGeneration,
      taskKey: bound.taskKey, hostId: input.hostId, provider: input.provider, nativeSessionId: input.nativeSessionId, bridgeSessionId: input.bridgeSessionId,
      ...(legacySessionRecovery ? { legacySessionRecovery } : {}) };
    for (const row of sessions) {
      if (row.id === existing?.id) continue;
      const old = readAdapterSessionAuthority(row.sessionParamsJson);
      if (old && sameIdentity(old)) await tx.update(agentTaskSessions).set({
        sessionParamsJson: { ...row.sessionParamsJson, [ADAPTER_SESSION_AUTHORITY]: { ...old, revoked: true } }, updatedAt: new Date(),
      }).where(eq(agentTaskSessions.id, row.id));
    }
    const params = { ...existing?.sessionParamsJson, hostId: input.hostId, provider: input.provider,
      nativeSessionId: input.nativeSessionId, bridgeSessionId: input.bridgeSessionId, [ADAPTER_SESSION_AUTHORITY]: authority };
    if (existing) await tx.update(agentTaskSessions).set({ sessionParamsJson: params, updatedAt: new Date() }).where(eq(agentTaskSessions.id, existing.id));
    else await tx.insert(agentTaskSessions).values({ companyId: bound.companyId, agentId: bound.agentId, adapterType: "ccpocket_bridge",
      taskKey: bound.taskKey, sessionParamsJson: params, sessionDisplayId: input.nativeSessionId });
    // Preserve the old run's truth while revoking its helper, even for a pre-feature binding.
    if (!previous && input.expectedPreviousRunId) {
      const prior = runs.find(row => row.id === input.expectedPreviousRunId)!;
      await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...prior.runnerProfileJson,
        [ADAPTER_SESSION_AUTHORITY]: { ...authority, runId: prior.id, generation: generation - 1, revoked: true } } }).where(eq(heartbeatRuns.id, prior.id));
    }
    await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, [ADAPTER_SESSION_AUTHORITY]: authority } }).where(eq(heartbeatRuns.id, bound.runId));
    return authority;
  });
}

/** Read-side rejection plus the transaction-side fence share the same receipt. */
export async function adapterSessionWriteAllowed(db: Db, bound: { companyId: string; agentId: string; runId: string }, lock = false) {
  const [run] = await db.select({ authority: sql<unknown>`${heartbeatRuns.runnerProfileJson}->${ADAPTER_SESSION_AUTHORITY}`,
    adapterType: sql<string | null>`${heartbeatRuns.runnerProfileJson}#>>'{adapterDispatch,adapterType}'` }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, bound.runId), eq(heartbeatRuns.companyId, bound.companyId), eq(heartbeatRuns.agentId, bound.agentId)));
  const authority = readAdapterSessionAuthority({ [ADAPTER_SESSION_AUTHORITY]: run?.authority });
  if (!authority) return run?.authority == null && run?.adapterType !== "ccpocket_bridge";
  if (authority.revoked) return false;
  if (lock) await lockAdapterSessionAuthority(db, [authority.bindingKey]);
  const query = db.select({ params: agentTaskSessions.sessionParamsJson }).from(agentTaskSessions).where(and(
    eq(agentTaskSessions.companyId, bound.companyId), eq(agentTaskSessions.agentId, bound.agentId),
    eq(agentTaskSessions.adapterType, "ccpocket_bridge"), eq(agentTaskSessions.taskKey, authority.taskKey)));
  const [row] = await (lock ? query.for("share") : query);
  const current = readAdapterSessionAuthority(row?.params);
  return !!current && !current.revoked && current.runId === bound.runId && current.bindingKey === authority.bindingKey
    && current.generation === authority.generation && current.operationId === authority.operationId;
}

/** Every late session publisher must use this under the existing row lock. */
export function mergeProtectedSessionParams(existing: unknown, incoming: Record<string, unknown> | null, runId: string | null) {
  const authority = readAdapterSessionAuthority(existing);
  if (!authority && object(existing)[ADAPTER_SESSION_AUTHORITY] !== undefined) return undefined;
  if (authority && (authority.revoked || authority.runId !== runId)) return undefined;
  const { [ADAPTER_SESSION_AUTHORITY]: _untrusted, ...params } = incoming ?? {};
  return authority ? { ...params, [ADAPTER_SESSION_AUTHORITY]: authority } : incoming === null ? null : params;
}
