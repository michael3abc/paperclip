import { Readable } from "node:stream";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  assets,
  companies,
  createDb,
  documentMemberships,
  documents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueDocuments,
  issues,
  issueWorkProducts,
  projects,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { companyArtifactsService } from "../services/company-artifacts.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company artifacts tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createStorageService(files: Record<string, Buffer> = {}): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject: vi.fn(async (_companyId, objectKey, options) => {
      const body = files[objectKey] ?? Buffer.alloc(0);
      const range = options?.range;
      const ranged = range ? body.subarray(range.start, range.end + 1) : body;
      return {
        stream: Readable.from(ranged),
        contentType: "text/plain",
        contentLength: ranged.length,
      };
    }),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

describeEmbeddedPostgres("companyArtifactsService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-artifacts-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(documentMemberships);
    await db.delete(issueWorkProducts);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedArtifacts() {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const otherCompanyId = "22222222-2222-4222-8222-222222222222";
    const agentId = "33333333-3333-4333-8333-333333333333";
    const otherAgentId = "44444444-4444-4444-8444-444444444444";
    const projectId = "55555555-5555-4555-8555-555555555555";
    const issueId = "66666666-6666-4666-8666-666666666666";
    const secondIssueId = "77777777-7777-4777-8777-777777777777";
    const otherIssueId = "88888888-8888-4888-8888-888888888888";
    const runId = "99999999-9999-4999-8999-999999999999";
    const otherRunId = "19191919-1919-4191-8191-191919191919";
    const directAttachmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const workProductAttachmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    await db.insert(companies).values([
      { id: companyId, name: "Paperclip", issuePrefix: "PAP", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "OtherCo", issuePrefix: "OTH", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Coder", role: "engineer" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Other", role: "engineer" },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Artifacts", status: "in_progress" });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        projectId,
        identifier: "PAP-1",
        title: "Make the reel",
        status: "done",
        priority: "medium",
      },
      {
        id: secondIssueId,
        companyId,
        identifier: "PAP-2",
        title: "Write the plan",
        status: "done",
        priority: "medium",
      },
      {
        id: otherIssueId,
        companyId: otherCompanyId,
        identifier: "OTH-1",
        title: "Other output",
        status: "done",
        priority: "medium",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        status: "completed",
      },
      {
        id: otherRunId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        status: "completed",
      },
    ]);
    await db.insert(documents).values([
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        companyId,
        title: "Review Notes",
        latestBody: "# Review\n\nAgent-created review document with useful details.",
        createdByAgentId: agentId,
        updatedAt: new Date("2026-01-04T00:00:00.000Z"),
      },
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        companyId,
        title: "Continuation Summary",
        latestBody: "System handoff",
        createdByAgentId: agentId,
        updatedAt: new Date("2026-01-05T00:00:00.000Z"),
      },
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        companyId,
        title: "User Upload Notes",
        latestBody: "User-authored context",
        createdByUserId: "user-1",
        updatedAt: new Date("2026-01-06T00:00:00.000Z"),
      },
      {
        id: "20202020-2020-4020-8020-202020202020",
        companyId,
        title: "Plan",
        latestBody: "Human-approved plan",
        createdByUserId: "user-1",
        updatedAt: new Date("2026-01-08T00:00:00.000Z"),
      },
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        companyId: otherCompanyId,
        title: "Other Company Plan",
        latestBody: "Must not cross tenants",
        createdByAgentId: otherAgentId,
        updatedAt: new Date("2026-01-07T00:00:00.000Z"),
      },
    ]);
    await db.insert(issueDocuments).values([
      {
        companyId,
        issueId: secondIssueId,
        documentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        key: "review",
      },
      {
        companyId,
        issueId,
        documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      },
      {
        companyId,
        issueId,
        documentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        key: "user-notes",
      },
      {
        companyId,
        issueId: secondIssueId,
        documentId: "20202020-2020-4020-8020-202020202020",
        key: "plan",
      },
      {
        companyId: otherCompanyId,
        issueId: otherIssueId,
        documentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        key: "plan",
      },
    ]);
    await db.insert(issueComments).values({
      id: "12121212-1212-4121-8121-121212121212",
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "comment with screenshot",
    });
    await db.insert(assets).values([
      {
        id: "13131313-1313-4131-8131-131313131313",
        companyId,
        provider: "local_disk",
        objectKey: "direct-video.mp4",
        contentType: "video/mp4",
        byteSize: 100,
        sha256: "sha256-direct-video",
        originalFilename: "direct-video.mp4",
        createdByAgentId: agentId,
      },
      {
        id: "14141414-1414-4141-8141-141414141414",
        companyId,
        provider: "local_disk",
        objectKey: "primary-cut.mp4",
        contentType: "video/mp4",
        byteSize: 200,
        sha256: "sha256-primary-cut",
        originalFilename: "primary-cut.mp4",
        createdByAgentId: agentId,
      },
      {
        id: "15151515-1515-4151-8151-151515151515",
        companyId,
        provider: "local_disk",
        objectKey: "operator-screenshot.png",
        contentType: "image/png",
        byteSize: 300,
        sha256: "sha256-user",
        originalFilename: "operator-screenshot.png",
        createdByUserId: "user-1",
      },
      {
        id: "16161616-1616-4161-8161-161616161616",
        companyId,
        provider: "local_disk",
        objectKey: "comment-screenshot.png",
        contentType: "image/png",
        byteSize: 400,
        sha256: "sha256-comment",
        originalFilename: "comment-screenshot.png",
        createdByAgentId: agentId,
      },
      {
        id: "17171717-1717-4171-8171-171717171717",
        companyId,
        provider: "local_disk",
        objectKey: "notes.txt",
        contentType: "text/plain",
        byteSize: 64,
        sha256: "sha256-notes",
        originalFilename: "notes.txt",
        createdByAgentId: agentId,
      },
    ]);
    await db.insert(issueAttachments).values([
      {
        id: directAttachmentId,
        companyId,
        issueId,
        assetId: "13131313-1313-4131-8131-131313131313",
        updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      {
        id: workProductAttachmentId,
        companyId,
        issueId,
        assetId: "14141414-1414-4141-8141-141414141414",
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        companyId,
        issueId,
        assetId: "15151515-1515-4151-8151-151515151515",
        updatedAt: new Date("2026-01-08T00:00:00.000Z"),
      },
      {
        companyId,
        issueId,
        assetId: "16161616-1616-4161-8161-161616161616",
        issueCommentId: "12121212-1212-4121-8121-121212121212",
        updatedAt: new Date("2026-01-09T00:00:00.000Z"),
      },
      {
        companyId,
        issueId,
        assetId: "17171717-1717-4171-8171-171717171717",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    await db.insert(issueWorkProducts).values({
      id: "18181818-1818-4181-8181-181818181818",
      companyId,
      projectId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Primary Cut",
      status: "ready_for_review",
      summary: "Main render for review",
      isPrimary: true,
      metadata: {
        attachmentId: workProductAttachmentId,
        contentType: "video/mp4",
        byteSize: 200,
        contentPath: `/api/attachments/${workProductAttachmentId}/content`,
        openPath: `/api/attachments/${workProductAttachmentId}/content`,
        downloadPath: `/api/attachments/${workProductAttachmentId}/content?download=1`,
        originalFilename: "primary-cut.mp4",
      },
      createdByRunId: runId,
      updatedAt: new Date("2026-01-02T12:00:00.000Z"),
    });

    return { companyId, otherCompanyId, projectId, issueId, secondIssueId, otherIssueId, otherRunId };
  }

  it("returns only the caller's starred documents, including plan and human-authored documents, with cursor order", async () => {
    const { companyId } = await seedArtifacts();
    await db.insert(documentMemberships).values([
      {
        companyId,
        documentId: "20202020-2020-4020-8020-202020202020",
        userId: "user-1",
        starredAt: new Date("2026-02-03T00:00:00.000Z"),
      },
      {
        companyId,
        documentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        userId: "user-1",
        starredAt: new Date("2026-02-02T00:00:00.000Z"),
      },
      {
        companyId,
        documentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        userId: "other-user",
        starredAt: new Date("2026-02-04T00:00:00.000Z"),
      },
    ]);

    const app = express();
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "viewer", status: "active" }],
      };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService()));
    app.use(errorHandler);

    const first = await request(app).get(`/api/companies/${companyId}/artifacts?starred=true&limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.artifacts.map((artifact: { title: string }) => artifact.title)).toEqual(["Plan"]);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app).get(
      `/api/companies/${companyId}/artifacts?starred=true&limit=10&cursor=${first.body.nextCursor}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.artifacts.map((artifact: { title: string }) => artifact.title)).toEqual(["User Upload Notes"]);
    expect(second.body.artifacts.every((artifact: { source: string }) => artifact.source === "document")).toBe(true);

    const incompatibleKind = await request(app).get(
      `/api/companies/${companyId}/artifacts?starred=true&kind=image`,
    );
    expect(incompatibleKind.status).toBe(200);
    expect(incompatibleKind.body).toEqual({ artifacts: [], nextCursor: null });
  });

  it("returns an empty starred view for agent callers", async () => {
    const { companyId, otherRunId } = await seedArtifacts();
    await db.insert(documentMemberships).values({
      companyId,
      documentId: "20202020-2020-4020-8020-202020202020",
      userId: "user-1",
    });
    const app = express();
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId,
        runId: otherRunId,
        source: "agent_key",
      };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService()));
    app.use(errorHandler);

    const response = await request(app).get(`/api/companies/${companyId}/artifacts?starred=true`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ artifacts: [], nextCursor: null });
  });

  it("projects agent-created documents, direct attachments, and work products while excluding noisy sources", async () => {
    const { companyId } = await seedArtifacts();
    const storage = createStorageService({ "notes.txt": Buffer.from("Text file preview from an agent output.") });
    const result = await companyArtifactsService(db, storage).list(companyId, { limit: 20 });

    expect(result.nextCursor).toBeNull();
    expect(result.artifacts.map((artifact) => artifact.title)).toEqual([
      "Review Notes",
      "direct-video.mp4",
      "Primary Cut",
      "notes.txt",
    ]);
    expect(result.artifacts.map((artifact) => artifact.source)).toEqual([
      "document",
      "attachment",
      "work_product",
      "attachment",
    ]);
    expect(result.artifacts.find((artifact) => artifact.title === "notes.txt")?.previewText)
      .toBe("Text file preview from an agent output.");
    expect(result.artifacts.some((artifact) => artifact.title === "primary-cut.mp4")).toBe(false);
    expect(result.artifacts.some((artifact) => artifact.title === "Continuation Summary")).toBe(false);
    expect(result.artifacts.some((artifact) => artifact.title === "operator-screenshot.png")).toBe(false);
    expect(result.artifacts.some((artifact) => artifact.title === "comment-screenshot.png")).toBe(false);
    expect(result.artifacts.some((artifact) => artifact.issue.identifier === "OTH-1")).toBe(false);
  });

  it("hides artifacts of archived projects from every source and shows them again after unarchive", async () => {
    const { companyId, projectId } = await seedArtifacts();
    const service = companyArtifactsService(db, createStorageService({ "notes.txt": Buffer.from("preview") }));
    const visible = await service.list(companyId, { limit: 20 });
    expect(new Set(visible.artifacts.map((artifact) => artifact.source))).toEqual(new Set(["document", "attachment", "work_product"]));

    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId));
    // Artifacts whose issue has no project are not project-scoped and stay listed.
    const archived = await service.list(companyId, { limit: 20 });
    expect(archived.artifacts.length).toBeGreaterThan(0);
    expect(archived.artifacts.every((artifact) => artifact.project === null)).toBe(true);
    expect((await service.list(companyId, { limit: 20, projectId })).artifacts).toEqual([]);

    await db.update(projects).set({ archivedAt: null }).where(eq(projects.id, projectId));
    expect((await service.list(companyId, { limit: 20 })).artifacts.map((artifact) => artifact.id).sort())
      .toEqual(visible.artifacts.map((artifact) => artifact.id).sort());
  });

  it("supports project, kind, search, and cursor filters", async () => {
    const { companyId, projectId } = await seedArtifacts();
    const storage = createStorageService({ "notes.txt": Buffer.from("Searchable notes preview") });

    const projectVideos = await companyArtifactsService(db, storage).list(companyId, {
      projectId,
      kind: "video",
      limit: 10,
    });
    expect(projectVideos.artifacts.map((artifact) => artifact.title)).toEqual(["direct-video.mp4", "Primary Cut"]);

    const search = await companyArtifactsService(db, storage).list(companyId, {
      q: "review document",
      limit: 10,
    });
    expect(search.artifacts.map((artifact) => artifact.title)).toEqual(["Review Notes"]);

    const firstPage = await companyArtifactsService(db, storage).list(companyId, { limit: 2 });
    expect(firstPage.artifacts.map((artifact) => artifact.title)).toEqual(["Review Notes", "direct-video.mp4"]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await companyArtifactsService(db, storage).list(companyId, {
      limit: 10,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.artifacts.map((artifact) => artifact.title)).toEqual(["Primary Cut", "notes.txt"]);

    const pageAfterPrimaryWorkProduct = await companyArtifactsService(db, storage).list(companyId, { limit: 3 });
    expect(pageAfterPrimaryWorkProduct.artifacts.map((artifact) => artifact.title)).toEqual([
      "Review Notes",
      "direct-video.mp4",
      "Primary Cut",
    ]);

    const afterPrimaryCursor = await companyArtifactsService(db, storage).list(companyId, {
      limit: 10,
      cursor: pageAfterPrimaryWorkProduct.nextCursor ?? undefined,
    });
    expect(afterPrimaryCursor.artifacts.map((artifact) => artifact.title)).toEqual(["notes.txt"]);
  });

  it("lists only media files in mediaOnly mode and keeps pagination consistent", async () => {
    const { companyId, otherCompanyId, projectId, issueId } = await seedArtifacts();
    const agentId = "33333333-3333-4333-8333-333333333333";
    const extraAssets = [
      { id: "21212121-2121-4121-8121-212121212121", key: "voice.mp3", type: "audio/mpeg", name: "voice.mp3" },
      { id: "22222222-2222-4222-8222-222222222223", key: "brief.pdf", type: "application/pdf", name: "brief.pdf" },
      { id: "23232323-2323-4232-8232-232323232323", key: "shot.bin", type: "application/octet-stream", name: "Shot.PNG" },
      { id: "24242424-2424-4242-8242-242424242424", key: "clip.bin", type: "", name: "clip.mov" },
      { id: "25252525-2525-4252-8252-252525252525", key: "worker-state.json", type: "application/json", name: "worker-state.png" },
      { id: "26262626-2626-4262-8262-262626262626", key: "state.bin", type: "application/octet-stream", name: "state.json" },
      { id: "27272727-2727-4272-8272-272727272727", key: "session.log", type: "application/octet-stream", name: "session.log" },
    ];
    await db.insert(assets).values(extraAssets.map((asset) => ({
      id: asset.id,
      companyId,
      provider: "local_disk",
      objectKey: asset.key,
      contentType: asset.type,
      byteSize: 10,
      sha256: `sha256-${asset.key}`,
      originalFilename: asset.name,
      createdByAgentId: agentId,
    })));
    await db.insert(issueAttachments).values(extraAssets.map((asset, index) => ({
      companyId,
      issueId,
      assetId: asset.id,
      updatedAt: new Date(`2026-02-0${index + 1}T00:00:00.000Z`),
    })));
    await db.insert(issueWorkProducts).values({
      id: "28282828-2828-4282-8282-282828282828",
      companyId,
      projectId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Worker state snapshot",
      status: "ready_for_review",
      summary: "internal state",
      metadata: { openPath: "/state" },
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    });

    const service = companyArtifactsService(db, createStorageService());
    const all = await service.list(companyId, { mediaOnly: true, limit: 50 });
    expect(all.artifacts.map((artifact) => artifact.title).sort()).toEqual([
      "Primary Cut",
      "Shot.PNG",
      "brief.pdf",
      "clip.mov",
      "direct-video.mp4",
      "voice.mp3",
    ]);
    expect(all.artifacts.every((artifact) => artifact.source !== "document")).toBe(true);
    expect(all.artifacts.find((artifact) => artifact.title === "Shot.PNG")?.mediaKind).toBe("image");
    expect(all.artifacts.find((artifact) => artifact.title === "clip.mov")?.mediaKind).toBe("video");
    expect(all.artifacts.find((artifact) => artifact.title === "voice.mp3")?.mediaKind).toBe("file");

    const images = await service.list(companyId, { mediaOnly: true, kind: "image", limit: 50 });
    expect(images.artifacts.map((artifact) => artifact.title)).toEqual(["Shot.PNG"]);
    const videos = await service.list(companyId, { mediaOnly: true, kind: "video", limit: 50 });
    expect(videos.artifacts.map((artifact) => artifact.title).sort()).toEqual(["Primary Cut", "clip.mov", "direct-video.mp4"]);
    const audioAndPdf = await service.list(companyId, { mediaOnly: true, kind: "file", limit: 50 });
    expect(audioAndPdf.artifacts.map((artifact) => artifact.title).sort()).toEqual(["brief.pdf", "voice.mp3"]);
    expect((await service.list(companyId, { mediaOnly: true, kind: "text", limit: 50 })).artifacts).toEqual([]);
    expect((await service.list(companyId, { mediaOnly: true, kind: "document", limit: 50 })).artifacts).toEqual([]);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await service.list(companyId, { mediaOnly: true, limit: 2, cursor });
      seen.push(...result.artifacts.map((artifact) => artifact.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect(seen).toEqual(all.artifacts.map((artifact) => artifact.id));

    const grouped = await service.list(companyId, { mediaOnly: true, groupBy: "task", limit: 10 });
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups?.[0]?.count).toBe(6);
    expect(grouped.groups?.[0]?.mediaKinds.sort()).toEqual(["file", "image", "video"]);
    expect(grouped.groups?.[0]?.href).toContain("mediaOnly=true");

    // The default listing still shows documents, text and state-like entries.
    const unfiltered = await service.list(companyId, { limit: 100 });
    expect(unfiltered.artifacts.map((artifact) => artifact.title)).toEqual(
      expect.arrayContaining(["Review Notes", "notes.txt", "Worker state snapshot", "state.json", "worker-state.png"]),
    );

    // Company with only a document yields an empty media view.
    const other = await service.list(otherCompanyId, { mediaOnly: true, limit: 10 });
    expect(other).toEqual({ artifacts: [], nextCursor: null });
  });

  it("filters every artifact source by the agent it is attributed to", async () => {
    const { companyId } = await seedArtifacts();
    const writerId = "21212121-2121-4121-8121-212121212121";
    await db.insert(agents).values({ id: writerId, companyId, name: "Writer", role: "engineer" });
    await db.update(documents).set({ createdByAgentId: writerId })
      .where(eq(documents.id, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
    const storage = createStorageService({ "notes.txt": Buffer.from("notes") });

    const writer = await companyArtifactsService(db, storage).list(companyId, { agentId: writerId, limit: 20 });
    expect(writer.artifacts.map((artifact) => artifact.title)).toEqual(["Review Notes"]);

    const original = await companyArtifactsService(db, storage).list(companyId, {
      agentId: "33333333-3333-4333-8333-333333333333",
      limit: 20,
    });
    expect(original.artifacts.map((artifact) => artifact.title)).toEqual(["direct-video.mp4", "Primary Cut", "notes.txt"]);
    expect(new Set(original.artifacts.map((artifact) => artifact.createdByAgent?.id)))
      .toEqual(new Set(["33333333-3333-4333-8333-333333333333"]));

    const foreign = await companyArtifactsService(db, storage).list(companyId, {
      agentId: "44444444-4444-4444-8444-444444444444",
      limit: 20,
    });
    expect(foreign.artifacts).toEqual([]);
  });

  it("deduplicates work product attachments beyond the work product fetch window", async () => {
    const { companyId, projectId, issueId } = await seedArtifacts();
    const dedupedAttachmentId = "abababab-abab-4bab-8bab-abababababab";

    await db.insert(assets).values({
      id: "acacacac-acac-4cac-8cac-acacacacacac",
      companyId,
      provider: "local_disk",
      objectKey: "late-render.mp4",
      contentType: "video/mp4",
      byteSize: 500,
      sha256: "sha256-late-render",
      originalFilename: "late-render.mp4",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
    });
    await db.insert(issueAttachments).values({
      id: dedupedAttachmentId,
      companyId,
      issueId,
      assetId: "acacacac-acac-4cac-8cac-acacacacacac",
      updatedAt: new Date("2026-01-20T00:00:00.000Z"),
    });

    const fillerWorkProducts = Array.from({ length: 21 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      companyId,
      projectId,
      issueId,
      type: "artifact" as const,
      provider: "paperclip",
      title: `Filler Video ${index + 1}`,
      status: "ready_for_review" as const,
      summary: "Filler artifact to push the attachment-backed work product past the fetch window",
      metadata: { contentType: "video/mp4" },
      createdByRunId: "99999999-9999-4999-8999-999999999999",
      updatedAt: new Date(`2026-01-10T00:${String(index).padStart(2, "0")}:00.000Z`),
    }));
    await db.insert(issueWorkProducts).values([
      ...fillerWorkProducts,
      {
        id: "adadadad-adad-4dad-8dad-adadadadadad",
        companyId,
        projectId,
        issueId,
        type: "artifact",
        provider: "paperclip",
        title: "Late Render",
        status: "ready_for_review",
        summary: "Attachment-backed work product outside the limited fetch window",
        metadata: {
          attachmentId: dedupedAttachmentId,
          contentType: "video/mp4",
          byteSize: 500,
          contentPath: `/api/attachments/${dedupedAttachmentId}/content`,
          openPath: `/api/attachments/${dedupedAttachmentId}/content`,
          downloadPath: `/api/attachments/${dedupedAttachmentId}/content?download=1`,
          originalFilename: "late-render.mp4",
        },
        createdByRunId: "99999999-9999-4999-8999-999999999999",
        updatedAt: new Date("2026-01-01T12:00:00.000Z"),
      },
    ]);

    const result = await companyArtifactsService(db, createStorageService()).list(companyId, {
      kind: "video",
      limit: 20,
    });

    expect(result.artifacts.some((artifact) => artifact.title === "late-render.mp4")).toBe(false);
  });

  it("does not project a foreign agent from a malformed work product run reference", async () => {
    const { companyId, issueId, otherRunId } = await seedArtifacts();

    await db.insert(issueWorkProducts).values({
      id: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a",
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Forged Run Artifact",
      status: "ready_for_review",
      summary: "Historically malformed run attribution",
      metadata: { contentType: "text/plain" },
      createdByRunId: otherRunId,
      updatedAt: new Date("2026-01-10T00:00:00.000Z"),
    });

    const result = await companyArtifactsService(db, createStorageService()).list(companyId, { limit: 20 });
    const forged = result.artifacts.find((artifact) => artifact.title === "Forged Run Artifact");

    expect(forged).toBeTruthy();
    expect(forged?.createdByAgent).toBeNull();
    expect(result.artifacts.some((artifact) => artifact.createdByAgent?.name === "Other")).toBe(false);
  });

  it("does not leak foreign issue or project metadata through malformed artifact link rows", async () => {
    const { companyId, otherCompanyId, otherIssueId } = await seedArtifacts();
    const foreignProjectId = "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b";
    const malformedAttachmentId = "1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c";

    await db.insert(projects).values({
      id: foreignProjectId,
      companyId: otherCompanyId,
      name: "Foreign Project",
      status: "in_progress",
    });
    await db.update(issues).set({ projectId: foreignProjectId }).where(eq(issues.id, otherIssueId));
    await db.insert(documents).values({
      id: "1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d",
      companyId,
      title: "Forged Link Document",
      latestBody: "This row is company-owned but points at a foreign issue.",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      updatedAt: new Date("2026-01-30T00:00:00.000Z"),
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId: otherIssueId,
      documentId: "1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d",
      key: "forged-link-document",
    });
    await db.insert(assets).values({
      id: "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e",
      companyId,
      provider: "local_disk",
      objectKey: "forged-link.txt",
      contentType: "text/plain",
      byteSize: 42,
      sha256: "sha256-forged-link",
      originalFilename: "forged-link.txt",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
    });
    await db.insert(issueAttachments).values({
      id: malformedAttachmentId,
      companyId,
      issueId: otherIssueId,
      assetId: "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e",
      updatedAt: new Date("2026-01-29T00:00:00.000Z"),
    });
    await db.insert(issueWorkProducts).values({
      id: "1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f",
      companyId,
      issueId: otherIssueId,
      type: "artifact",
      provider: "paperclip",
      title: "Forged Link Work Product",
      status: "ready_for_review",
      summary: "This row is company-owned but points at a foreign issue.",
      metadata: { contentType: "text/plain" },
      createdByRunId: "99999999-9999-4999-8999-999999999999",
      updatedAt: new Date("2026-01-28T00:00:00.000Z"),
    });

    const flat = await companyArtifactsService(db, createStorageService()).list(companyId, { limit: 20 });
    expect(flat.artifacts.map((artifact) => artifact.title)).not.toEqual(expect.arrayContaining([
      "Forged Link Document",
      "forged-link.txt",
      "Forged Link Work Product",
    ]));
    expect(flat.artifacts.some((artifact) => artifact.issue.identifier === "OTH-1")).toBe(false);
    expect(flat.artifacts.some((artifact) => artifact.issue.title === "Other output")).toBe(false);
    expect(flat.artifacts.some((artifact) => artifact.project?.name === "Foreign Project")).toBe(false);

    const grouped = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      limit: 20,
    });
    expect(grouped.groups?.some((group) => group.issue?.identifier === "OTH-1")).toBe(false);
    expect(grouped.groups?.some((group) => group.issue?.title === "Other output")).toBe(false);
    expect(grouped.groups?.some((group) =>
      group.previewArtifacts.some((artifact) => artifact.project?.name === "Foreign Project")
    )).toBe(false);

    const selectedForeignGroup = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      groupIssueId: otherIssueId,
      limit: 20,
    });
    expect(selectedForeignGroup).toEqual({
      artifacts: [],
      selectedGroup: null,
      nextCursor: null,
    });
  });

  it("groups artifacts by task after applying media, project, and search filters", async () => {
    const { companyId, projectId, issueId } = await seedArtifacts();
    const storage = createStorageService({ "notes.txt": Buffer.from("Searchable notes preview") });

    const grouped = await companyArtifactsService(db, storage).list(companyId, {
      groupBy: "task",
      limit: 10,
    });
    expect(grouped.artifacts).toEqual([]);
    expect(grouped.nextCursor).toBeNull();
    expect(grouped.groups?.map((group) => ({
      issue: group.issue?.identifier,
      count: group.count,
      mediaKinds: group.mediaKinds,
      href: group.href,
    }))).toEqual([
      {
        issue: "PAP-2",
        count: 1,
        mediaKinds: ["document"],
        href: "/PAP/artifacts?groupBy=task&groupIssueId=77777777-7777-4777-8777-777777777777",
      },
      {
        issue: "PAP-1",
        count: 3,
        mediaKinds: ["video", "text"],
        href: "/PAP/artifacts?groupBy=task&groupIssueId=66666666-6666-4666-8666-666666666666",
      },
    ]);
    expect(grouped.groups?.find((group) => group.issue?.id === issueId)?.previewArtifacts.map((artifact) => artifact.title))
      .toEqual(["direct-video.mp4", "Primary Cut", "notes.txt"]);

    const projectVideos = await companyArtifactsService(db, storage).list(companyId, {
      groupBy: "task",
      projectId,
      kind: "video",
      limit: 10,
    });
    expect(projectVideos.groups?.map((group) => ({
      issue: group.issue?.identifier,
      count: group.count,
      href: group.href,
    }))).toEqual([
      {
        issue: "PAP-1",
        count: 2,
        href:
          "/PAP/artifacts?groupBy=task&groupIssueId=66666666-6666-4666-8666-666666666666&kind=video&projectId=55555555-5555-4555-8555-555555555555",
      },
    ]);

    const search = await companyArtifactsService(db, storage).list(companyId, {
      groupBy: "task",
      q: "review document",
      limit: 10,
    });
    expect(search.groups?.map((group) => ({ issue: group.issue?.identifier, count: group.count }))).toEqual([
      { issue: "PAP-2", count: 1 },
    ]);
  });

  it("paginates grouped task lists with the active group cursor", async () => {
    const { companyId } = await seedArtifacts();

    const firstPage = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      limit: 1,
    });
    expect(firstPage.groups?.map((group) => group.issue?.identifier)).toEqual(["PAP-2"]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      limit: 10,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.groups?.map((group) => group.issue?.identifier)).toEqual(["PAP-1"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("groups parent-task artifacts under the topmost same-company ancestor", async () => {
    const { companyId, issueId, secondIssueId } = await seedArtifacts();
    const grandchildIssueId = "21212121-2121-4212-8121-212121212121";
    const grandchildAttachmentId = "23232323-2323-4232-8232-232323232323";

    await db.update(issues).set({ parentId: issueId }).where(eq(issues.id, secondIssueId));
    await db.insert(issues).values({
      id: grandchildIssueId,
      companyId,
      parentId: secondIssueId,
      identifier: "PAP-3",
      title: "Grandchild render",
      status: "done",
      priority: "medium",
    });
    await db.insert(assets).values({
      id: "24242424-2424-4242-8242-242424242424",
      companyId,
      provider: "local_disk",
      objectKey: "grandchild.txt",
      contentType: "text/plain",
      byteSize: 48,
      sha256: "sha256-grandchild",
      originalFilename: "grandchild.txt",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
    });
    await db.insert(issueAttachments).values({
      id: grandchildAttachmentId,
      companyId,
      issueId: grandchildIssueId,
      assetId: "24242424-2424-4242-8242-242424242424",
      updatedAt: new Date("2026-01-05T00:00:00.000Z"),
    });

    const grouped = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "parent_task",
      limit: 10,
    });

    expect(grouped.artifacts).toEqual([]);
    expect(grouped.groups?.map((group) => ({
      issue: group.issue?.identifier,
      count: group.count,
      previewTitles: group.previewArtifacts.map((artifact) => artifact.title),
    }))).toEqual([
      {
        issue: "PAP-1",
        count: 5,
        previewTitles: ["grandchild.txt", "Review Notes", "direct-video.mp4"],
      },
    ]);
  });

  it("returns selected group artifact pages and metadata without leaking foreign group issues", async () => {
    const { companyId, issueId, otherIssueId } = await seedArtifacts();

    const selected = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      groupIssueId: issueId,
      limit: 2,
    });
    expect(selected.groups).toBeUndefined();
    expect(selected.selectedGroup).toMatchObject({
      id: `task:${issueId}`,
      groupBy: "task",
      issue: { identifier: "PAP-1" },
      count: 3,
    });
    expect(selected.artifacts.map((artifact) => artifact.title)).toEqual(["direct-video.mp4", "Primary Cut"]);
    expect(selected.nextCursor).toEqual(expect.any(String));

    const selectedSecondPage = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      groupIssueId: issueId,
      limit: 10,
      cursor: selected.nextCursor ?? undefined,
    });
    expect(selectedSecondPage.artifacts.map((artifact) => artifact.title)).toEqual(["notes.txt"]);

    const selectedEmptyByFilter = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      groupIssueId: issueId,
      q: "does-not-match-this-stack",
      limit: 10,
    });
    expect(selectedEmptyByFilter.selectedGroup).toMatchObject({
      id: `task:${issueId}`,
      count: 0,
    });
    expect(selectedEmptyByFilter.artifacts).toEqual([]);

    const foreignSelected = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      groupIssueId: otherIssueId,
      limit: 10,
    });
    expect(foreignSelected).toEqual({
      artifacts: [],
      selectedGroup: null,
      nextCursor: null,
    });
  });

  it("keeps a quiet project's folder and pages a busy folder completely beyond the grouping fetch window", async () => {
    const { companyId, projectId } = await seedArtifacts();
    const agentId = "33333333-3333-4333-8333-333333333333";
    const busyProjectId = "51515151-5151-4151-8151-515151515151";
    const busyIssueId = "52525252-5252-4252-8252-525252525252";
    await db.insert(projects).values({ id: busyProjectId, companyId, name: "Busy", status: "in_progress" });
    await db.insert(issues).values({ id: busyIssueId, companyId, projectId: busyProjectId, identifier: "PAP-9", title: "Many renders", status: "done", priority: "medium" });
    const busyCount = 1005;
    const hex = (index: number) => index.toString(16).padStart(12, "0");
    await db.insert(assets).values(Array.from({ length: busyCount }, (_, index) => ({
      id: `53535353-5353-4353-8353-${hex(index)}`,
      companyId,
      provider: "local_disk",
      objectKey: `busy-${index}.png`,
      contentType: "image/png",
      byteSize: 10,
      sha256: `sha256-busy-${index}`,
      originalFilename: `busy-${index}.png`,
      createdByAgentId: agentId,
    })));
    await db.insert(issueAttachments).values(Array.from({ length: busyCount }, (_, index) => ({
      companyId,
      issueId: busyIssueId,
      assetId: `53535353-5353-4353-8353-${hex(index)}`,
      updatedAt: new Date(Date.parse("2026-03-01T00:00:00.000Z") + index * 1000),
    })));

    const service = companyArtifactsService(db, createStorageService());
    const folders = await service.list(companyId, { mediaOnly: true, groupBy: "project", limit: 10 });
    // The older "Artifacts" project is outside the newest 1000 rows company-wide, yet keeps its folder.
    expect(folders.groups?.map((group) => group.title)).toEqual(["Busy", "Artifacts"]);
    expect(folders.groups?.find((group) => group.project?.id === projectId)?.count).toBe(2);

    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await service.list(companyId, { mediaOnly: true, groupBy: "project", groupProjectId: busyProjectId, limit: 100, cursor });
      result.artifacts.forEach((artifact) => seen.add(artifact.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen.size).toBe(busyCount);
  });

  it("groups media into one folder per project, admits Office files and pages a selected folder", async () => {
    const { companyId, otherCompanyId, projectId, secondIssueId } = await seedArtifacts();
    const agentId = "33333333-3333-4333-8333-333333333333";
    const slidesProjectId = "31313131-3131-4131-8131-313131313131";
    const archivedProjectId = "32323232-3232-4232-8232-323232323232";
    const foreignProjectId = "34343434-3434-4343-8343-343434343434";
    const slidesIssueId = "35353535-3535-4353-8353-353535353535";
    const archivedIssueId = "36363636-3636-4363-8363-363636363636";
    await db.insert(projects).values([
      { id: slidesProjectId, companyId, name: "Slides", status: "in_progress" },
      { id: archivedProjectId, companyId, name: "Old", status: "in_progress", archivedAt: new Date("2026-01-01T00:00:00.000Z") },
      { id: foreignProjectId, companyId: otherCompanyId, name: "Foreign", status: "in_progress" },
    ]);
    await db.insert(issues).values([
      { id: slidesIssueId, companyId, projectId: slidesProjectId, identifier: "PAP-4", title: "Board deck", status: "done", priority: "medium" },
      { id: archivedIssueId, companyId, projectId: archivedProjectId, identifier: "PAP-5", title: "Old render", status: "done", priority: "medium" },
    ]);
    const files = [
      { id: "41414141-4141-4141-8141-414141414141", issueId: slidesIssueId, name: "deck.pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", day: "10" },
      { id: "42424242-4242-4242-8242-424242424242", issueId: slidesIssueId, name: "report.docx", type: "application/octet-stream", day: "11" },
      { id: "43434343-4343-4343-8343-434343434343", issueId: slidesIssueId, name: "budget.xlsx", type: "application/vnd.ms-excel.sheet.macroenabled.12", day: "12" },
      // Not media, whatever the file is called.
      { id: "44444444-4444-4444-8444-444444444445", issueId: slidesIssueId, name: "fake.pptx", type: "application/json", day: "13" },
      { id: "45454545-4545-4545-8545-454545454545", issueId: slidesIssueId, name: "plan.md", type: "text/markdown", day: "14" },
      { id: "46464646-4646-4464-8464-464646464646", issueId: slidesIssueId, name: "bundle.zip", type: "application/zip", day: "15" },
      { id: "47474747-4747-4474-8474-474747474747", issueId: secondIssueId, name: "brief.pdf", type: "application/pdf", day: "16" },
      { id: "49494949-4949-4494-8494-494949494949", issueId: secondIssueId, name: "cover.png", type: "image/png", day: "09" },
      { id: "48484848-4848-4484-8484-484848484848", issueId: archivedIssueId, name: "old.png", type: "image/png", day: "17" },
    ];
    await db.insert(assets).values(files.map((file) => ({
      id: file.id,
      companyId,
      provider: "local_disk",
      objectKey: file.name,
      contentType: file.type,
      byteSize: 10,
      sha256: `sha256-${file.name}`,
      originalFilename: file.name,
      createdByAgentId: agentId,
    })));
    await db.insert(issueAttachments).values(files.map((file) => ({
      companyId,
      issueId: file.issueId,
      assetId: file.id,
      updatedAt: new Date(`2026-02-${file.day}T00:00:00.000Z`),
    })));

    const service = companyArtifactsService(db, createStorageService());
    const officeFiles = await service.list(companyId, { mediaOnly: true, kind: "file", limit: 50 });
    expect(officeFiles.artifacts.map((artifact) => artifact.title).sort()).toEqual(["brief.pdf", "budget.xlsx", "deck.pptx", "report.docx"]);

    const folders = await service.list(companyId, { mediaOnly: true, groupBy: "project", limit: 10 });
    expect(folders.artifacts).toEqual([]);
    expect(folders.nextCursor).toBeNull();
    expect(folders.groups?.map((group) => ({
      id: group.id,
      issue: group.issue,
      project: group.project,
      title: group.title,
      count: group.count,
      href: group.href,
    }))).toEqual([
      {
        id: "project:none",
        issue: null,
        project: null,
        title: "No project",
        count: 2,
        href: "/PAP/artifacts?groupBy=project&groupProjectId=none&mediaOnly=true",
      },
      {
        id: `project:${slidesProjectId}`,
        issue: null,
        project: { id: slidesProjectId, name: "Slides" },
        title: "Slides",
        count: 3,
        href: `/PAP/artifacts?groupBy=project&groupProjectId=${slidesProjectId}&mediaOnly=true`,
      },
      {
        id: `project:${projectId}`,
        issue: null,
        project: { id: projectId, name: "Artifacts" },
        title: "Artifacts",
        count: 2,
        href: `/PAP/artifacts?groupBy=project&groupProjectId=${projectId}&mediaOnly=true`,
      },
    ]);
    expect(folders.groups?.[1]?.previewArtifacts.map((artifact) => artifact.title)).toEqual(["budget.xlsx", "report.docx", "deck.pptx"]);
    // A folder's cover is its newest picture, even when a newer PDF exists.
    expect(folders.groups?.[0]?.previewArtifacts.map((artifact) => artifact.title)).toEqual(["cover.png", "brief.pdf"]);

    const firstPage = await service.list(companyId, { mediaOnly: true, groupBy: "project", limit: 1 });
    expect(firstPage.groups?.map((group) => group.id)).toEqual(["project:none"]);
    const restPage = await service.list(companyId, { mediaOnly: true, groupBy: "project", limit: 10, cursor: firstPage.nextCursor ?? undefined });
    expect(restPage.groups?.map((group) => group.title)).toEqual(["Slides", "Artifacts"]);

    const selected = await service.list(companyId, { mediaOnly: true, groupBy: "project", groupProjectId: slidesProjectId, limit: 2 });
    expect(selected.groups).toBeUndefined();
    expect(selected.selectedGroup).toMatchObject({ id: `project:${slidesProjectId}`, title: "Slides", count: 3, issue: null });
    expect(selected.artifacts.map((artifact) => artifact.title)).toEqual(["budget.xlsx", "report.docx"]);
    const selectedNext = await service.list(companyId, {
      mediaOnly: true,
      groupBy: "project",
      groupProjectId: slidesProjectId,
      limit: 2,
      cursor: selected.nextCursor ?? undefined,
    });
    expect(selectedNext.artifacts.map((artifact) => artifact.title)).toEqual(["deck.pptx"]);
    expect(selectedNext.nextCursor).toBeNull();

    const noProject = await service.list(companyId, { mediaOnly: true, groupBy: "project", groupProjectId: "none", limit: 10 });
    expect(noProject.selectedGroup).toMatchObject({ id: "project:none", project: null, title: "No project", count: 2 });
    expect(noProject.artifacts.map((artifact) => artifact.title)).toEqual(["brief.pdf", "cover.png"]);

    const emptyByFilter = await service.list(companyId, { mediaOnly: true, groupBy: "project", groupProjectId: slidesProjectId, kind: "video", limit: 10 });
    expect(emptyByFilter.selectedGroup).toMatchObject({ project: { id: slidesProjectId, name: "Slides" }, count: 0 });
    expect(emptyByFilter.artifacts).toEqual([]);

    for (const hiddenProjectId of [archivedProjectId, foreignProjectId]) {
      expect(await service.list(companyId, { mediaOnly: true, groupBy: "project", groupProjectId: hiddenProjectId, limit: 10 }))
        .toEqual({ artifacts: [], selectedGroup: null, nextCursor: null });
    }

    const upperCase = await service.list(companyId, { mediaOnly: true, groupBy: "project", groupProjectId: slidesProjectId.toUpperCase(), limit: 10 });
    expect(upperCase.selectedGroup).toMatchObject({ project: { id: slidesProjectId }, count: 3 });

    // Without mediaOnly the folders still carry task documents (opt-in filter).
    const allSources = await service.list(companyId, { groupBy: "project", groupProjectId: "none", limit: 50 });
    expect(allSources.artifacts.map((artifact) => artifact.title)).toEqual(expect.arrayContaining(["Review Notes", "brief.pdf"]));
  });

  it("files an agent chat's media under the one active project its agent leads", async () => {
    const { companyId, projectId } = await seedArtifacts();
    const leadAgentId = "37373737-3737-4373-8373-373737373737";
    const twoProjectAgentId = "38383838-3838-4383-8383-383838383838";
    const archivedLeadAgentId = "39393939-3939-4393-8393-393939393939";
    await db.insert(agents).values([
      { id: leadAgentId, companyId, name: "Comfy", role: "engineer" },
      { id: twoProjectAgentId, companyId, name: "Both", role: "engineer" },
      { id: archivedLeadAgentId, companyId, name: "Retired", role: "engineer" },
    ]);
    const leadProjectId = "3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a";
    await db.insert(projects).values([
      { id: leadProjectId, companyId, name: "Comfy", status: "in_progress", leadAgentId },
      { id: "3b3b3b3b-3b3b-43b3-83b3-3b3b3b3b3b3b", companyId, name: "Left", status: "in_progress", leadAgentId: twoProjectAgentId },
      { id: "3c3c3c3c-3c3c-43c3-83c3-3c3c3c3c3c3c", companyId, name: "Right", status: "in_progress", leadAgentId: twoProjectAgentId },
      { id: "3d3d3d3d-3d3d-43d3-83d3-3d3d3d3d3d3d", companyId, name: "Gone", status: "in_progress", leadAgentId: archivedLeadAgentId, archivedAt: new Date("2026-01-01T00:00:00.000Z") },
    ]);
    const chat = (id: string, agentId: string, identifier: string, extra: Partial<typeof issues.$inferInsert> = {}) => ({
      id, companyId, identifier, title: `Chat ${identifier}`, status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: "owner", conversationState: "active" as const, ...extra,
    });
    const leadChatId = "3e3e3e3e-3e3e-43e3-83e3-3e3e3e3e3e3e";
    const twoProjectChatId = "3f3f3f3f-3f3f-43f3-83f3-3f3f3f3f3f3f";
    const archivedChatId = "40404040-4040-4404-8404-404040404040";
    const pinnedChatId = "50505050-5050-4505-8505-505050505050";
    await db.insert(issues).values([
      chat(leadChatId, leadAgentId, "PAP-6"),
      chat(twoProjectChatId, twoProjectAgentId, "PAP-7"),
      chat(archivedChatId, archivedLeadAgentId, "PAP-8"),
      // An explicit project still wins over the lead fallback.
      chat(pinnedChatId, leadAgentId, "PAP-9", { projectId, conversationUserId: "someone-else" }),
    ]);
    const files = [
      { id: "51515151-5151-4515-8515-515151515151", issueId: leadChatId, name: "render.png" },
      { id: "52525252-5252-4525-8525-525252525252", issueId: twoProjectChatId, name: "both.png" },
      { id: "53535353-5353-4535-8535-535353535353", issueId: archivedChatId, name: "retired.png" },
      { id: "54545454-5454-4545-8545-545454545454", issueId: pinnedChatId, name: "pinned.png" },
    ];
    await db.insert(assets).values(files.map((file) => ({
      id: file.id, companyId, provider: "local_disk", objectKey: file.name, contentType: "image/png",
      byteSize: 10, sha256: `sha256-${file.name}`, originalFilename: file.name, createdByAgentId: leadAgentId,
    })));
    await db.insert(issueAttachments).values(files.map((file) => ({ companyId, issueId: file.issueId, assetId: file.id })));

    const service = companyArtifactsService(db, createStorageService());
    const titlesIn = async (groupProjectId: string) =>
      (await service.list(companyId, { mediaOnly: true, groupBy: "project", groupProjectId, limit: 50 })).artifacts.map((a) => a.title).sort();

    expect(await titlesIn(leadProjectId)).toEqual(["render.png"]);
    expect(await titlesIn(projectId)).toEqual(expect.arrayContaining(["pinned.png"]));
    expect(await titlesIn(projectId)).not.toContain("render.png");
    const noProject = await titlesIn("none");
    expect(noProject).toEqual(expect.arrayContaining(["both.png", "retired.png"]));
    expect(noProject).not.toContain("render.png");

    const folders = await service.list(companyId, { mediaOnly: true, groupBy: "project", limit: 10 });
    expect(folders.groups?.find((group) => group.project?.id === leadProjectId)).toMatchObject({ title: "Comfy", count: 1 });

    const listed = await service.list(companyId, { mediaOnly: true, limit: 50 });
    expect(listed.artifacts.find((a) => a.title === "render.png")?.project).toEqual({ id: leadProjectId, name: "Comfy" });
    // The project page (projectId filter) lists the chat's media too.
    const projectPage = await service.list(companyId, { mediaOnly: true, projectId: leadProjectId, limit: 50 });
    expect(projectPage.artifacts.map((a) => a.title)).toEqual(["render.png"]);
  });
});

describe("company artifacts route authorization", () => {
  it("rejects agent access across company boundaries before reading artifacts", async () => {
    const app = express();
    app.use((_req, _res, next) => {
      (_req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-allowed",
      };
      next();
    });
    app.use("/api/companies", companyRoutes({} as any, createStorageService()));
    app.use(errorHandler);

    const res = await request(app).get("/api/companies/company-denied/artifacts");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
  });
});
