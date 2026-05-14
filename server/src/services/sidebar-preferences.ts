import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyUserSidebarPreferences,
  userSidebarPreferences,
} from "@paperclipai/db";
import type {
  PageSectionOrderPreference,
  SidebarOrderPreference,
} from "@paperclipai/shared";

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

function normalizePageSectionOrders(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key || typeof key !== "string") continue;
    out[key] = normalizeOrderedIds(raw);
  }
  return out;
}

function toPreference(orderedIds: unknown, updatedAt: Date | null): SidebarOrderPreference {
  return {
    orderedIds: normalizeOrderedIds(orderedIds),
    updatedAt,
  };
}

function toPageSectionPreference(
  pageKey: string,
  orderedIds: unknown,
  updatedAt: Date | null,
): PageSectionOrderPreference {
  return {
    pageKey,
    orderedIds: normalizeOrderedIds(orderedIds),
    updatedAt,
  };
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

    async getProjectOrder(companyId: string, userId: string): Promise<SidebarOrderPreference> {
      const row = await db.query.companyUserSidebarPreferences.findFirst({
        where: and(
          eq(companyUserSidebarPreferences.companyId, companyId),
          eq(companyUserSidebarPreferences.userId, userId),
        ),
      });
      return toPreference(row?.projectOrder ?? [], row?.updatedAt ?? null);
    },

    async upsertProjectOrder(
      companyId: string,
      userId: string,
      orderedIds: string[],
    ): Promise<SidebarOrderPreference> {
      const now = new Date();
      const normalized = normalizeOrderedIds(orderedIds);
      const [row] = await db
        .insert(companyUserSidebarPreferences)
        .values({
          companyId,
          userId,
          projectOrder: normalized,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [companyUserSidebarPreferences.companyId, companyUserSidebarPreferences.userId],
          set: {
            projectOrder: normalized,
            updatedAt: now,
          },
        })
        .returning();
      return toPreference(row?.projectOrder ?? normalized, row?.updatedAt ?? now);
    },

    async getPortfolioNavOrder(userId: string): Promise<SidebarOrderPreference> {
      const row = await db.query.userSidebarPreferences.findFirst({
        where: eq(userSidebarPreferences.userId, userId),
      });
      return toPreference(row?.portfolioNavOrder ?? [], row?.updatedAt ?? null);
    },

    async upsertPortfolioNavOrder(
      userId: string,
      orderedIds: string[],
    ): Promise<SidebarOrderPreference> {
      const now = new Date();
      const normalized = normalizeOrderedIds(orderedIds);
      const [row] = await db
        .insert(userSidebarPreferences)
        .values({
          userId,
          portfolioNavOrder: normalized,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userSidebarPreferences.userId],
          set: {
            portfolioNavOrder: normalized,
            updatedAt: now,
          },
        })
        .returning();
      return toPreference(row?.portfolioNavOrder ?? normalized, row?.updatedAt ?? now);
    },

    async getPageSectionOrder(
      userId: string,
      pageKey: string,
    ): Promise<PageSectionOrderPreference> {
      const row = await db.query.userSidebarPreferences.findFirst({
        where: eq(userSidebarPreferences.userId, userId),
      });
      const all = normalizePageSectionOrders(row?.pageSectionOrders ?? {});
      return toPageSectionPreference(pageKey, all[pageKey] ?? [], row?.updatedAt ?? null);
    },

    async upsertPageSectionOrder(
      userId: string,
      pageKey: string,
      orderedIds: string[],
    ): Promise<PageSectionOrderPreference> {
      const now = new Date();
      const normalized = normalizeOrderedIds(orderedIds);
      // Merge into the existing per-page map: read current, set the one key,
      // write back. Done in one statement via jsonb_set so we don't race with
      // concurrent updates to other pageKeys for the same user.
      const [row] = await db
        .insert(userSidebarPreferences)
        .values({
          userId,
          pageSectionOrders: { [pageKey]: normalized },
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userSidebarPreferences.userId],
          set: {
            pageSectionOrders: sql`jsonb_set(
              COALESCE(${userSidebarPreferences.pageSectionOrders}, '{}'::jsonb),
              ARRAY[${pageKey}]::text[],
              ${JSON.stringify(normalized)}::jsonb,
              true
            )`,
            updatedAt: now,
          },
        })
        .returning();
      const all = normalizePageSectionOrders(row?.pageSectionOrders ?? {});
      return toPageSectionPreference(
        pageKey,
        all[pageKey] ?? normalized,
        row?.updatedAt ?? now,
      );
    },
  };
}
