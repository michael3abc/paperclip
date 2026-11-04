import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assets,
  executionWorkspaces,
  heartbeatRuns,
  issueAttachments,
  issues,
  projectWorkspaces,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";
import { issueService } from "./issues.js";

/**
 * Media-only allow-list. Anything not listed here is never read, so source code, configs, logs and
 * credentials in a workspace can never be uploaded. SVG/HTML are excluded on purpose (script-capable).
 */
export const WORKSPACE_SCAN_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export const WORKSPACE_SCAN_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const WORKSPACE_SCAN_MAX_FILES = 25;
const MAX_DEPTH = 6;
const MAX_VISITED_ENTRIES = 20_000;
// Dependency and build trees only. Output folders such as out/, tmp/ and renders/ are exactly where agents put media.
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "target", "vendor", "venv", "__pycache__", "coverage"]);

export interface WorkspaceScanFile { absolutePath: string; relativePath: string; size: number; mtimeMs: number; contentType: string }
export interface WorkspaceScanResult { cwd: string | null; created: number; skippedDuplicates: number; candidates: number; reason?: string }
export interface WorkspaceSweepResult {
  runs: number; scanned: number; created: number;
  /** Earliest `finishedAt + windowMs` of a swept run still awaiting its final scan, or null when none is pending. */
  nextFinalScanAt: number | null;
}

/**
 * Collect media files under `root` modified at or after `sinceMs`. Symlinks are never followed or listed, hidden
 * entries and build/vendor directories are skipped, and every file is re-checked against the real root path.
 */
export async function collectWorkspaceMedia(root: string, options: { sinceMs?: number | null } = {}): Promise<WorkspaceScanFile[]> {
  const realRoot = await fs.realpath(root);
  const found: WorkspaceScanFile[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || visited > MAX_VISITED_ENTRIES) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++visited > MAX_VISITED_ENTRIES) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const contentType = WORKSPACE_SCAN_CONTENT_TYPES[path.extname(entry.name).toLowerCase()];
      if (!contentType) continue;
      const stat = await fs.lstat(full).catch(() => null);
      if (!stat?.isFile() || stat.size === 0 || stat.size > WORKSPACE_SCAN_MAX_FILE_BYTES) continue;
      if (options.sinceMs != null && stat.mtimeMs < options.sinceMs) continue;
      const real = await fs.realpath(full).catch(() => null);
      if (!real || (real !== realRoot && !real.startsWith(realRoot + path.sep))) continue;
      found.push({ absolutePath: real, relativePath: path.relative(realRoot, real), size: stat.size, mtimeMs: stat.mtimeMs, contentType });
    }
  };
  await walk(realRoot, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, WORKSPACE_SCAN_MAX_FILES);
}

async function readRegularFile(file: WorkspaceScanFile): Promise<Buffer | null> {
  const handle = await fs.open(file.absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > WORKSPACE_SCAN_MAX_FILE_BYTES) return null;
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** Where one scan looks and whom it credits; resolved from the database once per run. */
interface ScanTarget { issueId: string; companyId: string; cwd: string; sinceMs: number | null; agentId: string | null; runId: string | null }
interface Unresolved { reason: "issue_not_found" | "no_local_workspace" | "run_without_issue" }
const unresolvedResult = (reason: string): WorkspaceScanResult => ({ cwd: null, created: 0, skippedDuplicates: 0, candidates: 0, reason });

export function workspaceArtifactScanService(db: Db, storage: StorageService) {
  const issuesSvc = issueService(db);
  // Per-run memo for every run a sweep has seen: when it finished and was last scanned, which file versions were
  // already handled (so a rescan only reads files that are new or changed), whether its final scan has run, and the
  // issue/workspace its first scan resolved (so a rescan does not query the database to find it again).
  // A run awaiting its final scan stays here after it leaves the SQL window, so a late timer cannot drop it.
  const sweptRuns = new Map<string, { finishedAt: number; scannedAt: number | null; files: Set<string>; final: boolean; target: ScanTarget | null }>();

  /** Execution workspace first, then the issue's project workspace, then the project's primary one. Local paths only. */
  async function resolveWorkspaceCwd(issue: { id: string; projectId: string | null; projectWorkspaceId: string | null; executionWorkspaceId: string | null }) {
    const candidates: Array<string | null> = [];
    if (issue.executionWorkspaceId) {
      const [row] = await db.select({ cwd: executionWorkspaces.cwd }).from(executionWorkspaces).where(eq(executionWorkspaces.id, issue.executionWorkspaceId)).limit(1);
      candidates.push(row?.cwd ?? null);
    }
    if (issue.projectWorkspaceId) {
      const [row] = await db.select({ cwd: projectWorkspaces.cwd }).from(projectWorkspaces).where(eq(projectWorkspaces.id, issue.projectWorkspaceId)).limit(1);
      candidates.push(row?.cwd ?? null);
    }
    if (issue.projectId) {
      const [row] = await db.select({ cwd: projectWorkspaces.cwd }).from(projectWorkspaces)
        .where(and(eq(projectWorkspaces.projectId, issue.projectId), eq(projectWorkspaces.sourceType, "local_path")))
        .orderBy(desc(projectWorkspaces.isPrimary)).limit(1);
      candidates.push(row?.cwd ?? null);
    }
    for (const cwd of candidates) {
      if (!cwd || !path.isAbsolute(cwd)) continue;
      const stat = await fs.stat(cwd).catch(() => null);
      if (stat?.isDirectory()) return cwd;
    }
    return null;
  }

  async function resolveIssueTarget(issueId: string, options: { sinceMs?: number | null; agentId?: string | null; runId?: string | null }): Promise<ScanTarget | Unresolved> {
    const [issue] = await db.select({
      id: issues.id, companyId: issues.companyId, projectId: issues.projectId,
      projectWorkspaceId: issues.projectWorkspaceId, executionWorkspaceId: issues.executionWorkspaceId,
    }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) return { reason: "issue_not_found" };
    const cwd = await resolveWorkspaceCwd(issue);
    if (!cwd) return { reason: "no_local_workspace" };
    return { issueId: issue.id, companyId: issue.companyId, cwd, sinceMs: options.sinceMs ?? null, agentId: options.agentId ?? null, runId: options.runId ?? null };
  }

  async function resolveRunTarget(runId: string): Promise<ScanTarget | Unresolved> {
    const [run] = await db.select({
      id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, startedAt: heartbeatRuns.startedAt, createdAt: heartbeatRuns.createdAt,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'issueId'`,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
    if (!run?.issueId) return { reason: "run_without_issue" };
    return resolveIssueTarget(run.issueId, { sinceMs: (run.startedAt ?? run.createdAt).getTime(), agentId: run.agentId, runId: run.id });
  }

  /**
   * Register unseen media under an already resolved target. File versions in `seenFiles` (path, size, mtime) are
   * skipped without reading, and the set is updated in place. The database is touched only when an unseen file
   * exists, so a rescan that finds nothing new costs a directory walk and no query.
   */
  async function scanTarget(target: ScanTarget, seenFiles?: Set<string>): Promise<WorkspaceScanResult> {
    const stat = await fs.stat(target.cwd).catch(() => null);
    if (!stat?.isDirectory()) return unresolvedResult("no_local_workspace");
    const files = await collectWorkspaceMedia(target.cwd, { sinceMs: target.sinceMs });
    const signatureOf = (file: WorkspaceScanFile) => `${file.relativePath}\0${file.size}\0${file.mtimeMs}`;
    const unseen = seenFiles ? files.filter(file => !seenFiles.has(signatureOf(file))) : files;
    let created = 0, skippedDuplicates = files.length - unseen.length;
    if (!unseen.length) return { cwd: target.cwd, created, skippedDuplicates, candidates: files.length };
    const known = new Set((await db.select({ sha256: assets.sha256 }).from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .where(and(eq(issueAttachments.issueId, target.issueId), eq(issueAttachments.companyId, target.companyId)))).map((row) => row.sha256));

    for (const file of unseen) {
      const signature = signatureOf(file);
      const body = await readRegularFile(file);
      if (!body) continue;
      const stored = await storage.putFile({ companyId: target.companyId, namespace: `issues/${target.issueId}`, originalFilename: path.basename(file.relativePath), contentType: file.contentType, body });
      if (known.has(stored.sha256)) {
        skippedDuplicates++;
        seenFiles?.add(signature);
        await storage.deleteObject(target.companyId, stored.objectKey).catch(() => undefined);
        continue;
      }
      try {
        await issuesSvc.createAttachment({
          issueId: target.issueId, provider: stored.provider, objectKey: stored.objectKey, contentType: stored.contentType,
          byteSize: stored.byteSize, sha256: stored.sha256, originalFilename: stored.originalFilename,
          createdByAgentId: target.agentId, createdByRunId: target.runId,
        });
        known.add(stored.sha256);
        seenFiles?.add(signature);
        created++;
      } catch (err) {
        await storage.deleteObject(target.companyId, stored.objectKey).catch(() => undefined);
        logger.warn({ err, issueId: target.issueId, file: file.relativePath }, "workspace artifact scan could not register a file");
      }
    }
    return { cwd: target.cwd, created, skippedDuplicates, candidates: files.length };
  }

  async function scanIssue(issueId: string, options: {
    sinceMs?: number | null; agentId?: string | null; runId?: string | null;
    /** File versions (path, size, mtime) already handled; skipped without reading and updated in place. */
    seenFiles?: Set<string>;
  } = {}): Promise<WorkspaceScanResult> {
    const target = await resolveIssueTarget(issueId, options);
    return "reason" in target ? unresolvedResult(target.reason) : scanTarget(target, options.seenFiles);
  }

  /** Scan one finished run: only files modified since the run started are considered. */
  async function scanRun(runId: string, options: { seenFiles?: Set<string> } = {}): Promise<WorkspaceScanResult> {
    const target = await resolveRunTarget(runId);
    return "reason" in target ? unresolvedResult(target.reason) : scanTarget(target, options.seenFiles);
  }

  /**
   * Idempotent sweep (attachments are de-duplicated by sha256), so a restart or an overlapping window is harmless.
   * A run inside the window is scanned once unless `rescanAfterMs` is given; then it is rescanned once that much
   * time has passed. Every run a sweep has seen also gets one final scan from the first sweep at or after
   * `finishedAt + windowMs`: it ignores the rescan throttle and is found by run id, so it still happens when the
   * run has left the window because the sweep came late. Rescans and the final scan read only unseen file versions.
   *
   * Database cost: discovery (`discover`, default true) selects the terminal runs in the window. The first scan of
   * a run resolves its issue and workspace once and keeps that target; later rescans walk the workspace and query
   * only when an unseen file exists. A run with nothing to scan here (no issue, no local workspace, or a workspace
   * that has gone) is done after that scan. A sweep without discovery that finds no new file issues no query, so a
   * caller can keep an idle server quiet by discovering only when a run transition was signalled.
   */
  async function sweepRecentRuns(options: { windowMs: number; limit?: number; rescanAfterMs?: number; discover?: boolean }): Promise<WorkspaceSweepResult> {
    const now = Date.now();
    // Forget runs well past their window once their final scan is done; a pending final scan is never forgotten.
    for (const [id, memo] of sweptRuns) if (memo.final && now - memo.finishedAt > options.windowMs * 2) sweptRuns.delete(id);
    const rows = options.discover === false ? [] : await db.select({ id: heartbeatRuns.id, finishedAt: heartbeatRuns.finishedAt }).from(heartbeatRuns)
      .where(and(inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out"]), isNotNull(heartbeatRuns.finishedAt),
        gte(heartbeatRuns.finishedAt, new Date(now - options.windowMs))))
      .orderBy(desc(heartbeatRuns.finishedAt)).limit(options.limit ?? 50);
    for (const row of rows) {
      if (!sweptRuns.has(row.id)) {
        sweptRuns.set(row.id, { finishedAt: row.finishedAt?.getTime() ?? now, scannedAt: null, files: new Set(), final: false, target: null });
      }
    }
    let created = 0, scanned = 0;
    for (const [runId, memo] of sweptRuns) {
      if (memo.final) continue;
      const final = now >= memo.finishedAt + options.windowMs;
      // Same bound as the discovery query, taken from the memo so a sweep without discovery rescans the same runs.
      const inWindow = memo.finishedAt >= now - options.windowMs;
      const rescanDue = inWindow && (memo.scannedAt === null
        || (options.rescanAfterMs != null && now - memo.scannedAt >= options.rescanAfterMs));
      if (!final && !rescanDue) continue;
      // A failed final scan is logged and not retried, so a broken workspace cannot keep the worker awake.
      memo.scannedAt = now;
      memo.final = final;
      scanned++;
      try {
        if (!memo.target) {
          const target = await resolveRunTarget(runId);
          if ("reason" in target) { memo.final = true; continue; }
          memo.target = target;
        }
        const result = await scanTarget(memo.target, memo.files);
        if (result.reason) memo.final = true;
        created += result.created;
      } catch (err) { logger.warn({ err, runId }, "workspace artifact scan failed for run"); }
    }
    let nextFinalScanAt: number | null = null;
    for (const memo of sweptRuns.values()) {
      if (!memo.final) nextFinalScanAt = Math.min(nextFinalScanAt ?? Infinity, memo.finishedAt + options.windowMs);
    }
    return { runs: rows.length, scanned, created, nextFinalScanAt };
  }

  return { scanIssue, scanRun, sweepRecentRuns };
}
