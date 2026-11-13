// One-time liveness-first reset (services/docs/agents/liveness-first.md).
// Prefer `paperclipai ops liveness-reset`, which resolves the instance config.
//
//   DATABASE_URL=... tsx scripts/liveness-reset.ts (--dry-run | --apply) --receipt <path>
//     [--server-stopped] [--live-run <runId>]... [--lift-hold <hold>]... [--company <companyId>]
//
// Back up the database first. --apply changes everything in one transaction.
import { parseLivenessResetArgs, runLivenessResetCommand } from "../src/services/recovery/liveness-reset.js";

const command = parseLivenessResetArgs(process.argv.slice(2));
const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("Set DATABASE_URL to the intended instance");
const { receipt, receiptPath } = await runLivenessResetCommand({
  ...command,
  connectionString,
  connectionSource: "DATABASE_URL",
});
console.log(JSON.stringify({ mode: receipt.mode, counts: receipt.counts, receiptPath }, null, 2));
