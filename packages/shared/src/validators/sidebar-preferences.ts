import { z } from "zod";

const sidebarOrderedIdSchema = z.string().guid();

export const sidebarOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarOrderedIdSchema),
  updatedAt: z.coerce.date().nullable(),
});

export const upsertSidebarOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarOrderedIdSchema),
});

export type UpsertSidebarOrderPreference = z.infer<typeof upsertSidebarOrderPreferenceSchema>;

export const companySidebarPreferenceSchema = sidebarOrderPreferenceSchema.extend({
  excludedPmStatusAgentIds: z.array(sidebarOrderedIdSchema),
});

// Company-scoped sidebar preference write. Each field is optional so the
// original `{ orderedIds }` payload (project drag-reorder, company import)
// keeps working and leaves the exclusion list untouched, and an exclusion-only
// write leaves the project order untouched. At least one field is required.
export const upsertCompanySidebarPreferenceSchema = z
  .object({
    orderedIds: z.array(sidebarOrderedIdSchema).optional(),
    excludedPmStatusAgentIds: z.array(sidebarOrderedIdSchema).optional(),
  })
  .refine(
    (value) => value.orderedIds !== undefined || value.excludedPmStatusAgentIds !== undefined,
    { message: "orderedIds or excludedPmStatusAgentIds is required" },
  );

export type UpsertCompanySidebarPreference = z.infer<typeof upsertCompanySidebarPreferenceSchema>;
