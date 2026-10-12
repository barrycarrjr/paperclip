import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { accessApi, type AccountRequest } from "@/api/access";
import { healthApi } from "@/api/health";
import { Button } from "@/components/ui/button";
import { useSaveMutation } from "@/hooks/useSaveMutation";
import { describeError } from "@/lib/error-message";
import { OWN_LINE_ACTIONS_CLASS, WRAPPING_ROW_CLASS } from "@/lib/narrow-layout";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";

/** How a request is named on the page, and in a message about it. */
function requestLabel(request: AccountRequest): string {
  return request.name || request.email || "This account";
}

/**
 * The new accounts waiting for an instance admin, each with Approve and
 * Decline. A waiting account can sign in but sees only a waiting screen, and
 * gets its Personal company when it is approved.
 *
 * Shown on a local_trusted install only if something is waiting, which there
 * nearly never is: nobody signs up where nobody signs in.
 */
export function AccountRequestsPanel() {
  const queryClient = useQueryClient();
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  // The same cache entry the badges read (hooks/useAccountRequests), so the
  // count beside Access and this list cannot disagree.
  const requestsQuery = useQuery({
    queryKey: queryKeys.access.accountRequests,
    queryFn: () => accessApi.listAccountRequests(),
    refetchInterval: 30_000,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.accountRequests });
    // Approved, the account joins the user list below.
    await queryClient.invalidateQueries({ queryKey: ["access", "admin-users"] });
  };

  const approveMutation = useSaveMutation({
    mutationFn: (request: AccountRequest) => accessApi.approveAccountRequest(request.id),
    successMessage: (_result, request) => `${requestLabel(request)} can use Paperclip now.`,
    errorMessage: (_error, request) => `Could not approve ${requestLabel(request)}`,
    saveName: "account-request-approve",
    saveKey: (request) => request.id,
    onSuccess: refresh,
  });

  const declineMutation = useSaveMutation({
    mutationFn: (request: AccountRequest) => accessApi.declineAccountRequest(request.id),
    successMessage: (_result, request) => `${requestLabel(request)} was declined.`,
    errorMessage: (_error, request) => `Could not decline ${requestLabel(request)}`,
    saveName: "account-request-decline",
    saveKey: (request) => request.id,
    onSuccess: refresh,
  });

  const requests = requestsQuery.data ?? [];
  const authenticated = health?.deploymentMode === "authenticated";
  if (!authenticated && requests.length === 0) return null;

  const deciding = approveMutation.isPending || declineMutation.isPending;

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" data-testid="account-requests">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Waiting for approval</h2>
        </div>
        {requests.length > 0 ? (
          <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
            {requests.length} waiting
          </span>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        New accounts can sign in, but they cannot use Paperclip until you approve them.
      </p>

      {requestsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading new accounts…</p>
      ) : requestsQuery.error ? (
        <p className="text-sm text-destructive">{describeError(requestsQuery.error, "Could not load new accounts.")}</p>
      ) : requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">No new accounts are waiting.</p>
      ) : (
        <ul className="space-y-2">
          {requests.map((request) => (
            <li key={request.id} className="rounded-lg border border-border px-3 py-3">
              <div className={WRAPPING_ROW_CLASS}>
                <div className="min-w-0 flex-1 basis-48">
                  <div className="truncate font-medium">{requestLabel(request)}</div>
                  {request.name && request.email ? (
                    <div className="truncate text-sm text-muted-foreground">{request.email}</div>
                  ) : null}
                  <div className="text-xs text-muted-foreground">Asked {formatDateTime(request.requestedAt)}</div>
                </div>
                <div className={OWN_LINE_ACTIONS_CLASS}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={deciding}
                    onClick={() => {
                      // There is no undo: a declined account cannot sign in again.
                      if (window.confirm(`Decline ${requestLabel(request)}? They will not be able to sign in.`)) {
                        declineMutation.mutate(request);
                      }
                    }}
                  >
                    Decline
                  </Button>
                  <Button type="button" size="sm" disabled={deciding} onClick={() => approveMutation.mutate(request)}>
                    Approve
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
