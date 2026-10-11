import { useEffect, useRef } from "react";
import { Navigate, Outlet, useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/error-message";
import { queryKeys } from "@/lib/queryKeys";

function BootstrapPendingPage({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Instance setup required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasActiveInvite
            ? "No instance admin exists yet. A bootstrap invite is already active. Check your Paperclip startup logs for the first admin invite URL, or run this command to rotate it:"
            : "No instance admin exists yet. Run this command in your Paperclip environment to generate the first admin invite URL:"}
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`pnpm paperclipai auth bootstrap-ceo`}
        </pre>
      </div>
    </div>
  );
}

function NoBoardAccessPage() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">No company access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account is signed in, but it does not have an active company membership or instance-admin access on
          this Paperclip instance.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Use a company invite or sign in with an account that already belongs to this org.
        </p>
      </div>
    </div>
  );
}

/**
 * All a new account sees until an instance admin approves it: the server
 * refuses it everything else. The gate asks again every so often, so the app
 * opens by itself once the account is approved.
 */
function AccountWaitingPage({ email }: { email: string | null }) {
  const queryClient = useQueryClient();
  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
  });

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <div className="rounded-lg border border-border bg-card p-6" data-testid="account-waiting">
        <h1 className="text-xl font-semibold">Your account is waiting for an admin to approve it</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {email ? `You are signed in as ${email}.` : "You are signed in."} You can use Paperclip once an admin
          approves your account.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">This page opens Paperclip by itself when that happens.</p>
        {signOutMutation.error ? (
          <p className="mt-3 text-sm text-destructive">
            {describeError(signOutMutation.error, "Could not sign out. Try again.")}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className="mt-5"
          onClick={() => signOutMutation.mutate()}
          disabled={signOutMutation.isPending}
        >
          {signOutMutation.isPending ? "Signing out…" : "Sign out"}
        </Button>
      </div>
    </div>
  );
}

export function CloudAccessGate() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { deploymentMode?: "local_trusted" | "authenticated"; bootstrapStatus?: "ready" | "bootstrap_pending" }
        | undefined;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
    // A new account waits for an instance admin. Look again now and then, so
    // the app opens by itself once it is approved.
    refetchInterval: (query) => (query.state.data?.accountStatus === "pending" ? 15_000 : false),
  });
  const accountWaiting = isAuthenticatedMode && sessionQuery.data?.accountStatus === "pending";

  // Everything the app asked for while the account waited was refused. Once
  // it is approved (or signs out), ask again rather than keep those answers.
  const wasWaitingRef = useRef(false);
  useEffect(() => {
    if (accountWaiting) {
      wasWaitingRef.current = true;
      return;
    }
    if (!wasWaitingRef.current) return;
    wasWaitingRef.current = false;
    void queryClient.invalidateQueries();
  }, [accountWaiting, queryClient]);

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: isAuthenticatedMode && !!sessionQuery.data && !accountWaiting,
    retry: false,
  });

  if (
    healthQuery.isLoading ||
    (isAuthenticatedMode && sessionQuery.isLoading) ||
    (isAuthenticatedMode && !!sessionQuery.data && !accountWaiting && boardAccessQuery.isLoading)
  ) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  if (healthQuery.error || boardAccessQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error
          ? healthQuery.error.message
          : boardAccessQuery.error instanceof Error
            ? boardAccessQuery.error.message
            : "Failed to load app state"}
      </div>
    );
  }

  if (isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending") {
    return <BootstrapPendingPage hasActiveInvite={healthQuery.data.bootstrapInviteActive} />;
  }

  if (isAuthenticatedMode && !sessionQuery.data) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  if (accountWaiting) {
    return <AccountWaitingPage email={sessionQuery.data?.user.email ?? null} />;
  }

  if (
    isAuthenticatedMode &&
    sessionQuery.data &&
    !boardAccessQuery.data?.isInstanceAdmin &&
    (boardAccessQuery.data?.companyIds.length ?? 0) === 0
  ) {
    return <NoBoardAccessPage />;
  }

  return <Outlet />;
}
