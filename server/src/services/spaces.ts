import { and, asc, eq, isNull, like, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documentRevisions, documents, spacePages, spaces } from "@paperclipai/db";
import {
  isUuidLike,
  type CreateSpace,
  type CreateSpacePage,
  type DocumentFormat,
  type Space,
  type SpaceListItem,
  type SpacePage,
  type SpacePageSummary,
  type SpacePageTreeNode,
  type UpdateSpace,
  type UpdateSpacePage,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

/**
 * One person's saves of a page this close together fold into one version.
 * Autosave saves a moment after typing stops, so without it an afternoon's
 * writing would leave hundreds of versions. The window runs from that
 * person's last save, so it holds for as long as they keep writing.
 */
export const SPACE_PAGE_FOLD_WINDOW_MS = 10 * 60 * 1000;

/** Who is making a change. Spaces are for people for now; agents come later. */
export interface SpaceActor {
  agentId: string | null;
  userId: string | null;
}

const URL_KEY_DELIM_RE = /[^a-z0-9]+/g;
const URL_KEY_TRIM_RE = /^-+|-+$/g;
const URL_KEY_MAX = 60;

/** The address key a Space name asks for: "Sales Handbook" gives "sales-handbook". */
export function spaceUrlKeyBase(name: string): string {
  const key = name
    .trim()
    .toLowerCase()
    .replace(URL_KEY_DELIM_RE, "-")
    .replace(URL_KEY_TRIM_RE, "")
    .slice(0, URL_KEY_MAX)
    .replace(URL_KEY_TRIM_RE, "");
  return key || "space";
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505";
}

const pageSummarySelect = {
  id: spacePages.id,
  companyId: spacePages.companyId,
  spaceId: spacePages.spaceId,
  parentPageId: spacePages.parentPageId,
  documentId: spacePages.documentId,
  sortOrder: spacePages.sortOrder,
  title: documents.title,
  latestRevisionId: documents.latestRevisionId,
  latestRevisionNumber: documents.latestRevisionNumber,
  updatedByAgentId: documents.updatedByAgentId,
  updatedByUserId: documents.updatedByUserId,
  createdAt: spacePages.createdAt,
  updatedAt: documents.updatedAt,
};

const pageSelect = {
  ...pageSummarySelect,
  format: documents.format,
  body: documents.latestBody,
  createdByAgentId: documents.createdByAgentId,
  createdByUserId: documents.createdByUserId,
};

type PageSummaryRow = Omit<SpacePageSummary, "title"> & { title: string | null };
type PageRow = PageSummaryRow & {
  format: string;
  body: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
};

function toPageSummary(row: PageSummaryRow): SpacePageSummary {
  return { ...row, title: row.title ?? "" };
}

function toPage(row: PageRow): SpacePage {
  return { ...row, title: row.title ?? "", format: row.format as DocumentFormat };
}

/**
 * Nests pages under their parents, keeping the order they come in. A page
 * whose parent is not in the list is shown at the top level rather than lost.
 */
export function buildSpacePageTree(pages: SpacePageSummary[]): SpacePageTreeNode[] {
  const nodes = new Map<string, SpacePageTreeNode>(pages.map((page) => [page.id, { ...page, children: [] }]));
  const roots: SpacePageTreeNode[] = [];
  for (const page of pages) {
    const node = nodes.get(page.id)!;
    const parent = page.parentPageId ? nodes.get(page.parentPageId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function spaceService(db: Db) {
  const selectPage = (pageId: string, spaceId: string) =>
    db
      .select(pageSelect)
      .from(spacePages)
      .innerJoin(documents, eq(spacePages.documentId, documents.id))
      .where(and(eq(spacePages.id, pageId), eq(spacePages.spaceId, spaceId), isNull(spacePages.deletedAt)))
      .then((rows) => rows[0] ?? null);

  return {
    list: async (companyId: string): Promise<SpaceListItem[]> => {
      const rows = await db
        .select({ space: spaces, pageCount: sql<number>`count(${spacePages.id})::int` })
        .from(spaces)
        .leftJoin(spacePages, and(eq(spacePages.spaceId, spaces.id), isNull(spacePages.deletedAt)))
        .where(and(eq(spaces.companyId, companyId), isNull(spaces.archivedAt)))
        .groupBy(spaces.id)
        .orderBy(asc(spaces.sortOrder), asc(spaces.createdAt), asc(spaces.id));
      return rows.map((row) => ({ ...row.space, pageCount: Number(row.pageCount) }));
    },

    getById: async (id: string): Promise<Space | null> => {
      if (!isUuidLike(id)) return null;
      return db
        .select()
        .from(spaces)
        .where(eq(spaces.id, id))
        .then((rows) => rows[0] ?? null);
    },

    /** A Space of this company by its address key, or by its id. */
    getByRef: async (companyId: string, ref: string): Promise<Space | null> => {
      const byKey = await db
        .select()
        .from(spaces)
        .where(and(eq(spaces.companyId, companyId), eq(spaces.urlKey, ref.trim().toLowerCase())))
        .then((rows) => rows[0] ?? null);
      if (byKey || !isUuidLike(ref)) return byKey;
      return db
        .select()
        .from(spaces)
        .where(and(eq(spaces.companyId, companyId), eq(spaces.id, ref.trim())))
        .then((rows) => rows[0] ?? null);
    },

    create: async (companyId: string, input: CreateSpace, actor: SpaceActor): Promise<Space> => {
      try {
        return await db.transaction(async (tx) => {
          // "Handbook" twice gives handbook and handbook-2.
          const base = spaceUrlKeyBase(input.name);
          const taken = new Set(
            await tx
              .select({ urlKey: spaces.urlKey })
              .from(spaces)
              .where(and(eq(spaces.companyId, companyId), or(eq(spaces.urlKey, base), like(spaces.urlKey, `${base}-%`))))
              .then((rows) => rows.map((row) => row.urlKey)),
          );
          let urlKey = base;
          for (let suffix = 2; taken.has(urlKey); suffix += 1) urlKey = `${base}-${suffix}`;

          const [{ nextSortOrder }] = await tx
            .select({ nextSortOrder: sql<number>`coalesce(max(${spaces.sortOrder}), -1) + 1` })
            .from(spaces)
            .where(eq(spaces.companyId, companyId));

          const [space] = await tx
            .insert(spaces)
            .values({
              companyId,
              name: input.name,
              urlKey,
              description: input.description || null,
              sortOrder: Number(nextSortOrder),
              createdByAgentId: actor.agentId,
              createdByUserId: actor.userId,
            })
            .returning();
          return space;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict("Another Space with this name was made at the same moment. Try again.");
        }
        throw error;
      }
    },

    update: async (id: string, input: UpdateSpace): Promise<Space | null> => {
      const patch: Partial<typeof spaces.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description || null;
      if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
      return db
        .update(spaces)
        .set(patch)
        .where(eq(spaces.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    listPageTree: async (spaceId: string): Promise<SpacePageTreeNode[]> => {
      const rows = await db
        .select(pageSummarySelect)
        .from(spacePages)
        .innerJoin(documents, eq(spacePages.documentId, documents.id))
        .where(and(eq(spacePages.spaceId, spaceId), isNull(spacePages.deletedAt)))
        .orderBy(asc(spacePages.sortOrder), asc(spacePages.createdAt), asc(spacePages.id));
      return buildSpacePageTree(rows.map(toPageSummary));
    },

    getPage: async (spaceId: string, pageId: string): Promise<SpacePage | null> => {
      if (!isUuidLike(pageId)) return null;
      const row = await selectPage(pageId, spaceId);
      return row ? toPage(row) : null;
    },

    createPage: async (space: Space, input: CreateSpacePage, actor: SpaceActor): Promise<SpacePage> => {
      const parentPageId = input.parentPageId ?? null;
      const pageId = await db.transaction(async (tx) => {
        if (parentPageId) {
          const parent = await tx
            .select({ id: spacePages.id })
            .from(spacePages)
            .where(and(eq(spacePages.id, parentPageId), eq(spacePages.spaceId, space.id), isNull(spacePages.deletedAt)))
            .then((rows) => rows[0] ?? null);
          if (!parent) throw unprocessable("The parent page is not in this Space");
        }

        // A new page goes after its siblings.
        const [{ nextSortOrder }] = await tx
          .select({ nextSortOrder: sql<number>`coalesce(max(${spacePages.sortOrder}), -1) + 1` })
          .from(spacePages)
          .where(
            and(
              eq(spacePages.spaceId, space.id),
              parentPageId ? eq(spacePages.parentPageId, parentPageId) : isNull(spacePages.parentPageId),
            ),
          );

        const now = new Date();
        const body = input.body ?? "";
        const [document] = await tx
          .insert(documents)
          .values({
            companyId: space.companyId,
            title: input.title,
            format: "markdown",
            latestBody: body,
            latestRevisionId: null,
            latestRevisionNumber: 1,
            createdByAgentId: actor.agentId,
            createdByUserId: actor.userId,
            updatedByAgentId: actor.agentId,
            updatedByUserId: actor.userId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            companyId: space.companyId,
            documentId: document.id,
            revisionNumber: 1,
            title: input.title,
            format: "markdown",
            body,
            createdByAgentId: actor.agentId,
            createdByUserId: actor.userId,
            createdAt: now,
          })
          .returning();

        await tx
          .update(documents)
          .set({ latestRevisionId: revision.id })
          .where(eq(documents.id, document.id));

        const [page] = await tx
          .insert(spacePages)
          .values({
            companyId: space.companyId,
            spaceId: space.id,
            documentId: document.id,
            parentPageId,
            sortOrder: Number(nextSortOrder),
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return page.id;
      });

      const created = await selectPage(pageId, space.id);
      if (!created) throw notFound("Page not found");
      return toPage(created);
    },

    /**
     * Saves a change to a page's title or text, written on the version
     * baseRevisionId. If the page has moved on since, nothing is saved and
     * the answer is 409 with the version it is on now.
     */
    updatePage: async (
      space: Space,
      pageId: string,
      input: UpdateSpacePage,
      actor: SpaceActor,
    ): Promise<{ page: SpacePage; change: "none" | "folded" | "new_version" }> => {
      if (!isUuidLike(pageId)) throw notFound("Page not found");
      return db.transaction(async (tx) => {
        // Hold the page's row until this save is written. A second save of
        // the same page waits here, then sees the version the first one made
        // and is refused, instead of both passing the check below at once.
        await tx.execute(sql`select ${spacePages.id} from ${spacePages} where ${spacePages.id} = ${pageId} for update`);

        const current = await tx
          .select(pageSelect)
          .from(spacePages)
          .innerJoin(documents, eq(spacePages.documentId, documents.id))
          .where(and(eq(spacePages.id, pageId), eq(spacePages.spaceId, space.id), isNull(spacePages.deletedAt)))
          .then((rows) => rows[0] ?? null);
        if (!current) throw notFound("Page not found");

        if (input.baseRevisionId !== current.latestRevisionId) {
          throw conflict("This page was changed by someone else", {
            currentRevisionId: current.latestRevisionId,
            currentRevisionNumber: current.latestRevisionNumber,
          });
        }

        const title = input.title ?? current.title ?? "";
        const body = input.body ?? current.body;
        if (title === (current.title ?? "") && body === current.body) {
          return { page: toPage(current), change: "none" as const };
        }

        const now = new Date();
        const latest = current.latestRevisionId
          ? await tx
            .select({
              id: documentRevisions.id,
              revisionNumber: documentRevisions.revisionNumber,
              changeSummary: documentRevisions.changeSummary,
              createdByAgentId: documentRevisions.createdByAgentId,
              createdByUserId: documentRevisions.createdByUserId,
              createdByRunId: documentRevisions.createdByRunId,
              createdAt: documentRevisions.createdAt,
            })
            .from(documentRevisions)
            .where(eq(documentRevisions.id, current.latestRevisionId))
            .then((rows) => rows[0] ?? null)
          : null;
        // Only a person's plain save folds into their own recent one: never
        // an agent's, and never into a version that says what it was (such as
        // a restore), which has to stay as it is.
        const folds = Boolean(
          latest
          && actor.userId
          && !actor.agentId
          && latest.createdByUserId === actor.userId
          && !latest.createdByAgentId
          && !latest.createdByRunId
          && !latest.changeSummary
          && now.getTime() - latest.createdAt.getTime() < SPACE_PAGE_FOLD_WINDOW_MS,
        );

        let revisionNumber = current.latestRevisionNumber + 1;
        if (folds && latest) {
          // The folded version gets a new id, so a save still holding the
          // old one (another tab, say) is refused as out of date instead of
          // passing the check above.
          revisionNumber = latest.revisionNumber;
          await tx.delete(documentRevisions).where(eq(documentRevisions.id, latest.id));
        }

        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            companyId: current.companyId,
            documentId: current.documentId,
            revisionNumber,
            title,
            format: current.format,
            body,
            createdByAgentId: actor.agentId,
            createdByUserId: actor.userId,
            createdAt: now,
          })
          .returning();

        await tx
          .update(documents)
          .set({
            title,
            latestBody: body,
            latestRevisionId: revision.id,
            latestRevisionNumber: revisionNumber,
            updatedByAgentId: actor.agentId,
            updatedByUserId: actor.userId,
            updatedAt: now,
          })
          .where(eq(documents.id, current.documentId));

        return {
          page: toPage({
            ...current,
            title,
            body,
            latestRevisionId: revision.id,
            latestRevisionNumber: revisionNumber,
            updatedByAgentId: actor.agentId,
            updatedByUserId: actor.userId,
            updatedAt: now,
          }),
          change: folds ? ("folded" as const) : ("new_version" as const),
        };
      });
    },
  };
}

export type SpaceService = ReturnType<typeof spaceService>;
