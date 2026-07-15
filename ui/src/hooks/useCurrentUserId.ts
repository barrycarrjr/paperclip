import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Resolve the signed-in user's id for ownership checks.
 *
 * Returns `null` when the session cannot be resolved — for example in the local
 * single-user trusted mode where the board acts implicitly. Callers should treat
 * a `null` result as "cannot determine an owner" and degrade gracefully by
 * assuming local ownership, so owner-only controls stay usable on a local box.
 */
export function useCurrentUserId(): string | null {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  return session?.user?.id ?? session?.session?.userId ?? null;
}
