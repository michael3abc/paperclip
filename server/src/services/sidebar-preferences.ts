import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyUserSidebarPreferences,
  userSidebarPreferences,
} from "@paperclipai/db";
import type { CompanySidebarPreference, SidebarOrderPreference } from "@paperclipai/shared";

function normalizeOrderedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    orderedIds.push(trimmed);
  }
  return orderedIds;
}

function toPreference(orderedIds: unknown, updatedAt: Date | null): SidebarOrderPreference {
  return {
    orderedIds: normalizeOrderedIds(orderedIds),
    updatedAt,
  };
}

function toCompanyPreference(
  row: { projectOrder: unknown; excludedPmStatusAgentIds: unknown; updatedAt: Date } | null | undefined,
): CompanySidebarPreference {
  return {
    orderedIds: normalizeOrderedIds(row?.projectOrder ?? []),
    excludedPmStatusAgentIds: normalizeOrderedIds(row?.excludedPmStatusAgentIds ?? []),
    updatedAt: row?.updatedAt ?? null,
  };
}

export interface CompanySidebarPreferencePatch {
  orderedIds?: string[];
  excludedPmStatusAgentIds?: string[];
}

export function sidebarPreferenceService(db: Db) {
  return {
    async getCompanyOrder(userId: string): Promise<SidebarOrderPreference> {
      const row = await db.query.userSidebarPreferences.findFirst({
        where: eq(userSidebarPreferences.userId, userId),
      });
      return toPreference(row?.companyOrder ?? [], row?.updatedAt ?? null);
    },

    async upsertCompanyOrder(userId: string, orderedIds: string[]): Promise<SidebarOrderPreference> {
      const now = new Date();
      const normalized = normalizeOrderedIds(orderedIds);
      const [row] = await db
        .insert(userSidebarPreferences)
        .values({
          userId,
          companyOrder: normalized,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userSidebarPreferences.userId],
          set: {
            companyOrder: normalized,
            updatedAt: now,
          },
        })
        .returning();
      return toPreference(row?.companyOrder ?? normalized, row?.updatedAt ?? now);
    },

    async getProjectOrder(companyId: string, userId: string): Promise<CompanySidebarPreference> {
      const row = await db.query.companyUserSidebarPreferences.findFirst({
        where: and(
          eq(companyUserSidebarPreferences.companyId, companyId),
          eq(companyUserSidebarPreferences.userId, userId),
        ),
      });
      return toCompanyPreference(row);
    },

    // Writes only the fields present in the patch. A legacy `{ orderedIds }`
    // write (project drag-reorder, company import) therefore never clears the
    // PM-status exclusion list, and an exclusion-only write keeps the order.
    async upsertCompanyPreference(
      companyId: string,
      userId: string,
      patch: CompanySidebarPreferencePatch,
    ): Promise<CompanySidebarPreference> {
      const now = new Date();
      const orderedIds = patch.orderedIds === undefined ? undefined : normalizeOrderedIds(patch.orderedIds);
      const excludedPmStatusAgentIds =
        patch.excludedPmStatusAgentIds === undefined
          ? undefined
          : normalizeOrderedIds(patch.excludedPmStatusAgentIds);
      const [row] = await db
        .insert(companyUserSidebarPreferences)
        .values({
          companyId,
          userId,
          projectOrder: orderedIds ?? [],
          excludedPmStatusAgentIds: excludedPmStatusAgentIds ?? [],
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [companyUserSidebarPreferences.companyId, companyUserSidebarPreferences.userId],
          set: {
            ...(orderedIds === undefined ? {} : { projectOrder: orderedIds }),
            ...(excludedPmStatusAgentIds === undefined ? {} : { excludedPmStatusAgentIds }),
            updatedAt: now,
          },
        })
        .returning();
      return toCompanyPreference(
        row ?? {
          projectOrder: orderedIds ?? [],
          excludedPmStatusAgentIds: excludedPmStatusAgentIds ?? [],
          updatedAt: now,
        },
      );
    },
  };
}
