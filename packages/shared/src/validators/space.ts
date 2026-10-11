import { z } from "zod";

export const SPACE_NAME_MAX = 120;
export const SPACE_DESCRIPTION_MAX = 500;
export const SPACE_PAGE_TITLE_MAX = 200;
/** The same limit task documents have. */
export const SPACE_PAGE_BODY_MAX = 524_288;

export const createSpaceSchema = z.object({
  name: z.string().trim().min(1).max(SPACE_NAME_MAX),
  description: z.string().trim().max(SPACE_DESCRIPTION_MAX).optional().nullable(),
});

export type CreateSpace = z.infer<typeof createSpaceSchema>;

export const updateSpaceSchema = z.object({
  name: z.string().trim().min(1).max(SPACE_NAME_MAX).optional(),
  description: z.string().trim().max(SPACE_DESCRIPTION_MAX).optional().nullable(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  /** Archive the Space, or bring it back. Archived, it is read only until it is brought back. */
  archived: z.boolean().optional(),
});

export type UpdateSpace = z.infer<typeof updateSpaceSchema>;

// A page's text is kept exactly as written. Task documents turn a typed "\n"
// into a line break, for agents that send their line breaks escaped; a person
// writing about "\n" would lose it that way.
export const createSpacePageSchema = z.object({
  title: z.string().trim().min(1).max(SPACE_PAGE_TITLE_MAX),
  body: z.string().max(SPACE_PAGE_BODY_MAX).optional(),
  parentPageId: z.string().uuid().optional().nullable(),
});

export type CreateSpacePage = z.infer<typeof createSpacePageSchema>;

export const updateSpacePageSchema = z.object({
  title: z.string().trim().min(1).max(SPACE_PAGE_TITLE_MAX).optional(),
  body: z.string().max(SPACE_PAGE_BODY_MAX).optional(),
  /** The version the change was written on. If the page has moved on since, the save is refused with 409. */
  baseRevisionId: z.string().uuid(),
  /**
   * Keep the version this save is written on as a version of its own, rather
   * than folding this save into it. "Keep mine" sends it after a conflict:
   * the version it lands on can be the same person's text from another tab.
   */
  keepPrevious: z.boolean().optional(),
});

export type UpdateSpacePage = z.infer<typeof updateSpacePageSchema>;

/**
 * Where a page goes, with all its subpages: under parentPageId, or to the top
 * level when that is null, in the Space spaceId (its own Space when left out).
 * index is its place among the pages already there, from 0; left out, it goes
 * after them. The same parent with another index puts pages in order.
 */
export const moveSpacePageSchema = z.object({
  spaceId: z.string().uuid().optional(),
  parentPageId: z.string().uuid().nullable(),
  index: z.number().int().min(0).max(1_000_000).optional(),
});

export type MoveSpacePage = z.infer<typeof moveSpacePageSchema>;

/** A restore is a save: it names the version it was written on, and is refused with 409 if the page has moved on. */
export const restoreSpacePageRevisionSchema = z.object({
  baseRevisionId: z.string().uuid(),
});

export type RestoreSpacePageRevision = z.infer<typeof restoreSpacePageRevisionSchema>;
