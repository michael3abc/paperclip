import { z } from "zod";

export const COMPANY_ARTIFACTS_DEFAULT_LIMIT = 30;
export const COMPANY_ARTIFACTS_MAX_LIMIT = 100;
export const COMPANY_ARTIFACTS_MAX_QUERY_LENGTH = 160;

export const companyArtifactSourceSchema = z.enum(["document", "attachment", "work_product"]);

export const companyArtifactMediaKindSchema = z.enum(["image", "video", "text", "document", "file", "empty"]);

export const companyArtifactGroupBySchema = z.enum(["none", "task", "parent_task", "project"]);

/** Selects a project folder when grouping by project; `none` is the folder of tasks without a project. */
export const COMPANY_ARTIFACTS_NO_PROJECT_GROUP_ID = "none";

export const companyArtifactsQuerySchema = z.object({
  kind: z.enum(["image", "video", "text", "document", "file", "all"]).optional().default("all"),
  projectId: z.string().guid().optional(),
  /** Only artifacts attributed to this agent (the `createdByAgent` on each result). */
  agentId: z.string().guid().optional(),
  q: z.string().trim().max(COMPANY_ARTIFACTS_MAX_QUERY_LENGTH).optional(),
  groupBy: companyArtifactGroupBySchema.optional().default("none"),
  groupIssueId: z.string().guid().optional(),
  /** With `groupBy=project`: a project id, or `none` for tasks without a project. */
  groupProjectId: z.union([z.string().guid(), z.literal(COMPANY_ARTIFACTS_NO_PROJECT_GROUP_ID)]).optional(),
  starred: z.preprocess(
    (value) => value === "true" ? true : value === "false" ? false : value,
    z.boolean(),
  ).optional().default(false),
  /** Only images, videos, audio, PDF and Office files; excludes documents, text and internal state files. */
  mediaOnly: z.preprocess(
    (value) => value === "true" ? true : value === "false" ? false : value,
    z.boolean(),
  ).optional().default(false),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(COMPANY_ARTIFACTS_MAX_LIMIT)
    .optional()
    .default(COMPANY_ARTIFACTS_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

export const companyArtifactSchema = z.object({
  id: z.string().min(1),
  source: companyArtifactSourceSchema,
  mediaKind: companyArtifactMediaKindSchema,
  title: z.string(),
  previewText: z.string().nullable(),
  contentType: z.string().nullable(),
  contentPath: z.string().nullable(),
  openPath: z.string().nullable(),
  downloadPath: z.string().nullable(),
  issue: z.object({
    id: z.string().guid(),
    identifier: z.string(),
    title: z.string(),
  }),
  project: z.object({
    id: z.string().guid(),
    name: z.string(),
  }).nullable(),
  createdByAgent: z.object({
    id: z.string().guid(),
    name: z.string(),
  }).nullable(),
  updatedAt: z.string().datetime(),
  href: z.string().min(1),
});

export const companyArtifactGroupSchema = z.object({
  id: z.string().min(1),
  groupBy: companyArtifactGroupBySchema.exclude(["none"]),
  /** The task (or root task) of a task group; null for a project group. */
  issue: z.object({
    id: z.string().guid(),
    identifier: z.string(),
    title: z.string(),
  }).nullable(),
  /** The project of a project group; null for the folder of tasks without a project. Absent on task groups. */
  project: z.object({
    id: z.string().guid(),
    name: z.string(),
  }).nullable().optional(),
  title: z.string(),
  count: z.number().int().min(0),
  mediaKinds: z.array(companyArtifactMediaKindSchema),
  previewArtifacts: z.array(companyArtifactSchema),
  updatedAt: z.string().datetime(),
  href: z.string().min(1),
});

export const companyArtifactsResponseSchema = z.object({
  artifacts: z.array(companyArtifactSchema),
  groups: z.array(companyArtifactGroupSchema).optional(),
  selectedGroup: companyArtifactGroupSchema.nullable().optional(),
  nextCursor: z.string().nullable(),
});

export type CompanyArtifactsQuery = z.infer<typeof companyArtifactsQuerySchema>;
