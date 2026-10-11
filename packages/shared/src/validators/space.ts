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
});

export type UpdateSpacePage = z.infer<typeof updateSpacePageSchema>;
