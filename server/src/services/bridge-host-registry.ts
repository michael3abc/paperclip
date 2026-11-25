import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { unprocessable } from "../errors.js";

/**
 * IDs of the CC Pocket Bridge hosts this company may use, from the same
 * company-scoped operator registry as host sign-in and terminals. Only `id` and
 * `companyIds` are read; nothing else in the registry is exposed.
 */
export async function listCompanyBridgeHostIds(companyId: string): Promise<string[]> {
  const file = process.env.PAPERCLIP_CCPOCKET_HOSTS_FILE ?? path.join(homedir(), ".config/paperclip-ccpocket/hosts.json");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, "utf8")); }
  catch { throw unprocessable("The CC Pocket host registry is unavailable; the working directory cannot be verified."); }
  const hosts = (raw as { version?: unknown; hosts?: unknown })?.hosts;
  if ((raw as { version?: unknown })?.version !== 1 || !Array.isArray(hosts)) {
    throw unprocessable("The CC Pocket host registry is invalid; the working directory cannot be verified.");
  }
  return hosts.flatMap((host: unknown) => {
    const entry = host as { id?: unknown; companyIds?: unknown };
    return typeof entry?.id === "string" && Array.isArray(entry.companyIds) && entry.companyIds.includes(companyId) ? [entry.id] : [];
  });
}
