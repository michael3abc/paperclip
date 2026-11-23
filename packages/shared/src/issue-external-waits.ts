import { z } from "zod";

export const registerIssueExternalWaitSchema = z.object({
  service: z.literal("long-running-harness"),
  externalRef: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();
export const completeIssueExternalWaitSchema = registerIssueExternalWaitSchema.extend({
  outcome: z.string().min(1).max(128).optional(),
  commentId: z.string().uuid().optional(),
});
export type RegisterIssueExternalWait = z.infer<typeof registerIssueExternalWaitSchema>;
export type CompleteIssueExternalWait = z.infer<typeof completeIssueExternalWaitSchema>;
export interface IssueExternalWait {
  id: string;
  companyId: string;
  issueId: string;
  agentId: string | null;
  service: "long-running-harness";
  externalRef: string;
  status: "waiting" | "completed" | "cancelled";
  outcome: string | null;
  completionCommentId: string | null;
  registeredByRunId: string | null;
  completedByRunId: string | null;
  wakeRequestId: string | null;
  registeredAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
