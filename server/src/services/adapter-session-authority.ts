import { createHash } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { agentTaskSessions, heartbeatRuns, type Db } from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { conflict, forbidden } from "../errors.js";

export const ADAPTER_SESSION_AUTHORITY = "adapterSessionAuthority";
const schema = "paperclip.adapter-session-authority.v1" as const;
type Claim = Parameters<NonNullable<AdapterExecutionContext["onSessionAuthority"]>>[0];
type Receipt = Awaited<ReturnType<NonNullable<AdapterExecutionContext["onSessionAuthority"]>>>;
type Authority = Receipt & { hostId: string; provider: string; nativeSessionId: string | null; bridgeSessionId: string;
  taskKey: string; previousRunId: string | null; previousGeneration: number; revoked?: true;
  /** Liveness-first takeover record: the authority this claim replaced. */
  takeoverFrom?: { runId: string; generation: number; taskKey: string; bindingKey: string };
  /** Historical receipts written before liveness-first; read but never required. */
  legacySessionRecovery?: { sourceRunId: string; sourceEventId: number };
  bootstrapNativeRecovery?: { sourceRunId: string; sourceEventId: number } };
export const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function readAdapterSessionAuthority(value: unknown): Authority | null {
  const v = object(object(value)[ADAPTER_SESSION_AUTHORITY]);
  return v.schema === schema && typeof v.runId === "string" && typeof v.bindingKey === "string"
    && Number.isSafeInteger(v.generation) && Number(v.generation) > 0 && typeof v.operationId === "string"
    && typeof v.taskKey === "string" && (v.nativeSessionId === null || typeof v.nativeSessionId === "string") ? v as Authority : null;
}
const denied = () => forbidden("This run no longer owns the native session", { code: "agent_run_superseded" });
const AUTHORITY_LOCK_TIMEOUT = "10s";

/**
 * Blocking advisory lock bounded by a 10 second lock timeout (liveness-first:
 * contention waits instead of failing immediately). A timeout surfaces as the
 * transient `session_authority_busy`. The caller's previous lock_timeout is
 * restored once the locks are held.
 */
export async function lockAdapterSessionAuthority(db: Db, keys: string[]) {
  const [previous] = await db.execute<{ timeout: string }>(sql`select current_setting('lock_timeout') as timeout`);
  await db.execute(sql`select set_config('lock_timeout', ${AUTHORITY_LOCK_TIMEOUT}, true)`);
  try {
    for (const key of [...new Set(keys)].sort()) {
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`adapter-session:${key}`}, 0))`);
    }
  } catch (error) {
    const code = (error as { code?: unknown })?.code ?? (error as { cause?: { code?: unknown } })?.cause?.code;
    if (code === "55P03") {
      throw conflict("Session authority is changing; retry shortly", { code: "session_authority_busy" });
    }
    throw error;
  }
  await db.execute(sql`select set_config('lock_timeout', ${previous?.timeout ?? "0"}, true)`);
}

/**
 * Only heartbeat supplies this callback. There is deliberately no agent-callable claim API.
 *
 * Liveness-first (rule 1): last writer wins. A claim by a run that is running,
 * not cancel-requested and bound to the same task always takes over: the new
 * authority gets generation = previous + 1, every other authority with the
 * same native identity is revoked, and the replaced owner is recorded as
 * `takeoverFrom`. The CAS fields of the request (`expectedGeneration`,
 * `expectedPreviousRunId`) are accepted for compatibility and ignored. A
 * deleted session index simply yields a fresh binding.
 */
export async function claimAdapterSessionAuthority(db: Db, bound: { companyId: string; agentId: string; runId: string; taskKey: string }, input: Claim): Promise<Receipt> {
  for (const value of [input.hostId, input.provider, input.bridgeSessionId, input.operationId,
    ...(input.nativeSessionId === null ? [] : [input.nativeSessionId])]) {
    if (typeof value !== "string" || !value.trim() || value.length > 512) throw conflict("Invalid native identity", { code: "session_identity_invalid" });
  }
  const bindingKey = createHash("sha256").update(JSON.stringify([bound.companyId, bound.agentId, "ccpocket_bridge",
    input.hostId, input.provider, input.nativeSessionId === null ? ["new_bridge", input.bridgeSessionId] : ["native", input.nativeSessionId]])).digest("hex");
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`select set_config('statement_timeout', '10s', true)`);
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
    const sessions = await tx.select().from(agentTaskSessions).where(selectedSessions).orderBy(agentTaskSessions.id).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, bound.companyId),
      eq(heartbeatRuns.agentId, bound.agentId), eq(heartbeatRuns.id, bound.runId))).for("update");
    // The three liveness-first checks: running, not cancel-requested, same task.
    if (!run || run.status !== "running" || object(run.resultJson?.executionCancellation).state === "requested") throw denied();
    const issueId = run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId;
    if (issueId && issueId !== bound.taskKey) throw conflict("Task does not match the admitted run", { code: "session_task_mismatch" });
    const existing = sessions.find(row => row.taskKey === bound.taskKey);
    const saved = readAdapterSessionAuthority(existing?.sessionParamsJson);
    // Idempotent replay of the same claim while it is still the current owner.
    const oldReceipt = readAdapterSessionAuthority(run.runnerProfileJson);
    if (oldReceipt && oldReceipt.operationId === input.operationId && oldReceipt.bindingKey === bindingKey
        && saved && !saved.revoked && saved.runId === bound.runId && saved.generation === oldReceipt.generation) return oldReceipt;
    const owners = sessions.map(row => readAdapterSessionAuthority(row.sessionParamsJson))
      .filter((owner): owner is Authority => !!owner && (owner.taskKey === bound.taskKey || sameIdentity(owner)));
    const previous = owners.reduce<Authority | null>((best, owner) => !best || owner.generation > best.generation ? owner : best, null);
    const generation = (previous?.generation ?? 0) + 1;
    const takeoverFrom = previous && previous.runId !== bound.runId
      ? { runId: previous.runId, generation: previous.generation, taskKey: previous.taskKey, bindingKey: previous.bindingKey }
      : undefined;
    const authority: Authority = { schema, runId: bound.runId, generation, operationId: input.operationId, bindingKey,
      previousRunId: previous?.runId ?? null, previousGeneration: previous?.generation ?? 0,
      taskKey: bound.taskKey, hostId: input.hostId, provider: input.provider, nativeSessionId: input.nativeSessionId, bridgeSessionId: input.bridgeSessionId,
      ...(takeoverFrom ? { takeoverFrom } : {}) };
    // One native identity has one owner: revoke it in every other task row.
    for (const row of sessions) {
      if (row.id === existing?.id) continue;
      const old = readAdapterSessionAuthority(row.sessionParamsJson);
      if (old && sameIdentity(old) && !old.revoked) await tx.update(agentTaskSessions).set({
        sessionParamsJson: { ...row.sessionParamsJson, [ADAPTER_SESSION_AUTHORITY]: { ...old, revoked: true } }, updatedAt: new Date(),
      }).where(eq(agentTaskSessions.id, row.id));
    }
    const params = { ...existing?.sessionParamsJson, hostId: input.hostId, provider: input.provider,
      nativeSessionId: input.nativeSessionId, bridgeSessionId: input.bridgeSessionId, [ADAPTER_SESSION_AUTHORITY]: authority };
    if (existing) await tx.update(agentTaskSessions).set({ sessionParamsJson: params, updatedAt: new Date() }).where(eq(agentTaskSessions.id, existing.id));
    else await tx.insert(agentTaskSessions).values({ companyId: bound.companyId, agentId: bound.agentId, adapterType: "ccpocket_bridge",
      taskKey: bound.taskKey, sessionParamsJson: params, sessionDisplayId: input.nativeSessionId });
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
