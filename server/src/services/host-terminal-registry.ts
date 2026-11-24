import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { badRequest, notFound } from "../errors.js";

const absolutePath = z.string().regex(/^\/[a-zA-Z0-9/_.@+-]*$/).max(4096);
const hostSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.-]+$/).max(128),
  label: z.string().trim().min(1).max(200),
  sshAlias: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).max(128).optional(),
  companyIds: z.array(z.string()),
  terminal: z.object({ enabled: z.boolean(), cwd: absolutePath.optional() }).strict().optional(),
});
export type TerminalHost = z.infer<typeof hostSchema>;

// Same company-scoped operator registry as host Claude/Codex sign-in. Other
// capabilities remain owned by those services; only terminal fields are read.
export async function listTerminalHosts(companyId: string): Promise<TerminalHost[]> {
  const file = process.env.PAPERCLIP_CCPOCKET_HOSTS_FILE ?? path.join(homedir(), ".config/paperclip-ccpocket/hosts.json");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, "utf8")); }
  catch { throw badRequest("Host registry is unavailable or invalid"); }
  const registry = z.object({ version: z.literal(1), hosts: z.array(z.unknown()) }).safeParse(raw);
  if (!registry.success) throw badRequest("Invalid host registry");
  const hosts: TerminalHost[] = [];
  const ids = new Set<string>();
  for (const entry of registry.data.hosts) {
    const scope = z.object({ companyIds: z.array(z.string()) }).safeParse(entry);
    if (!scope.success) throw badRequest("Invalid host registry scope");
    if (!scope.data.companyIds.includes(companyId)) continue;
    const parsed = hostSchema.safeParse(entry);
    if (!parsed.success || ids.has(parsed.data.id)) throw badRequest("Invalid host terminal configuration");
    ids.add(parsed.data.id);
    if (parsed.data.terminal?.enabled === true) hosts.push(parsed.data);
  }
  return hosts;
}

export async function getTerminalHost(companyId: string, hostId: string) {
  const host = (await listTerminalHosts(companyId)).find(host => host.id === hostId);
  if (!host) throw notFound("Host terminal is unavailable");
  return host;
}
