#!/usr/bin/env node
import fs from 'node:fs/promises';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { admin, companyId, ownerId, requireApp, deployment, databaseUrl } from './deployment.mjs';
import { privateWrite, reserveReceipt } from './operation-files.mjs';
import { catalogGroups } from './routing.mjs';
const { values: o } = parseArgs({ options: { apply: { type: 'boolean' }, receipt: { type: 'string' }, restore: { type: 'string' } } });
if (!o.receipt || (o.restore && !o.apply)) throw new Error('--receipt required; --restore requires --apply');
await reserveReceipt(o.receipt);
const api = await admin();
const existing = (await api.call('GET', `/api/companies/${companyId}/ai-connections`)).connections;
const report = { at: new Date().toISOString(), mode: o.restore ? 'restore' : o.apply ? 'apply' : 'plan', changes: [] };
// This Paperclip version has no catalog-only API. Keep destination/auth immutable,
// use a row-locked compare-and-swap for models only, and write a normal audit event.
async function replaceModels(id, before, after) {
  const sql = requireApp('postgres')(await databaseUrl(), { max: 1 });
  try { await sql.begin(async tx => {
    const [row] = await tx`select config, created_by_user_id from tool_connections where id=${id} and company_id=${companyId} for update`;
    const grants = await tx`select id from connection_grants where connection_id=${id} and company_id=${companyId} and kind='user' and subject_user_id=${ownerId} and created_by_user_id=${ownerId} and status='active' for update`;
    if (!row || row.created_by_user_id !== ownerId || grants.length !== 1 || !isDeepStrictEqual(row.config.ai.routing, before)) throw new Error('Connection changed or ownership mismatch');
    const { models: ignoredBefore, ...destinationBefore } = before;
    const { models: ignoredAfter, ...destinationAfter } = after;
    if (!isDeepStrictEqual(destinationBefore, destinationAfter)) throw new Error('Catalog refresh cannot change destination/auth/protocol');
    const agents = await tx`select id,status,adapter_config from agents where company_id=${companyId} and status!='terminated' and runtime_config->'aiConnection'->>'connectionId'=${id} for update`;
    if (agents.some(a => a.status !== 'paused')) throw new Error('Pause all agents bound to this connection before refreshing its catalog');
    const runs = await tx`select r.id from heartbeat_runs r join agents a on a.id=r.agent_id where r.company_id=${companyId} and r.status in ('running','queued','scheduled_retry') and (r.context_snapshot->'aiConnection'->>'connectionId'=${id} or a.runtime_config->'aiConnection'->>'connectionId'=${id}) limit 1`;
    if (runs.length) throw new Error('Connection has active runs; refresh after they stop');
    if (agents.some(a => a.adapter_config.model && !after.models.some(m => m.id === a.adapter_config.model))) throw new Error('Refresh would remove an assigned agent model; explicitly reconfigure that agent first');
    await tx`update tool_connections set config=jsonb_set(config,'{ai,routing}',${tx.json(after)}),updated_at=now() where id=${id}`;
    await tx`insert into activity_log (company_id,actor_type,actor_id,action,entity_type,entity_id,details) values (${companyId},'user',${ownerId},'ai_connection.catalog_updated','connection',${id},${tx.json({ before, after, source: 'paperclip-native-sync' })})`;
  }); } finally { await sql.end(); }
}
if (o.restore) {
  const previous = JSON.parse(await fs.readFile(o.restore, 'utf8'));
  if (previous.mode !== 'apply') throw new Error('Restore requires an applied receipt');
  for (const c of [...previous.changes].reverse()) {
    if (c.unchanged) continue;
    // New connections carry no upstream credential; retain them for audit/history.
    // Restoring agent bindings is handled by migration rollback, never delete grants here.
    const matches = existing.filter(e => c.id ? e.id === c.id : e.name === c.name && e.ownerUserId === ownerId && isDeepStrictEqual(e.routing, c.after));
    if (!c.before) { if (matches.length > 1) throw new Error('Ambiguous pending creation'); report.changes.push({ id: matches[0]?.id, retained: Boolean(matches.length) }); continue; }
    const current = matches[0];
    if (!current || current.ownerUserId !== ownerId) throw new Error('Restore connection missing or ownership changed');
    if (isDeepStrictEqual(current.routing, c.before)) { report.changes.push({ id: c.id, alreadyRestored: true }); continue; }
    if (!isDeepStrictEqual(current.routing, c.after)) throw new Error('Connection drift; restore refused');
    await replaceModels(c.id, c.after, c.before); report.changes.push({ id: c.id, restored: true }); await privateWrite(o.receipt, report);
  }
} else {
  const response = await fetch(`${deployment.routerUrl}/health`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Gateway HTTP ${response.status}`);
  const groups = catalogGroups(await response.json(), deployment.routerUrl);
  for (const input of groups) {
    const expectedId = deployment.connections[`${input.provider}-${input.routing.kind}`];
    const matches = existing.filter(c => c.id === expectedId);
    if (matches.length !== 1) throw new Error(`Configured connection is unavailable in this company: ${input.name}`);
    if (existing.some(c => c.id !== expectedId && c.name === input.name)) throw new Error(`Duplicate connection name: ${input.name}`);
    if (matches.length > 1) throw new Error(`Ambiguous connection: ${input.name}`);
    const old = matches[0];
    if (old && (old.ownerUserId !== ownerId || old.provider !== input.provider || old.method !== input.method)) throw new Error(`Connection owner/provider mismatch: ${input.name}`);
    if (old && isDeepStrictEqual(old.routing, input.routing)) { report.changes.push({ id: old.id, name: input.name, unchanged: true }); continue; }
    if (old) {
      const { models: a, ...before } = old.routing;
      const { models: b, ...after } = input.routing;
      if (!isDeepStrictEqual(before, after)) throw new Error('Existing destination differs; refusing to reroute');
    }
    const change = { name: input.name, id: old?.id, before: old?.routing ?? null, after: input.routing, applied: false };
    report.changes.push(change); await privateWrite(o.receipt, report);
    if (o.apply) {
      if (old) await replaceModels(old.id, old.routing, input.routing);
      else throw new Error('Catalog sync cannot create connections');
      change.applied = true; await privateWrite(o.receipt, report);
    }
  }
}
await privateWrite(o.receipt, report);
console.log(JSON.stringify(report, null, 2));
