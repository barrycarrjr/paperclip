import type { ActivityEvent } from "@paperclipai/shared";

// Only the fields these read, so an agent action audit row works too.
type ActivityNameSource = Pick<ActivityEvent, "entityType" | "details">;

export function detailString(event: Pick<ActivityEvent, "details">, ...keys: string[]) {
  const details = event.details;
  for (const key of keys) {
    const value = details?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function activityEntityName(event: ActivityNameSource) {
  if (event.entityType === "issue") return detailString(event, "identifier", "issueIdentifier");
  if (event.entityType === "project") return detailString(event, "projectName", "name", "title");
  if (event.entityType === "goal") return detailString(event, "goalTitle", "title", "name");
  return detailString(event, "name", "title");
}

export function activityEntityTitle(event: ActivityNameSource) {
  if (event.entityType === "issue") return detailString(event, "issueTitle", "title");
  return null;
}
