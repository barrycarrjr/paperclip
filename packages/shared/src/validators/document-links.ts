/** Opaque declared Drive identity, not an online existence or access check. */
export const DRIVE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
export const DRIVE_FILE_ID_FIELDS = ["drive_file_id", "drivefileid", "drive_id", "driveid"] as const;

export function declaredDriveFileId(fields: Record<string, string>): {
  id: string | null;
  problem: string | null;
} {
  const values = DRIVE_FILE_ID_FIELDS.filter((key) => Object.hasOwn(fields, key)).map((key) => fields[key]!.trim());
  if (values.length === 0) return { id: null, problem: null };
  if (values.some((value) => !DRIVE_FILE_ID_PATTERN.test(value))) {
    return { id: null, problem: "Drive identity must be an exact file ID" };
  }
  if (new Set(values).size !== 1) return { id: null, problem: "Drive identity fields disagree" };
  return { id: values[0]!, problem: null };
}
