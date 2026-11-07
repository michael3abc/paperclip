import { and, eq } from "drizzle-orm";
import { assets, documents, issueAttachments, issueDocuments, type Db } from "@paperclipai/db";
import type { RequestConfirmationTarget } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export async function getIssueDocumentTargetSnapshot(
  db: Db | any,
  args: {
    companyId: string;
    issueId: string;
    target: RequestConfirmationTarget;
    // When true, take a FOR UPDATE row lock on the joined document so a concurrent
    // revision publish (which updates documents.latestRevisionId) must serialize
    // behind the caller's transaction. Only meaningful inside a transaction.
    lockForUpdate?: boolean;
  },
) {
  if (args.target.type !== "issue_document") return null;
  const targetIssueId = args.target.issueId ?? args.issueId;
  const query = db
    .select({
      issueId: issueDocuments.issueId,
      documentId: issueDocuments.documentId,
      key: issueDocuments.key,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(
      and(
        eq(issueDocuments.companyId, args.companyId),
        eq(issueDocuments.issueId, targetIssueId),
        eq(issueDocuments.key, args.target.key),
      ),
    );
  const row = await (
    args.lockForUpdate ? query.for("update", { of: documents }) : query
  ).then(
    (
      rows: Array<{
        issueId: string;
        documentId: string;
        key: string;
        latestRevisionId: string | null;
        latestRevisionNumber: number;
      }>,
    ) => rows[0] ?? null,
  );

  if (!row) return null;
  if (args.target.documentId && args.target.documentId !== row.documentId)
    return null;
  return row;
}

export async function getIssueAttachmentTargetSnapshot(db: Db | any, args: {
  companyId: string; issueId: string; target: RequestConfirmationTarget; lockForUpdate?: boolean;
}) {
  if (args.target.type !== "issue_attachment") return null;
  // Approval is scoped to the containing task; an arbitrary private task's
  // attachment cannot be made visible through a confirmation elsewhere.
  if (args.target.issueId && args.target.issueId !== args.issueId) return null;
  const query = db.select({ attachmentId: issueAttachments.id, assetId: assets.id, sha256: assets.sha256 })
    .from(issueAttachments).innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, args.companyId)))
    .where(and(eq(issueAttachments.companyId, args.companyId), eq(issueAttachments.issueId, args.issueId),
      eq(issueAttachments.id, args.target.attachmentId), eq(assets.id, args.target.assetId), eq(assets.sha256, args.target.sha256)));
  const rows = await (args.lockForUpdate ? query.for("update", { of: [issueAttachments, assets] }) : query);
  return rows[0] ?? null;
}

export async function assertRequestConfirmationTargetIsCurrent(
  db: Db | any,
  args: {
    companyId: string;
    issueId: string;
    target?: RequestConfirmationTarget | null;
    // Forwarded to getIssueDocumentTargetSnapshot; pass true when validating
    // inside the create transaction so the revision read locks the document row
    // and stays atomic with the interaction insert.
    lockForUpdate?: boolean;
  },
) {
  if (!args.target) return;
  if (args.target.type === "issue_attachment") {
    if (!await getIssueAttachmentTargetSnapshot(db, { ...args, target: args.target })) {
      throw unprocessable("request_confirmation target must reference the exact attachment bytes on this task");
    }
    return;
  }
  if (args.target.type !== "issue_document") return;
  const snapshot = await getIssueDocumentTargetSnapshot(db, {
    companyId: args.companyId,
    issueId: args.issueId,
    target: args.target,
    lockForUpdate: args.lockForUpdate,
  });
  if (!snapshot || snapshot.latestRevisionId !== args.target.revisionId) {
    throw unprocessable(
      "request_confirmation target must reference the current issue document revision",
    );
  }
  if (
    args.target.revisionNumber &&
    snapshot.latestRevisionNumber !== args.target.revisionNumber
  ) {
    throw unprocessable(
      "request_confirmation target revisionNumber must match the current issue document revision",
    );
  }
}

