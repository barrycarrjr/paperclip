import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { invalidateAttention } from "../lib/invalidate-attention";
import { cn } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { ShieldCheck, CheckCircle2, History, Lock, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApprovalCard } from "../components/ApprovalCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";

type StatusFilter = "pending" | "all";

function ApprovalsEmptyHero() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 py-12 text-center">
      <div className="relative">
        <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-5">
          <ShieldCheck className="h-10 w-10 text-primary" strokeWidth={1.5} />
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-foreground">Safe Human-in-the-Loop Governance</h2>
        <p className="max-w-lg text-sm text-muted-foreground leading-relaxed">
          Approvals give you full control over your agent workforce. When an agent needs to perform critical operations—like spending budget, running terminal commands, or deploying code—it pauses and requests authorization here.
        </p>
      </div>

      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3 text-left">
        <div className="rounded-lg border border-border/70 bg-card p-4 shadow-xs">
          <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Lock className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-medium text-foreground">Guarded Autonomy</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-normal">
            Agents run freely on routine tasks, pausing only when their actions exceed safe operational thresholds.
          </p>
        </div>

        <div className="rounded-lg border border-border/70 bg-card p-4 shadow-xs">
          <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Check className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-medium text-foreground">One-Click Review</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-normal">
            Inspect the agent's explanation, proposed diffs, or API parameters and approve or reject with a click.
          </p>
        </div>

        <div className="rounded-lg border border-border/70 bg-card p-4 shadow-xs">
          <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <History className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-medium text-foreground">Full Audit Log</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-normal">
            Every approval decision and revision request is permanently recorded for compliance and debugging.
          </p>
        </div>
      </div>

      <Button onClick={() => navigate("/agents")}>
        View Agent Workforce
      </Button>
    </div>
  );
}

export function Approvals() {
  // URL-derived, not useCompany()'s selection state (P4 sweep, 2026-09-03) —
  // see Calendar.tsx's identical fix for the general pattern.
  const selectedCompanyId = useActiveCompanyId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathSegment = location.pathname.split("/").pop() ?? "pending";
  const statusFilter: StatusFilter = pathSegment === "all" ? "all" : "pending";
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Approvals" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      invalidateAttention(queryClient, selectedCompanyId!);
      navigate(`/approvals/${id}?resolved=approved`);
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      invalidateAttention(queryClient, selectedCompanyId!);
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
    },
  });

  const filtered = (data ?? [])
    .filter(
      (a) => statusFilter === "all" || a.status === "pending" || a.status === "revision_requested",
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const pendingCount = (data ?? []).filter(
    (a) => a.status === "pending" || a.status === "revision_requested",
  ).length;

  if (!selectedCompanyId) {
    return <EmptyState icon={ShieldCheck} message="Select a company to view its approvals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Tabs value={statusFilter} onValueChange={(v) => navigate(`/approvals/${v}`)}>
          <PageTabBar label="Approval filter" items={[
            { value: "pending", label: <>Pending{pendingCount > 0 && (
              <span className={cn(
                "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                "bg-yellow-500/20 text-yellow-500"
              )}>
                {pendingCount}
              </span>
            )}</> },
            { value: "all", label: "All" },
          ]} />
        </Tabs>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {filtered.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          message={statusFilter === "pending" ? "No pending approvals." : "No approvals yet."}
        />
      )}

      {filtered.length > 0 && (
        <div className="grid gap-3">
          {filtered.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
              onApprove={() => approveMutation.mutate(approval.id)}
              onReject={() => rejectMutation.mutate(approval.id)}
              detailLink={`/approvals/${approval.id}`}
              isPending={approveMutation.isPending || rejectMutation.isPending}
              pendingAction={
                approveMutation.isPending ? "approve" : rejectMutation.isPending ? "reject" : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
