/** HTTP/CPU evidence on an explicitly owned, restored database; never boots schedulers. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Session } from "node:inspector";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import express from "express";
import { createDb, withDatabaseOperation } from "@paperclipai/db";
import * as schema from "../../packages/db/src/schema/index.js";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "../../packages/db/src/response-capture.js";
import { attentionRoutes } from "../src/routes/attention.js";
import { issueRoutes } from "../src/routes/issues.js";
import { agentRoutes } from "../src/routes/agents.js";
import { authorizationReadScope } from "../src/services/authorization-read-scope.js";
import type { AuthorizationActor } from "../src/services/authorization.js";

const [root, label] = process.argv.slice(2);
assert(root && label && /^[a-z0-9-]+$/.test(label));
const receipt = JSON.parse(await fs.readFile(path.join(root, "clone-receipt.json"), "utf8"));
assert(receipt.owner === "HOM-627" && receipt.passed && receipt.verification.ok);
const url = (await fs.readFile(path.join(root, "database-url"), "utf8")).trim();
assert(new URL(url).hostname === "127.0.0.1" && new URL(url).port === "54427");
const db = createDb(url, { maxConnections: 10, applicationName: "hom627-profile" });
const [identity] = await db.$client`select current_setting('data_directory') as dir`;
assert.equal(identity.dir, path.join(root, "db"));
const companyId = "3e25c7ef-add9-4995-a3f5-17a665a4dfca";
const [member] = await db.$client`select principal_id as id, membership_role as role from company_memberships where company_id=${companyId} and principal_type='user' and status='active' order by created_at limit 1`;
assert(member);
const [issue] = await db.$client`select id,identifier from issues where company_id=${companyId} and conversation_agent_id is null order by updated_at desc limit 1`;
assert(issue);
let actor: AuthorizationActor = { type: "board", source: "session", userId: member.id, companyIds: [companyId], isInstanceAdmin: true };
if (label.endsWith("-agent")) {
  const [grant] = await db.$client`select principal_id as id from principal_permission_grants where company_id=${companyId} and principal_type='agent' and permission_key='inbox:manage' order by created_at limit 1`;
  assert(grant, "Clone has no inbox:manage agent");
  actor = { type: "agent", source: "agent_key", agentId: grant.id, companyId, onBehalfOfUserId: member.id,
    onBehalfOfMemberships: [{ companyId, status: "active", membershipRole: member.role }] };
}
const app = express();
app.use((req, res, next) => {
  if (req.method !== "GET") { res.sendStatus(405); return; }
  req.actor = { ...actor }; next();
});
app.use(authorizationReadScope);
app.use((req, _res, next) => withDatabaseOperation(req.path, next));
app.use("/api", attentionRoutes(db));
app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
app.use("/api", agentRoutes(db));
app.use((err: any, _req: any, res: any, _next: any) => { console.error(err.name, err.code, err.message?.slice(0, 200)); res.status(err.status ?? 500).json({ error: "candidate request failed" }); });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}/api`;
const paths = {
  attention: `/companies/${companyId}/attention?all=true&view=mine`,
  summary: `/companies/${companyId}/attention/summary`,
  issue: `/issues/${issue.id}`,
  light: `/issues/${issue.id}/live-runs`,
};
const session = new Session(); session.connect();
const post = (method: string) => new Promise<any>((resolve, reject) => session.post(method as any, (err, result) => err ? reject(err) : resolve(result)));
const report: Record<string, any> = { label, identity: { host: "127.0.0.1", port: 54427 }, requestSet: paths, sequential: {}, bursts: [] };
const get = async (endpoint: string) => {
  const start = performance.now(); const response = await fetch(base + endpoint);
  assert.equal(response.status, 200, endpoint);
  const value = await response.json();
  return { ms: performance.now() - start, value, timing: response.headers.get("server-timing") };
};
try {
  await post("Profiler.enable");
  // Warm module loading, pool and read-side materialization before measuring.
  for (const endpoint of Object.values(paths)) await get(endpoint);
  for (const name of ["attention", "summary", "issue"] as const) {
    await post("Profiler.start");
    const reads = []; for (let i = 0; i < 5; i++) reads.push(await get(paths[name]));
    const { profile } = await post("Profiler.stop");
    await fs.writeFile(path.join(root, `${label}-${name}.cpuprofile`), JSON.stringify(profile), { flag: "wx", mode: 0o600 });
    report.sequential[name] = reads.map(({ ms, timing }) => ({ ms, timing }));
    // Raw response stays private. Compare before/after after removing generation time.
    await fs.writeFile(path.join(root, `${label}-${name}-response.json`), JSON.stringify(reads[4]!.value), { flag: "wx", mode: 0o600 });
  }
  for (let iteration = 0; iteration < 5; iteration++) {
    const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
    const start = performance.now();
    const result = await Promise.all([paths.attention, paths.summary, paths.issue, ...Array(16).fill(paths.light)].map(get));
    lag.disable();
    report.bursts.push({ totalMs: performance.now() - start, attentionMs: result[0]!.ms, summaryMs: result[1]!.ms, issueMs: result[2]!.ms,
      lightMs: result.slice(3).map(r => r.ms), eventLoopMaxMs: lag.max / 1e6 });
  }
  // Query wall time/callers are captured separately, outside the timing/CPU runs.
  Error.stackTraceLimit = 50;
  const entries: unknown[] = [];
  const capture = createDatabaseResponseCapture({ start: Date.now(), end: Date.now() + 60_000 }, entry => entries.push(entry));
  installDatabaseResponseCapture(db, schema, capture);
  try { for (const name of ["attention", "summary", "issue"] as const) await get(paths[name]); }
  finally { capture.flush(); }
  await fs.writeFile(path.join(root, `${label}-queries.json`), JSON.stringify(entries, null, 2), { flag: "wx", mode: 0o600 });
  await fs.writeFile(path.join(root, `${label}-timings.json`), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report));
} finally { session.disconnect(); server.close(); await db.$client.end({ timeout: 1 }); }
