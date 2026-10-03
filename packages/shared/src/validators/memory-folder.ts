import { z } from "zod";

/** Minutes between automatic folder syncs. */
export const MEMORY_FOLDER_SCHEDULES = [15, 60, 360, 1440] as const;

export const updateMemoryFolderSchema = z.object({
  /** Absolute path (a leading `~/` is expanded on the server). Empty string disconnects the folder. */
  path: z.string().max(1000),
  scheduleMinutes: z
    .number()
    .int()
    .refine((n) => (MEMORY_FOLDER_SCHEDULES as readonly number[]).includes(n), {
      message: `scheduleMinutes must be one of ${MEMORY_FOLDER_SCHEDULES.join(", ")}`,
    })
    .nullable()
    .optional(),
});

export type UpdateMemoryFolder = z.infer<typeof updateMemoryFolderSchema>;
