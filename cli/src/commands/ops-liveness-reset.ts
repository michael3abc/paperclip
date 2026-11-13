import fs from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Command } from "commander";
import { readConfig } from "../config/store.js";

const DATA_DIR_OPTION_HELP = "Paperclip data directory root (isolates state from ~/.paperclip)";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mirrors the server's never-lifted holds so a bad flag fails before connecting. */
const NEVER_LIFTED_PAUSE_HOLDS = ["manual", "setup", "company_paused", "company_archived"];

export type OpsLivenessResetOptions = {
  config?: string;
  dataDir?: string;
  dryRun?: boolean;
  apply?: boolean;
  receipt?: string;
  serverStopped?: boolean;
  liveRun?: string[];
  liftHold?: string[];
  company?: string;
};

export type ResolvedLivenessResetOptions = {
  mode: "dry-run" | "apply";
  receiptPath: string;
  serverStopped: boolean;
  liveRunIds: string[];
  liftPauseHolds?: string[];
  companyId?: string;
};

type LivenessResetModule = {
  runLivenessResetCommand(input: ResolvedLivenessResetOptions & { connectionString: string; connectionSource: string }):
    Promise<{ receipt: { mode: string; counts: Record<string, number> }; receiptPath: string }>;
};

function pathExists(target: string) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Validates options before anything connects. The receipt is mandatory and never overwritten. */
export function resolveLivenessResetOptions(opts: OpsLivenessResetOptions, cwd = process.cwd()): ResolvedLivenessResetOptions {
  if (Boolean(opts.dryRun) === Boolean(opts.apply)) throw new Error("Choose exactly one of --dry-run or --apply.");
  const receipt = opts.receipt?.trim();
  if (!receipt) throw new Error("--receipt <path> is required; the liveness reset never runs without a receipt.");
  const receiptPath = path.resolve(cwd, receipt);
  if (pathExists(receiptPath)) throw new Error(`Receipt already exists: ${receiptPath}. Choose a new receipt path.`);
  const receiptDir = path.dirname(receiptPath);
  if (!pathExists(receiptDir) || !fs.statSync(receiptDir).isDirectory()) {
    throw new Error(`Receipt directory does not exist: ${receiptDir}`);
  }
  const liveRunIds = [...new Set(opts.liveRun ?? [])];
  for (const id of [...liveRunIds, ...(opts.company ? [opts.company] : [])]) {
    if (!UUID_PATTERN.test(id)) throw new Error(`Invalid UUID: ${id}`);
  }
  const liftPauseHolds = (opts.liftHold ?? []).map(hold => hold.trim()).filter(Boolean);
  const forbidden = liftPauseHolds.filter(hold => NEVER_LIFTED_PAUSE_HOLDS.includes(hold));
  if (forbidden.length) throw new Error(`The liveness reset never lifts these pause holds: ${forbidden.join(", ")}`);
  return {
    mode: opts.apply ? "apply" : "dry-run",
    receiptPath,
    serverStopped: opts.serverStopped === true,
    liveRunIds,
    ...(liftPauseHolds.length ? { liftPauseHolds } : {}),
    ...(opts.company ? { companyId: opts.company } : {}),
  };
}

/** Same resolution as `db:backup`. Only the source label is ever printed or stored. */
export function resolveLivenessResetConnection(configPath?: string): { value: string; source: string } {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return { value: envUrl, source: "DATABASE_URL" };
  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return { value: config.database.connectionString.trim(), source: "config.database.connectionString" };
  }
  const port = config?.database.embeddedPostgresPort ?? 54329;
  return { value: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`, source: `embedded-postgres@${port}` };
}

/** Loads only the reset module: the dev workspace source, else the installed server's dist. */
async function importLivenessResetModule(): Promise<LivenessResetModule> {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const devModule = path.resolve(projectRoot, "server/src/services/recovery/liveness-reset.ts");
  if (fs.existsSync(devModule)) return await import(pathToFileURL(devModule).href) as LivenessResetModule;

  const entry = await realpath(fileURLToPath(import.meta.resolve("@paperclipai/server")));
  if (!entry.endsWith(`${path.sep}dist${path.sep}index.js`)) throw new Error("The liveness reset requires the published server layout");
  const root = path.resolve(path.dirname(entry), "..");
  const manifest = path.join(root, "package.json");
  const info = await lstat(manifest);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || JSON.parse(await readFile(manifest, "utf8")).name !== "@paperclipai/server") {
    throw new Error("The installed server package identity is invalid");
  }
  const modulePath = path.join(root, "dist/services/recovery/liveness-reset.js");
  if (await realpath(modulePath) !== modulePath || !(await lstat(modulePath)).isFile()) {
    throw new Error("The liveness reset module escapes its installed server");
  }
  return await import(pathToFileURL(modulePath).href) as LivenessResetModule;
}

export async function opsLivenessResetCommand(opts: OpsLivenessResetOptions): Promise<void> {
  const resolved = resolveLivenessResetOptions(opts);
  const connection = resolveLivenessResetConnection(opts.config);
  const reset = await importLivenessResetModule();
  const { receipt, receiptPath } = await reset.runLivenessResetCommand({
    ...resolved,
    connectionString: connection.value,
    connectionSource: connection.source,
  });
  console.log(JSON.stringify({ mode: receipt.mode, connectionSource: connection.source, counts: receipt.counts, receiptPath }, null, 2));
}

function collect(value: string, previous: string[]) {
  return [...previous, value];
}

export function registerOpsCommands(program: Command): void {
  const ops = program.command("ops").description("One-time operational maintenance");
  ops
    .command("liveness-reset")
    .description("One-time liveness-first cleanup of orphaned runs, recovery holds, system pauses and stale locks. Back up the database first.")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--dry-run", "List every row the reset would change without changing anything")
    .option("--apply", "Apply every change in a single database transaction")
    .option("--receipt <path>", "New JSON receipt file (required; an existing file is never overwritten)")
    .option("--server-stopped", "Assert that no Paperclip server is running, so every running run is orphaned")
    .option("--live-run <runId>", "Run still owned by a live process; never changed (repeatable)", collect, [])
    .option("--lift-hold <hold>", "System pause hold to lift (repeatable; default: system)", collect, [])
    .option("--company <companyId>", "Limit the reset to one company")
    .action(opsLivenessResetCommand);
}
