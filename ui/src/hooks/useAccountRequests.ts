import { useQuery } from "@tanstack/react-query";
import { accessApi, type AccountRequest } from "../api/access";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";

const NONE: AccountRequest[] = [];

/**
 * The new accounts waiting for an instance admin to approve them, for an
 * instance admin. Anyone else gets an empty list without the server being
 * asked, and so does a local_trusted install, where nobody signs up.
 *
 * Asked again every half minute, the way the sidebar's other counts are, so a
 * request made while the app is open shows up without a reload. The Access
 * page's list reads the same cache entry, so the count beside it and the list
 * it points at cannot disagree.
 */
export function useAccountRequests(): AccountRequest[] {
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const authenticated = health?.deploymentMode === "authenticated";
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: authenticated,
    retry: false,
  });
  const isInstanceAdmin = authenticated && boardAccess?.isInstanceAdmin === true;
  const { data } = useQuery({
    queryKey: queryKeys.access.accountRequests,
    queryFn: () => accessApi.listAccountRequests(),
    enabled: isInstanceAdmin,
    refetchInterval: 30_000,
    retry: false,
  });
  return isInstanceAdmin ? data ?? NONE : NONE;
}
