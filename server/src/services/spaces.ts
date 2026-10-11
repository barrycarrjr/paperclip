import { and, asc, desc, eq, inArray, isNotNull, isNull, like, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documentRevisions, documents, spacePages, spaces } from "@paperclipai/db";
import {
  isUuidLike,
  type CreateSpace,
  type CreateSpacePage,
  type DocumentFormat,
  type MoveSpacePage,
  type Space,
  type SpaceListItem,
  type SpacePage,
  type SpacePageLocation,
  type SpacePageRevision,
  type SpacePageRevisionDetail,
  type SpacePageSummary,
  type SpacePageTreeNode,
  type SpaceTrashChange,
  type SpaceTrashItem,
  type UpdateSpace,
  type UpdateSpacePage,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Said when something asks to change an archived Space or its pages. */
export const SPACE_ARCHIVED_MESSAGE = "This Space is archived. Unarchive it to change it.";

/** Said when a move would put a page under itself, which would take it out of the tree. */
export const SPACE_PAGE_MOVE_LOOP_MESSAGE = "A page cannot move under itself or one of its own subpages.";

/** Said when Move up or Move down comes from a screen that still shows the page where it was before a move. */
export const SPACE_PAGE_MOVED_SINCE_MESSAGE = "This page has moved since you last saw it.";

// 422, not 409: a refused save of a page answers 409 only when the page has
// moved on, and the editor offers its choice of versions on a 409.
function spaceArchived() {
  return unprocessable(SPACE_ARCHIVED_MESSAGE, { code: "space_archived" });
}

/**
 * How much of one person's writing a version holds. Autosave saves a moment
 * after typing stops, so without folding an afternoon's writing would leave
 * hundreds of versions. The window runs from the version's first save, not
 * from the last one: a version that kept folding for as long as someone kept
 * writing would hold hours of work, and a mistake at the end of them could
 * not be undone back to the middle.
 */
export const SPACE_PAGE_FOLD_WINDOW_MS = 10 * 60 * 1000;

/** Who is making a change. Spaces are for people for now; agents come later. */
export interface SpaceActor {
  agentId: string | null;
  userId: string | null;
}

const URL_KEY_DELIM_RE = /[^a-z0-9]+/g;
const URL_KEY_TRIM_RE = /^-+|-+$/g;
const URL_KEY_COMBINING_MARKS_RE = /[\u0300-\u036f]/g;
const URL_KEY_MAX = 60;

/**
 * The address key a Space name asks for: "Sales Handbook" gives
 * "sales-handbook". Accents are taken off their letters first, so "Café
 * Règles" gives "cafe-regles" rather than "caf-r-gles". A name with no Latin
 * letters at all still gets "space".
 */
export function spaceUrlKeyBase(name: string): string {
  const key = name
    .normalize("NFKD")
    .replace(URL_KEY_COMBINING_MARKS_RE, "")
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

const revisionSelect = {
  id: documentRevisions.id,
  revisionNumber: documentRevisions.revisionNumber,
  title: documentRevisions.title,
  changeSummary: documentRevisions.changeSummary,
  createdByAgentId: documentRevisions.createdByAgentId,
  createdByUserId: documentRevisions.createdByUserId,
  createdByRunId: documentRevisions.createdByRunId,
  createdAt: documentRevisions.createdAt,
};

/** What a person asked to save as the page's newest version. */
interface VersionChange {
  title: string;
  body: string;
  /** What the version is, such as "Restored version 3". A version that says so never folds. */
  changeSummary: string | null;
  /** Keep the version this lands on as one of its own (see updateSpacePageSchema). */
  keepPrevious: boolean;
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

  /**
   * Holds Spaces while their trees of pages change: a page added, moved, sent
   * to the trash or brought back. Each of those checks the tree, then changes
   * it, so two at once could each pass their check and together make a loop
   * (A under B and B under A, which drops both from the tree) or put a new
   * page under one going to the trash. Taken in id order, so two moves
   * between the same two Spaces cannot each wait for the other. Answers the
   * Spaces as they are now, and refuses the change if one is archived.
   *
   * Only this company's Spaces are held. Another company's is never locked
   * or read, so it is simply missing, and a refusal says nothing about it
   * (such as whether it is archived).
   */
  async function holdSpacesForTreeChange(tx: DbTransaction, companyId: string, spaceIds: string[]): Promise<Map<string, Space>> {
    const held = new Map<string, Space>();
    for (const id of [...new Set(spaceIds)].sort()) {
      const space = await tx
        .select()
        .from(spaces)
        .where(and(eq(spaces.id, id), eq(spaces.companyId, companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (space) held.set(id, space);
    }
    for (const space of held.values()) {
      if (space.archivedAt) throw spaceArchived();
    }
    return held;
  }

  /**
   * Holds a page for a save written on baseRevisionId, and answers it as it
   * is now. The Space is held too, without stopping other saves: a save waits
   * for a move or an archive to finish, then sees what it did.
   */
  async function holdPageForSave(tx: DbTransaction, spaceId: string, pageId: string, baseRevisionId: string) {
    const space = await tx
      .select({ archivedAt: spaces.archivedAt })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .for("share")
      .then((rows) => rows[0] ?? null);
    if (!space) throw notFound("Space not found");
    if (space.archivedAt) throw spaceArchived();

    // Hold the page's row until this save is written. A second save of
    // the same page waits here, then sees the version the first one made
    // and is refused, instead of both passing the check below at once.
    await tx.execute(sql`select ${spacePages.id} from ${spacePages} where ${spacePages.id} = ${pageId} for update`);

    const current = await tx
      .select(pageSelect)
      .from(spacePages)
      .innerJoin(documents, eq(spacePages.documentId, documents.id))
      .where(and(eq(spacePages.id, pageId), eq(spacePages.spaceId, spaceId), isNull(spacePages.deletedAt)))
      .then((rows) => rows[0] ?? null);
    if (!current) throw notFound("Page not found");

    if (baseRevisionId !== current.latestRevisionId) {
      throw conflict("This page was changed by someone else", {
        currentRevisionId: current.latestRevisionId,
        currentRevisionNumber: current.latestRevisionNumber,
      });
    }
    return current;
  }

  /**
   * Writes the page's title and text as its newest version, or folds them
   * into the newest one when that is the same person's plain save from less
   * than ten minutes before (SPACE_PAGE_FOLD_WINDOW_MS).
   */
  async function writeVersion(tx: DbTransaction, current: PageRow, change: VersionChange, actor: SpaceActor) {
    const now = new Date();
    const latest = current.latestRevisionId
      ? await tx
        .select(revisionSelect)
        .from(documentRevisions)
        .where(eq(documentRevisions.id, current.latestRevisionId))
        .then((rows) => rows[0] ?? null)
      : null;
    // Only a person's plain save folds into their own recent one: never
    // an agent's, never one that says what it is (a restore), never into a
    // version that says what it was, which has to stay as it is, and never a
    // save that asked to keep the version before it ("Keep mine" after a
    // conflict, where that version can be this same person's text from
    // another tab).
    const folds = Boolean(
      latest
      && !change.keepPrevious
      && !change.changeSummary
      && actor.userId
      && !actor.agentId
      && latest.createdByUserId === actor.userId
      && !latest.createdByAgentId
      && !latest.createdByRunId
      && !latest.changeSummary
      && now.getTime() - latest.createdAt.getTime() < SPACE_PAGE_FOLD_WINDOW_MS,
    );

    let revisionNumber = current.latestRevisionNumber + 1;
    let revisionCreatedAt = now;
    if (folds && latest) {
      // The folded version gets a new id, so a save still holding the
      // old one (another tab, say) is refused as out of date instead of
      // passing the check above. It keeps the time of its first save,
      // which the window above counts from.
      revisionNumber = latest.revisionNumber;
      revisionCreatedAt = latest.createdAt;
      await tx.delete(documentRevisions).where(eq(documentRevisions.id, latest.id));
    }

    const [revision] = await tx
      .insert(documentRevisions)
      .values({
        companyId: current.companyId,
        documentId: current.documentId,
        revisionNumber,
        title: change.title,
        format: current.format,
        body: change.body,
        changeSummary: change.changeSummary,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.userId,
        createdAt: revisionCreatedAt,
      })
      .returning();

    await tx
      .update(documents)
      .set({
        title: change.title,
        latestBody: change.body,
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
        title: change.title,
        body: change.body,
        latestRevisionId: revision.id,
        latestRevisionNumber: revisionNumber,
        updatedByAgentId: actor.agentId,
        updatedByUserId: actor.userId,
        updatedAt: now,
      }),
      change: folds ? ("folded" as const) : ("new_version" as const),
    };
  }

  /**
   * A page and every page under it that is not in the trash. A page in the
   * tree only ever sits under one that is in the tree too, so this is the
   * whole of what moves, or goes to the trash, with it.
   */
  async function liveSubtree(tx: DbTransaction, pageId: string): Promise<string[]> {
    const rows = await tx.execute(sql`
      with recursive subtree(id) as (
        select id from space_pages where id = ${pageId}
        union
        select child.id from space_pages child
        join subtree on child.parent_page_id = subtree.id
        where child.deleted_at is null
      )
      select id from subtree
    `);
    return Array.from(rows, (row) => String((row as { id: string }).id));
  }

  /** The next place at the end of a parent's pages (the top level when parentPageId is null). */
  async function nextSortOrder(tx: DbTransaction, spaceId: string, parentPageId: string | null) {
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${spacePages.sortOrder}), -1) + 1` })
      .from(spacePages)
      .where(
        and(
          eq(spacePages.spaceId, spaceId),
          parentPageId ? eq(spacePages.parentPageId, parentPageId) : isNull(spacePages.parentPageId),
        ),
      );
    return Number(next);
  }

  return {
    /** The company's Spaces, or with archived set, only its archived ones. */
    list: async (companyId: string, options: { archived?: boolean } = {}): Promise<SpaceListItem[]> => {
      const rows = await db
        .select({ space: spaces, pageCount: sql<number>`count(${spacePages.id})::int` })
        .from(spaces)
        .leftJoin(spacePages, and(eq(spacePages.spaceId, spaces.id), isNull(spacePages.deletedAt)))
        .where(
          and(
            eq(spaces.companyId, companyId),
            options.archived ? isNotNull(spaces.archivedAt) : isNull(spaces.archivedAt),
          ),
        )
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

    /**
     * A Space of this company by its id or its address key. Something shaped
     * like an id is tried as one first: a Space named with another Space's id
     * would otherwise take that Space's address over.
     */
    getByRef: async (companyId: string, ref: string): Promise<Space | null> => {
      const trimmed = ref.trim();
      if (isUuidLike(trimmed)) {
        const byId = await db
          .select()
          .from(spaces)
          .where(and(eq(spaces.companyId, companyId), eq(spaces.id, trimmed)))
          .then((rows) => rows[0] ?? null);
        if (byId) return byId;
      }
      return db
        .select()
        .from(spaces)
        .where(and(eq(spaces.companyId, companyId), eq(spaces.urlKey, trimmed.toLowerCase())))
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

    /**
     * Renames, describes, orders, archives or unarchives a Space. Archived,
     * a Space takes nothing but being unarchived. Answers it as it was and as
     * it is now.
     */
    update: async (id: string, input: UpdateSpace): Promise<{ before: Space; after: Space } | null> => {
      return db.transaction(async (tx) => {
        const before = await tx.select().from(spaces).where(eq(spaces.id, id)).for("update").then((rows) => rows[0] ?? null);
        if (!before) return null;
        if (before.archivedAt && input.archived !== false) throw spaceArchived();

        const now = new Date();
        const patch: Partial<typeof spaces.$inferInsert> = { updatedAt: now };
        if (input.name !== undefined) patch.name = input.name;
        if (input.description !== undefined) patch.description = input.description || null;
        if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
        if (input.archived !== undefined) patch.archivedAt = input.archived ? (before.archivedAt ?? now) : null;
        const [after] = await tx.update(spaces).set(patch).where(eq(spaces.id, id)).returning();
        return { before, after };
      });
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
        // Held, so the parent cannot go to the trash while its new subpage is made.
        await holdSpacesForTreeChange(tx, space.companyId, [space.id]);
        if (parentPageId) {
          const parent = await tx
            .select({ id: spacePages.id })
            .from(spacePages)
            .where(and(eq(spacePages.id, parentPageId), eq(spacePages.spaceId, space.id), isNull(spacePages.deletedAt)))
            .then((rows) => rows[0] ?? null);
          if (!parent) throw unprocessable("The parent page is not in this Space");
        }

        // A new page goes after its siblings.
        const sortOrder = await nextSortOrder(tx, space.id, parentPageId);

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
            sortOrder,
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
        const current = await holdPageForSave(tx, space.id, pageId, input.baseRevisionId);
        const title = input.title ?? current.title ?? "";
        const body = input.body ?? current.body;
        if (title === (current.title ?? "") && body === current.body) {
          return { page: toPage(current), change: "none" as const };
        }
        return writeVersion(
          tx,
          current,
          { title, body, changeSummary: null, keepPrevious: Boolean(input.keepPrevious) },
          actor,
        );
      });
    },

    /** A page's versions, newest first, or null when it is not a page of this Space. */
    listRevisions: async (spaceId: string, pageId: string): Promise<SpacePageRevision[] | null> => {
      if (!isUuidLike(pageId)) return null;
      // Every page has at least its first version, so none means no such page here.
      const rows = await db
        .select(revisionSelect)
        .from(documentRevisions)
        .innerJoin(spacePages, eq(spacePages.documentId, documentRevisions.documentId))
        .where(and(eq(spacePages.id, pageId), eq(spacePages.spaceId, spaceId), isNull(spacePages.deletedAt)))
        .orderBy(desc(documentRevisions.revisionNumber));
      return rows.length > 0 ? rows.map((row) => ({ ...row, title: row.title ?? "" })) : null;
    },

    /** One version of a page, with its text. */
    getRevision: async (spaceId: string, pageId: string, revisionId: string): Promise<SpacePageRevisionDetail | null> => {
      if (!isUuidLike(pageId) || !isUuidLike(revisionId)) return null;
      const row = await db
        .select({ ...revisionSelect, format: documentRevisions.format, body: documentRevisions.body })
        .from(documentRevisions)
        .innerJoin(spacePages, eq(spacePages.documentId, documentRevisions.documentId))
        .where(
          and(
            eq(documentRevisions.id, revisionId),
            eq(spacePages.id, pageId),
            eq(spacePages.spaceId, spaceId),
            isNull(spacePages.deletedAt),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return row ? { ...row, title: row.title ?? "", format: row.format as DocumentFormat } : null;
    },

    /**
     * Brings an older version back as the page's newest, labelled with the
     * version it came from. It goes through the same check as a save (409 if
     * the page has moved on from baseRevisionId), and never folds into the
     * version before it, so that one stays to be brought back in turn.
     */
    restoreRevision: async (
      space: Space,
      pageId: string,
      revisionId: string,
      baseRevisionId: string,
      actor: SpaceActor,
    ): Promise<{ page: SpacePage; restoredFromRevisionNumber: number }> => {
      if (!isUuidLike(pageId)) throw notFound("Page not found");
      if (!isUuidLike(revisionId)) throw notFound("Version not found");
      return db.transaction(async (tx) => {
        const current = await holdPageForSave(tx, space.id, pageId, baseRevisionId);
        const revision = await tx
          .select({ id: documentRevisions.id, revisionNumber: documentRevisions.revisionNumber, title: documentRevisions.title, body: documentRevisions.body })
          .from(documentRevisions)
          .where(and(eq(documentRevisions.id, revisionId), eq(documentRevisions.documentId, current.documentId)))
          .then((rows) => rows[0] ?? null);
        if (!revision) throw notFound("Version not found");
        if (revision.id === current.latestRevisionId) throw unprocessable("This is the page's current version already");

        const { page } = await writeVersion(
          tx,
          current,
          {
            title: revision.title ?? current.title ?? "",
            body: revision.body,
            changeSummary: `Restored version ${revision.revisionNumber}`,
            keepPrevious: true,
          },
          actor,
        );
        return { page, restoredFromRevisionNumber: revision.revisionNumber };
      });
    },

    /**
     * Moves a page, with all its subpages, under another page or to the top
     * level, in its own Space or another Space of the same company, at index
     * among the pages already there (after them when left out). The same
     * parent with another index puts pages in order. A page cannot go under
     * itself or its own subpages. With fromParentPageId, the move is refused
     * with 409 when the page's parent is no longer that one.
     */
    movePage: async (
      space: Space,
      pageId: string,
      input: MoveSpacePage,
    ): Promise<{ page: SpacePageSummary; fromSpaceId: string; fromParentPageId: string | null }> => {
      if (!isUuidLike(pageId)) throw notFound("Page not found");
      const targetSpaceId = input.spaceId ?? space.id;
      const parentPageId = input.parentPageId ?? null;
      const fromParentPageId = await db.transaction(async (tx) => {
        const held = await holdSpacesForTreeChange(tx, space.companyId, [space.id, targetSpaceId]);
        const source = held.get(space.id);
        const target = held.get(targetSpaceId);
        if (!source) throw notFound("Space not found");
        // Another company's Space is not held, so it is missing here too.
        if (!target) throw unprocessable("A page can only move to a Space of the same company");

        const page = await tx
          .select({ id: spacePages.id, parentPageId: spacePages.parentPageId, sortOrder: spacePages.sortOrder })
          .from(spacePages)
          .where(and(eq(spacePages.id, pageId), eq(spacePages.spaceId, space.id), isNull(spacePages.deletedAt)))
          .then((rows) => rows[0] ?? null);
        if (!page) throw notFound("Page not found");
        // Move up and Move down name the parent their screen showed. If the
        // page has been moved since, putting it in order there would quietly
        // undo that move.
        if (input.fromParentPageId !== undefined && page.parentPageId !== input.fromParentPageId) {
          throw conflict(SPACE_PAGE_MOVED_SINCE_MESSAGE, { parentPageId: page.parentPageId });
        }

        // Checked under the hold above: a move that waited there sees every
        // move made before it, so two cannot make a loop between them.
        const subtree = await liveSubtree(tx, page.id);
        if (parentPageId) {
          if (subtree.includes(parentPageId)) throw unprocessable(SPACE_PAGE_MOVE_LOOP_MESSAGE);
          const parent = await tx
            .select({ id: spacePages.id })
            .from(spacePages)
            .where(and(eq(spacePages.id, parentPageId), eq(spacePages.spaceId, targetSpaceId), isNull(spacePages.deletedAt)))
            .then((rows) => rows[0] ?? null);
          if (!parent) throw unprocessable("The page to move under is not in that Space");
        }

        // Its new neighbours in their order, with the page put at its place among them.
        const siblings = await tx
          .select({ id: spacePages.id, sortOrder: spacePages.sortOrder })
          .from(spacePages)
          .where(
            and(
              eq(spacePages.spaceId, targetSpaceId),
              parentPageId ? eq(spacePages.parentPageId, parentPageId) : isNull(spacePages.parentPageId),
              isNull(spacePages.deletedAt),
              ne(spacePages.id, page.id),
            ),
          )
          .orderBy(asc(spacePages.sortOrder), asc(spacePages.createdAt), asc(spacePages.id));
        const order = siblings.map((sibling) => sibling.id);
        order.splice(Math.min(input.index ?? order.length, order.length), 0, page.id);

        const now = new Date();
        if (targetSpaceId !== space.id) {
          await tx.update(spacePages).set({ spaceId: targetSpaceId, updatedAt: now }).where(inArray(spacePages.id, subtree));
        }
        const sortOrders = new Map(siblings.map((sibling) => [sibling.id, sibling.sortOrder]));
        for (const [position, id] of order.entries()) {
          if (id === page.id) {
            await tx.update(spacePages).set({ parentPageId, sortOrder: position, updatedAt: now }).where(eq(spacePages.id, id));
          } else if (sortOrders.get(id) !== position) {
            await tx.update(spacePages).set({ sortOrder: position }).where(eq(spacePages.id, id));
          }
        }
        return page.parentPageId;
      });

      const moved = await db
        .select(pageSummarySelect)
        .from(spacePages)
        .innerJoin(documents, eq(spacePages.documentId, documents.id))
        .where(eq(spacePages.id, pageId))
        .then((rows) => rows[0] ?? null);
      if (!moved) throw notFound("Page not found");
      return { page: toPageSummary(moved), fromSpaceId: space.id, fromParentPageId };
    },

    /**
     * Sends a page, with every subpage under it, to its Space's trash. They
     * leave the tree, and are refused as pages until they are restored.
     */
    deletePage: async (space: Space, pageId: string): Promise<SpaceTrashChange> => {
      if (!isUuidLike(pageId)) throw notFound("Page not found");
      return db.transaction(async (tx) => {
        await holdSpacesForTreeChange(tx, space.companyId, [space.id]);
        const page = await tx
          .select({ id: spacePages.id, parentPageId: spacePages.parentPageId })
          .from(spacePages)
          .where(and(eq(spacePages.id, pageId), eq(spacePages.spaceId, space.id), isNull(spacePages.deletedAt)))
          .then((rows) => rows[0] ?? null);
        if (!page) throw notFound("Page not found");

        const subpages = (await liveSubtree(tx, page.id)).filter((id) => id !== page.id);
        const now = new Date();
        await tx.update(spacePages).set({ deletedAt: now, deletedWithPageId: null, updatedAt: now }).where(eq(spacePages.id, page.id));
        if (subpages.length > 0) {
          await tx
            .update(spacePages)
            .set({ deletedAt: now, deletedWithPageId: page.id, updatedAt: now })
            .where(inArray(spacePages.id, subpages));
        }
        return { pageId: page.id, parentPageId: page.parentPageId, subpageCount: subpages.length };
      });
    },

    /** What is in a Space's trash, newest first: each page that was deleted, and how many subpages went with it. */
    listTrash: async (spaceId: string): Promise<SpaceTrashItem[]> => {
      const rows = await db
        .select({
          ...pageSummarySelect,
          deletedAt: spacePages.deletedAt,
          subpageCount: sql<number>`(select count(*) from space_pages went_with where went_with.deleted_with_page_id = ${spacePages.id})::int`,
        })
        .from(spacePages)
        .innerJoin(documents, eq(spacePages.documentId, documents.id))
        .where(and(eq(spacePages.spaceId, spaceId), isNotNull(spacePages.deletedAt), isNull(spacePages.deletedWithPageId)))
        .orderBy(desc(spacePages.deletedAt), asc(spacePages.id));
      return rows.map(({ deletedAt, subpageCount, ...row }) => ({
        ...toPageSummary(row),
        deletedAt: deletedAt!,
        subpageCount: Number(subpageCount),
      }));
    },

    /**
     * Brings a page back from the trash with the subpages that went with it.
     * It goes back under its parent, or to the top level of the Space when
     * that parent is in the trash too or no longer in this Space.
     */
    restoreFromTrash: async (space: Space, pageId: string): Promise<SpaceTrashChange> => {
      if (!isUuidLike(pageId)) throw notFound("This page is not in the trash");
      return db.transaction(async (tx) => {
        await holdSpacesForTreeChange(tx, space.companyId, [space.id]);
        const page = await tx
          .select({ id: spacePages.id, parentPageId: spacePages.parentPageId, sortOrder: spacePages.sortOrder })
          .from(spacePages)
          .where(
            and(
              eq(spacePages.id, pageId),
              eq(spacePages.spaceId, space.id),
              isNotNull(spacePages.deletedAt),
              isNull(spacePages.deletedWithPageId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!page) throw notFound("This page is not in the trash");

        let { parentPageId, sortOrder } = page;
        if (parentPageId) {
          const parent = await tx
            .select({ id: spacePages.id })
            .from(spacePages)
            .where(and(eq(spacePages.id, parentPageId), eq(spacePages.spaceId, space.id), isNull(spacePages.deletedAt)))
            .then((rows) => rows[0] ?? null);
          if (!parent) {
            parentPageId = null;
            sortOrder = await nextSortOrder(tx, space.id, null);
          }
        }

        const now = new Date();
        await tx.update(spacePages).set({ deletedAt: null, parentPageId, sortOrder, updatedAt: now }).where(eq(spacePages.id, page.id));
        const subpages = await tx
          .update(spacePages)
          .set({ deletedAt: null, deletedWithPageId: null, updatedAt: now })
          .where(eq(spacePages.deletedWithPageId, page.id))
          .returning({ id: spacePages.id });
        return { pageId: page.id, parentPageId, subpageCount: subpages.length };
      });
    },

    /**
     * Where a page of this company is now, for an address naming the Space it
     * was in before it moved, and whether it is in that Space's trash: a link
     * to a page in the trash (an Activity row's, say) can then say so. Null
     * for a page not found.
     */
    locatePage: async (companyId: string, pageId: string): Promise<SpacePageLocation | null> => {
      if (!isUuidLike(pageId)) return null;
      const row = await db
        .select({
          pageId: spacePages.id,
          spaceId: spaces.id,
          spaceUrlKey: spaces.urlKey,
          spaceName: spaces.name,
          deletedAt: spacePages.deletedAt,
        })
        .from(spacePages)
        .innerJoin(spaces, eq(spacePages.spaceId, spaces.id))
        .where(and(eq(spacePages.id, pageId), eq(spacePages.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const { deletedAt, ...location } = row;
      return { ...location, inTrash: deletedAt !== null };
    },
  };
}

export type SpaceService = ReturnType<typeof spaceService>;
