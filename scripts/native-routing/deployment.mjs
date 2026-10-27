import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";

const filename = process.env.PAPERCLIP_DEPLOYMENT_CONFIG;
if (!filename || !path.isAbsolute(filename)) throw new Error("PAPERCLIP_DEPLOYMENT_CONFIG must name an absolute deployment JSON file");
export const deployment = JSON.parse(await fs.readFile(filename, "utf8"));
for (const key of ["app", "serverPackagePath", "runtimeRoot", "nodeBin", "databaseUrlFile", "authEnvFile"]) {
  if (typeof deployment[key] !== "string" || !path.isAbsolute(deployment[key])) throw new Error(`Deployment ${key} must be an absolute path`);
}
for (const key of ["apiUrl", "routerUrl"]) {
  const url = new URL(deployment[key]);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error(`Deployment ${key} must be a credential-free HTTP origin`);
  deployment[key] = url.origin;
}
for (const id of [deployment.companyId, ...Object.values(deployment.connections ?? {})]) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Deployment IDs must be explicit UUIDs");
}
// Better Auth user IDs are opaque text, unlike company and connection UUIDs.
if (typeof deployment.ownerId !== "string" || !deployment.ownerId.trim() || deployment.ownerId !== deployment.ownerId.trim()) throw new Error("Configure the existing operator's opaque ownerId");
const routeKeys = ["anthropic-gateway", "anthropic-local", "openai-gateway", "openai-local"];
if (routeKeys.some(key => !deployment.connections?.[key]) || new Set(Object.values(deployment.connections)).size !== 4) throw new Error("Configure exactly four distinct existing routing connection IDs");
if (!/^[a-zA-Z0-9_.-]+$/.test(deployment.sessionCookieName ?? "")) throw new Error("Configure the instance sessionCookieName");
export const { app, companyId, ownerId } = deployment;
export const requireApp = createRequire(path.join(app, "package.json"));

async function readPrivate(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error("Deployment secret files must be owner-only regular files");
  return fs.readFile(file, "utf8");
}
export async function databaseUrl() { return (await readPrivate(deployment.databaseUrlFile)).trim(); }

/** Reuse the configured operator's existing session without creating identities. */
export async function admin() {
  const sql = requireApp("postgres")(await databaseUrl(), { max: 1, connect_timeout: 5 });
  let session;
  try {
    [session] = await sql`select token from session where user_id=${ownerId} and expires_at>now() order by updated_at desc limit 1`;
  } finally { await sql.end(); }
  if (!session) throw new Error("Sign in to Paperclip before running administration");
  const env = requireApp("dotenv").parse(await readPrivate(deployment.authEnvFile));
  const secret = env.BETTER_AUTH_SECRET ?? env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) throw new Error("Paperclip auth signing secret unavailable");
  const signature = createHmac("sha256", secret).update(session.token).digest("base64");
  const cookie = `${deployment.sessionCookieName}=${encodeURIComponent(`${session.token}.${signature}`)}`;
  return {
    origin: deployment.apiUrl,
    async call(method, endpoint, body) {
      if (!endpoint.startsWith("/api/") || endpoint.includes("\\")) throw new Error("Use a relative Paperclip API path");
      const url = new URL(endpoint, deployment.apiUrl);
      if (url.origin !== deployment.apiUrl) throw new Error("API origin mismatch");
      const response = await fetch(url, {
        method, redirect: "error", signal: AbortSignal.timeout(120000),
        headers: { cookie, origin: deployment.apiUrl, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Provider errors may contain credentials. Keep error bodies out of logs.
      if (!response.ok) throw new Error(`Paperclip ${method}: HTTP ${response.status}`);
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    },
  };
}
