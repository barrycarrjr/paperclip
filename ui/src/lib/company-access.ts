import type { CurrentBoardAccess } from "../api/access";

/**
 * Can the signed-in board user create or change work in this company?
 *
 * The server is the real gate (viewer access is refused there regardless), so this
 * only decides which buttons to show. Hiding a button that would answer 403 is the
 * whole point: never render a control that cannot do the thing.
 *
 * A local instance with no login (`local_implicit`) and an instance admin can always
 * write. Otherwise an active membership must carry a real, non-viewer role. When the
 * access payload predates the memberships array (older servers omit it), fall back to
 * the plain company list so nothing regresses for those callers.
 */
export function canWriteCompany(
  companyId: string,
  boardAccess: CurrentBoardAccess | undefined,
): boolean {
  if (!boardAccess) return false;
  if (boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin) return true;

  const membership = boardAccess.memberships?.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  if (!membership) return boardAccess.companyIds.includes(companyId) && !boardAccess.memberships;
  return membership.membershipRole !== "viewer" && membership.membershipRole !== null;
}
