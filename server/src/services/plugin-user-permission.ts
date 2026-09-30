import type { Db } from "@paperclipai/db";
import type { PermissionKey } from "@paperclipai/shared";
import { accessService } from "./access.js";
import { forbidden } from "../errors.js";

/** Recheck membership/grants on every call, including after a person answers a prompt. */
export async function requirePluginUserPermission(
  db: Db | undefined, companyId: string, userId: string | null | undefined,
  permission: PermissionKey, localTrusted = false,
): Promise<void> {
  if (localTrusted && userId === "local-board") return;
  if (!db || !userId) throw forbidden("This support action requires an authorized signed-in person");
  const access = accessService(db);
  if (await access.isInstanceAdmin(userId)) return;
  const membership = await access.getMembership(companyId, "user", userId);
  if (!membership || membership.status !== "active" || membership.membershipRole === "viewer" ||
      !(await access.hasPermission(companyId, "user", userId, permission))) {
    throw forbidden(`You need the ${permission} permission in this company`);
  }
}
