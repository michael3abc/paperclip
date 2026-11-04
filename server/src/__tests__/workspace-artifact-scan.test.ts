import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  assets,
  companies,
  createDb,
  heartbeatRuns,
  issueAttachments,
  issues,
  issueWorkProducts,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { collectWorkspaceMedia, workspaceArtifactScanService } from "../services/workspace-artifact-scan.js";
import {
  registerWorkspaceArtifactScanWork,
  WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS,
  WORKSPACE_ARTIFACT_SCAN_WINDOW_MS,
} from "../services/workspace-artifact-scan-work.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
// Captured before any test fakes timers: settling real database and file I/O must not move the fake clock.
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

describe("collectWorkspaceMedia", () => {
  let root: string;
  let outside: string;
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("lists only allow-listed media files and never follows symlinks or enters hidden/build directories", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "scan-root-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "scan-outside-"));
    await fs.mkdir(path.join(root, "out/deep"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, "out/reel.MP4"), "video");
    await fs.writeFile(path.join(root, "out/deep/deck.pptx"), "deck");
    await fs.writeFile(path.join(root, "cover.jpg"), "jpg");
    await fs.writeFile(path.join(root, "notes.md"), "text");
    await fs.writeFile(path.join(root, "secret.env"), "KEY=1");
    await fs.writeFile(path.join(root, "page.svg"), "<svg/>");
    await fs.writeFile(path.join(root, ".hidden.png"), "png");
    await fs.writeFile(path.join(root, "empty.png"), "");
    await fs.writeFile(path.join(root, "node_modules/pkg/logo.png"), "png");
    await fs.writeFile(path.join(root, ".git/ref.png"), "png");
    await fs.writeFile(path.join(outside, "stolen.png"), "outside");
    await fs.symlink(path.join(outside, "stolen.png"), path.join(root, "link.png"));
    await fs.symlink(outside, path.join(root, "linked-dir"));

    const files = await collectWorkspaceMedia(root);
    expect(files.map((file) => file.relativePath).sort()).toEqual(["cover.jpg", path.join("out", "deep", "deck.pptx"), path.join("out", "reel.MP4")]);
    expect(files.find((file) => file.relativePath.endsWith("reel.MP4"))?.contentType).toBe("video/mp4");
  });

  it("only returns files modified since the given time", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "scan-root-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "scan-outside-"));
    const old = path.join(root, "old.png");
    await fs.writeFile(old, "old");
    await fs.utimes(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    await fs.writeFile(path.join(root, "new.png"), "new");
    const files = await collectWorkspaceMedia(root, { sinceMs: Date.now() - 60_000 });
    expect(files.map((file) => file.relativePath)).toEqual(["new.png"]);
  });
});

describeEmbeddedPostgres("workspaceArtifactScanService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let root: string;
  const stored = new Map<string, Buffer>();
  const storage: StorageService = {
    provider: "local_disk",
    async putFile(input) {
      const body = input.body as Buffer;
      const objectKey = `${input.namespace}/${randomUUID()}-${input.originalFilename}`;
      stored.set(objectKey, body);
      return { provider: "local_disk", objectKey, contentType: input.contentType, byteSize: body.length, sha256: createHash("sha256").update(body).digest("hex"), originalFilename: input.originalFilename ?? null };
    },
    async getObject() { throw new Error("unused"); },
    async headObject() { throw new Error("unused"); },
    async deleteObject(_companyId, objectKey) { stored.delete(objectKey); },
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-scan-");
    // No idle timeout: on a fake clock an idle close would leave the next query waiting for a reconnect backoff
    // timer that only the fake clock can fire.
    db = createDb(tempDb.connectionString, { idleTimeoutSeconds: 0 });
  }, 20_000);
  afterEach(async () => {
    stored.clear();
    await fs.rm(root, { recursive: true, force: true });
    await db.delete(issueWorkProducts);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed(options: { archivedCwd?: boolean; running?: boolean } = {}) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "scan-ws-"));
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "PAP", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Reels", status: "in_progress" });
    await db.insert(projectWorkspaces).values({ companyId, projectId, name: "main", sourceType: "local_path", cwd: options.archivedCwd ? path.join(root, "missing") : root, isPrimary: true });
    await db.insert(issues).values({ id: issueId, companyId, projectId, identifier: "PAP-1", title: "Make the reel", status: "in_progress", priority: "medium" });
    const startedAt = new Date(Date.now() - 60_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: options.running ? "running" : "succeeded", runtimeMode: "legacy",
      startedAt, finishedAt: options.running ? null : new Date(), contextSnapshot: { issueId } });
    return { companyId, agentId, issueId, runId };
  }

  /** A second project, primary workspace, issue and running run in the same company, rooted in `cwd`. */
  async function seedSecondRun(first: { companyId: string; agentId: string }, cwd: string) {
    const projectId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: first.companyId, name: "Decks", status: "in_progress" });
    await db.insert(projectWorkspaces).values({ companyId: first.companyId, projectId, name: "main", sourceType: "local_path", cwd, isPrimary: true });
    await db.insert(issues).values({ id: issueId, companyId: first.companyId, projectId, identifier: "PAP-2", title: "Make the deck", status: "in_progress", priority: "medium" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: first.companyId, agentId: first.agentId, status: "running", runtimeMode: "legacy",
      startedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId } });
    return { issueId, runId };
  }

  async function attachmentNames(issueId: string) {
    const rows = await db.select({ name: assets.originalFilename }).from(issueAttachments)
      .innerJoin(assets, eq(assets.id, issueAttachments.assetId)).where(eq(issueAttachments.issueId, issueId));
    return rows.map(row => row.name).sort();
  }

  /**
   * The real scanner and worker on a fully fake clock. Each scheduled sweep fires exactly when its timer is due
   * and settles its real database and file I/O before the clock moves again, so sweep times are deterministic.
   * Call before seeding, so run timestamps and file mtimes share the fake clock.
   */
  function finalScanClock() {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => { errors.push(error); } });
    const putFile = vi.spyOn(storage, "putFile");
    const service = workspaceArtifactScanService(db, storage);
    const sweptAt: number[] = [];
    let worker: ReturnType<typeof registerWorkspaceArtifactScanWork> | null = null;
    // postgres.js opens pool connections from zero-delay timers. Fire timers that are already due, without
    // moving the clock, whenever the test is not advancing it.
    let advancing = false;
    const pump = realSetInterval(() => { if (!advancing && vi.isFakeTimers()) vi.advanceTimersByTime(0); }, 2);
    async function advance(ms: number) {
      advancing = true;
      try { await vi.advanceTimersByTimeAsync(ms); } finally { advancing = false; }
    }
    async function settle() {
      for (let i = 0; idleWorkSnapshot().active > 0; i++) {
        if (i > 2_000) throw new Error("artifact sweep did not settle");
        await new Promise(resolve => realSetTimeout(resolve, 5));
      }
    }
    return {
      coordinator, errors, putFile, sweptAt, settle, advance,
      async register() {
        worker = registerWorkspaceArtifactScanWork(coordinator, db, {
          sweepRecentRuns: options => { sweptAt.push(Date.now()); return service.sweepRecentRuns(options); },
        });
        await worker.ready;
        await settle();
      },
      /** Fire every sweep due up to `target`, each at its own deadline, then leave the clock at `target`. */
      async runUntil(target: number) {
        for (let i = 0; i < 200; i++) {
          await settle();
          const at = coordinator.nextWakeAt();
          if (at === null || at > target) {
            await advance(Math.max(0, target - Date.now()));
            return settle();
          }
          await advance(Math.max(0, at - Date.now()));
        }
        throw new Error("artifact sweep did not reach its target time");
      },
      async writeArtifact(dir: string, name: string, body: string) {
        const file = path.join(dir, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, body);
        await fs.utimes(file, new Date(), new Date());
      },
      /** Terminalize through the production path; the finish is stamped a moment before the transition commits. */
      async finishRun(runId: string) {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const finishedAt = new Date(Date.now() - 1_000);
        await terminalizeLegacyExecution({ db, run: run!, status: "succeeded", patch: { finishedAt } });
        return finishedAt.getTime();
      },
      /** (d) With no final scan pending the worker reports no deadline and stays idle without a new transition. */
      async expectIdle() {
        await settle();
        expect(coordinator.nextWakeAt()).toBeNull();
        const sweeps = sweptAt.length;
        await advance(30 * 60_000);
        await settle();
        expect(sweptAt).toHaveLength(sweeps);
        expect(errors).toEqual([]);
      },
      async stop() {
        try {
          await worker?.stop();
          await coordinator.stop();
        } finally {
          putFile.mockRestore();
          realClearInterval(pump);
          vi.useRealTimers();
        }
      },
    };
  }

  it("registers files produced during a run as attachments plus work products, and a rescan adds nothing", async () => {
    const { issueId, runId } = await seed();
    const stale = path.join(root, "stale.pdf");
    await fs.writeFile(stale, "created before the run");
    await fs.utimes(stale, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    await fs.mkdir(path.join(root, "out"));
    await fs.writeFile(path.join(root, "out/reel.mp4"), "video-bytes");
    await fs.writeFile(path.join(root, "src.ts"), "export {}");

    const service = workspaceArtifactScanService(db, storage);
    const first = await service.scanRun(runId);
    expect(first).toMatchObject({ created: 1, candidates: 1 });
    const attachmentRows = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issueId));
    expect(attachmentRows).toHaveLength(1);
    const [asset] = await db.select().from(assets).where(eq(assets.id, attachmentRows[0]!.assetId));
    expect(asset).toMatchObject({ originalFilename: "reel.mp4", contentType: "video/mp4" });
    const products = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ type: "artifact", provider: "paperclip", createdByRunId: runId });

    const second = await service.scanRun(runId);
    expect(second).toMatchObject({ created: 0, skippedDuplicates: 1 });
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issueId))).toHaveLength(1);
    expect(stored.size).toBe(1);
  });

  it("sweeps recently finished runs once and reports nothing when the workspace is not on this host", async () => {
    const { issueId } = await seed();
    await fs.writeFile(path.join(root, "cover.png"), "png-bytes");
    const service = workspaceArtifactScanService(db, storage);
    expect(await service.sweepRecentRuns({ windowMs: 600_000 })).toMatchObject({ runs: 1, scanned: 1, created: 1 });
    expect(await service.sweepRecentRuns({ windowMs: 600_000 })).toMatchObject({ runs: 1, scanned: 0, created: 0 });
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issueId))).toHaveLength(1);

    await fs.rm(root, { recursive: true, force: true });
    await db.delete(issueWorkProducts); await db.delete(issueAttachments); await db.delete(assets); await db.delete(heartbeatRuns);
    await db.delete(issues); await db.delete(projectWorkspaces); await db.delete(projects); await db.delete(agents); await db.delete(companies);
    const missing = await seed({ archivedCwd: true });
    expect(await workspaceArtifactScanService(db, storage).scanIssue(missing.issueId)).toMatchObject({ cwd: null, created: 0, reason: "no_local_workspace" });
  });

  it("wakes its own queue on a real terminal transition, follows up a late file, then goes idle after the window", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => { errors.push(error); } });
    const putFile = vi.spyOn(storage, "putFile");
    try {
      const { issueId, runId } = await seed({ running: true });
      const attachments = () => db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issueId));
      const service = workspaceArtifactScanService(db, storage);
      const sweep = vi.spyOn(service, "sweepRecentRuns");
      await registerWorkspaceArtifactScanWork(coordinator, db, service).ready;
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(coordinator.nextWakeAt()).toBeNull();

      await fs.mkdir(path.join(root, "out"));
      await fs.writeFile(path.join(root, "out/reel.mp4"), "video-bytes");
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await terminalizeLegacyExecution({ db, run: run!, status: "succeeded", patch: { finishedAt: new Date() } });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => expect(await attachments()).toHaveLength(1), { timeout: 5_000 });

      await fs.writeFile(path.join(root, "out/cover.png"), "late-png");
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(async () => expect(await attachments()).toHaveLength(2), { timeout: 5_000 });

      await vi.advanceTimersByTimeAsync(WORKSPACE_ARTIFACT_SCAN_WINDOW_MS);
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0), { timeout: 5_000 });
      expect(coordinator.nextWakeAt()).toBeNull();
      const settledSweeps = sweep.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(sweep).toHaveBeenCalledTimes(settledSweeps);
      // Follow-ups read only file versions they have not handled yet.
      expect(putFile).toHaveBeenCalledTimes(2);
      expect(errors).toEqual([]);
    } finally {
      await coordinator.stop();
      putFile.mockRestore();
      vi.useRealTimers();
    }
  });

  describe("final scan at the end of each run's window", () => {
    const WINDOW = WORKSPACE_ARTIFACT_SCAN_WINDOW_MS;
    // A failed test must not leave the database cleanup hooks on a fake clock.
    afterEach(() => { vi.useRealTimers(); });

    it("discovers a file written ten seconds before the window closes, then goes idle", async () => {
      const clock = finalScanClock();
      try {
        const { issueId, runId } = await seed({ running: true });
        await clock.register();
        await clock.writeArtifact(root, "out/reel.mp4", "video-bytes");
        const finishedAt = await clock.finishRun(runId);
        await clock.runUntil(finishedAt + WINDOW - 10_000);
        await clock.writeArtifact(root, "out/late.png", "late-png");
        await clock.runUntil(finishedAt + WINDOW + 30_000);

        expect(await attachmentNames(issueId)).toEqual(["late.png", "reel.mp4"]);
        expect(Math.max(...clock.sweptAt)).toBeGreaterThanOrEqual(finishedAt + WINDOW);
        // The final scan reads only file versions no earlier scan of the run handled.
        expect(clock.putFile).toHaveBeenCalledTimes(2);
        await clock.expectIdle();
      } finally {
        await clock.stop();
      }
    });

    it("gives each of two runs finished five minutes apart its own final scan", async () => {
      const clock = finalScanClock();
      const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scan-ws-b-"));
      try {
        const first = await seed({ running: true });
        const second = await seedSecondRun(first, otherRoot);
        await clock.register();
        const firstFinishedAt = await clock.finishRun(first.runId);
        await clock.runUntil(firstFinishedAt + 5 * 60_000 + 1_000);
        const secondFinishedAt = await clock.finishRun(second.runId);
        expect(secondFinishedAt - firstFinishedAt).toBe(5 * 60_000);

        await clock.runUntil(firstFinishedAt + WINDOW - 10_000);
        await clock.writeArtifact(root, "out/first-late.png", "first");
        await clock.runUntil(secondFinishedAt + WINDOW - 10_000);
        await clock.writeArtifact(otherRoot, "out/second-late.png", "second");
        await clock.runUntil(secondFinishedAt + WINDOW + 30_000);

        expect(await attachmentNames(first.issueId)).toEqual(["first-late.png"]);
        expect(await attachmentNames(second.issueId)).toEqual(["second-late.png"]);
        expect(clock.sweptAt.some(at => at >= firstFinishedAt + WINDOW && at < secondFinishedAt + WINDOW)).toBe(true);
        expect(Math.max(...clock.sweptAt)).toBeGreaterThanOrEqual(secondFinishedAt + WINDOW);
        await clock.expectIdle();
      } finally {
        await clock.stop();
        await fs.rm(otherRoot, { recursive: true, force: true });
      }
    });

    it.each([
      ["more than a follow-up", WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS + 30_000],
      ["past the scanner's memo retention", 2 * WORKSPACE_ARTIFACT_SCAN_WINDOW_MS + WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS],
    ])("still runs the final scan when its timer fires %s late", async (_label, lateBy) => {
      const clock = finalScanClock();
      try {
        const { issueId, runId } = await seed({ running: true });
        await clock.register();
        const finishedAt = await clock.finishRun(runId);
        await clock.runUntil(finishedAt + WINDOW - 10_000);
        await clock.writeArtifact(root, "out/late.png", "late-png");
        expect(clock.coordinator.nextWakeAt()).toBe(finishedAt + WINDOW);

        // A suspended host: the wall clock jumps while the armed timer keeps its remaining delay, so it fires
        // `lateBy` past the final-scan deadline, when the run is already outside the sweep's SQL window.
        const remaining = finishedAt + WINDOW - Date.now();
        vi.setSystemTime(Date.now() + lateBy);
        await clock.advance(remaining);
        await clock.settle();

        expect(clock.sweptAt.at(-1)).toBe(finishedAt + WINDOW + lateBy);
        expect(await attachmentNames(issueId)).toEqual(["late.png"]);
        await clock.expectIdle();
      } finally {
        await clock.stop();
      }
    });
  });
});
