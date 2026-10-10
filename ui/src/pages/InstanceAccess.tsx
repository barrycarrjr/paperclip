import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, ShieldCheck } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useSaveMutation } from "@/hooks/useSaveMutation";
import { queryKeys } from "@/lib/queryKeys";

export function InstanceAccess() {
  const { companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Access" },
    ]);
  }, [setBreadcrumbs]);

  const usersQuery = useQuery({
    queryKey: queryKeys.access.adminUsers(search),
    queryFn: () => accessApi.searchAdminUsers(search),
  });

  const selectedUser = useMemo(
    () => usersQuery.data?.find((user) => user.id === selectedUserId) ?? null,
    [selectedUserId, usersQuery.data],
  );

  const userAccessQuery = useQuery({
    queryKey: queryKeys.access.userCompanyAccess(selectedUserId ?? ""),
    queryFn: () => accessApi.getUserCompanyAccess(selectedUserId!),
    enabled: !!selectedUserId,
  });

  useEffect(() => {
    if (!selectedUserId && usersQuery.data?.[0]) {
      setSelectedUserId(usersQuery.data[0].id);
    }
  }, [selectedUserId, usersQuery.data]);

  useEffect(() => {
    if (!userAccessQuery.data) return;
    setSelectedCompanyIds(
      new Set(
        userAccessQuery.data.companyAccess
          .filter((membership) => membership.status === "active")
          .map((membership) => membership.companyId),
      ),
    );
  }, [userAccessQuery.data]);

  // Both said when they worked and nothing at all when they failed, so a
  // refused change looked like a click that did nothing.
  //
  // Each one saves for whichever user is picked, so the user goes with the
  // save. A failure names that user and stays until a save for that same user
  // works, even after leaving the page and coming back: picking someone else
  // and saving them used to take it back, and the first user looked saved.
  const updateCompanyAccessMutation = useSaveMutation({
    mutationFn: (input: { userId: string; userLabel: string; companyIds: string[] }) =>
      accessApi.setUserCompanyAccess(input.userId, input.companyIds),
    successMessage: "Company access updated",
    errorMessage: (_error, input) => `Could not save company access for ${input.userLabel}`,
    saveName: "instance-company-access",
    saveKey: (input) => input.userId,
    onSuccess: async (_result, input) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.userCompanyAccess(input.userId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
    },
  });

  const setAdminMutation = useSaveMutation({
    mutationFn: async (input: { userId: string; userLabel: string; makeAdmin: boolean }) => {
      if (!input.userId) throw new Error("No user selected");
      if (input.makeAdmin) return accessApi.promoteInstanceAdmin(input.userId);
      return accessApi.demoteInstanceAdmin(input.userId);
    },
    successMessage: "Instance role updated",
    errorMessage: (_error, input) => `Could not change the instance role for ${input.userLabel}`,
    saveName: "instance-role",
    saveKey: (input) => input.userId,
    onSuccess: async (_result, input) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.userCompanyAccess(input.userId) });
    },
  });

  // How the picked user is named on the page, and in a failure about them.
  const selectedUserLabel = selectedUser?.name || selectedUser?.email || selectedUserId || "";

  if (usersQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading instance users…</div>;
  }

  if (usersQuery.error) {
    const message =
      usersQuery.error instanceof ApiError && usersQuery.error.status === 403
        ? "Instance admin access is required to manage users."
        : usersQuery.error instanceof Error
          ? usersQuery.error.message
          : "Failed to load users.";
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Instance Access</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Search users, manage instance-admin status, and control which companies they can access.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <section className="space-y-4 rounded-xl border border-border bg-card p-4">
          <label className="block space-y-2 text-sm">
            <span className="font-medium">Search users</span>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name or email"
            />
          </label>
          <div className="space-y-2">
            {(usersQuery.data ?? []).map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => setSelectedUserId(user.id)}
                className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                  user.id === selectedUserId
                    ? "border-foreground bg-accent"
                    : "border-border hover:bg-accent/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{user.name || user.email || user.id}</div>
                    <div className="truncate text-sm text-muted-foreground">{user.email || user.id}</div>
                  </div>
                  {user.isInstanceAdmin ? (
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  ) : null}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {user.activeCompanyMembershipCount} active company memberships
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-4 rounded-xl border border-border bg-card p-5">
          {!selectedUserId ? (
            <div className="text-sm text-muted-foreground">Select a user to inspect instance access.</div>
          ) : userAccessQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading user access…</div>
          ) : userAccessQuery.error ? (
            <div className="text-sm text-destructive">
              {userAccessQuery.error instanceof Error ? userAccessQuery.error.message : "Failed to load user access."}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-semibold">
                    {selectedUser?.name || selectedUser?.email || selectedUserId}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {selectedUser?.email || selectedUserId}
                  </div>
                </div>
                <Button
                  variant={selectedUser?.isInstanceAdmin ? "outline" : "default"}
                  onClick={() =>
                    setAdminMutation.mutate({
                      userId: selectedUserId,
                      userLabel: selectedUserLabel,
                      makeAdmin: !(selectedUser?.isInstanceAdmin ?? false),
                    })}
                  disabled={setAdminMutation.isPending}
                >
                  {selectedUser?.isInstanceAdmin ? "Remove instance admin" : "Promote to instance admin"}
                </Button>
              </div>

              <div className="space-y-3">
                <div>
                  <h2 className="text-sm font-semibold">Company access</h2>
                  <p className="text-sm text-muted-foreground">
                    Toggle company membership for this user. New access defaults to an active operator membership.
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {companies.map((company) => (
                    <label
                      key={company.id}
                      className="flex items-start gap-3 rounded-lg border border-border px-3 py-3"
                    >
                      <Checkbox
                        checked={selectedCompanyIds.has(company.id)}
                        onCheckedChange={(checked) => {
                          setSelectedCompanyIds((current) => {
                            const next = new Set(current);
                            if (checked) next.add(company.id);
                            else next.delete(company.id);
                            return next;
                          });
                        }}
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium">{company.name}</span>
                        <span className="block text-xs text-muted-foreground">{company.issuePrefix}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex justify-end">
                  <Button
                    onClick={() =>
                      updateCompanyAccessMutation.mutate({
                        userId: selectedUserId,
                        userLabel: selectedUserLabel,
                        companyIds: [...selectedCompanyIds],
                      })}
                    disabled={updateCompanyAccessMutation.isPending}
                  >
                    {updateCompanyAccessMutation.isPending ? "Saving…" : "Save company access"}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <h2 className="text-sm font-semibold">Current memberships</h2>
                <div className="space-y-2">
                  {(userAccessQuery.data?.companyAccess ?? []).map((membership) => (
                    <div
                      key={membership.id}
                      className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      <div>
                        <div className="font-medium">{membership.companyName || membership.companyId}</div>
                        <div className="text-muted-foreground">
                          {membership.membershipRole || "unset"} • {membership.status}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(membership.updatedAt).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
