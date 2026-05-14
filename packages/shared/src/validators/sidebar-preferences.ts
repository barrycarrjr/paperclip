import { z } from "zod";

const sidebarOrderedIdSchema = z.string().uuid();

// Slug-style IDs used for nav items and section IDs (e.g. "portfolio-brief",
// "awaiting-tap"). Kept narrower than free text to avoid storing arbitrary
// payloads in the JSONB columns.
const sidebarSlugIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/i);

const pageKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/i);

export const sidebarOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarOrderedIdSchema),
  updatedAt: z.coerce.date().nullable(),
});

export const upsertSidebarOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarOrderedIdSchema),
});

export const upsertSidebarSlugOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarSlugIdSchema),
});

export const pageKeyParamSchema = pageKeySchema;

export type UpsertSidebarOrderPreference = z.infer<typeof upsertSidebarOrderPreferenceSchema>;
export type UpsertSidebarSlugOrderPreference = z.infer<typeof upsertSidebarSlugOrderPreferenceSchema>;
