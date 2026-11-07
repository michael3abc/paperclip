import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../middleware/logger.js";

/** Inspect local same-user processes once at an ownership/deletion boundary.
 * No command lines or environments are read or retained. Configured production
 * sources and managed runtime-service records provide the cross-user boundary.
 */
export async function workspaceProcessConsumers(root: string): Promise<number[]> {
  if (process.platform !== "linux") throw new Error("workspace_process_inspection_unsupported");
  const canonical = await fs.realpath(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!canonical) return [];
  const consumers: number[] = [];
  const inaccessible: number[] = [];
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if ((await fs.stat(`/proc/${entry}`)).uid !== process.getuid!()) continue;
      const cwd = await fs.realpath(`/proc/${entry}/cwd`);
      const relative = path.relative(canonical, cwd);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) consumers.push(Number(entry));
    } catch (error) {
      if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        inaccessible.push(Number(entry)); continue;
      }
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  // Privilege-separated host brokers (e.g. sshd-session) can have this UID
  // without exposing cwd. They are outside this supplementary observation;
  // the authoritative managed-run/lease/service checks must never be replaced
  // by a negative procfs scan. Make its visibility limit explicit.
  if (inaccessible.length) logger.warn({ event: "workspace.process_inspection_limited", cwd: canonical,
    inaccessibleProcessCount: inaccessible.length }, "Some host process paths are not observable; managed ownership checks remain authoritative");
  return consumers;
}
