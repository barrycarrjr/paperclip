import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, Megaphone, Plus } from "lucide-react";
import type { Company } from "@paperclipai/shared";
import { issuesApi, type PortfolioDirective } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Link } from "@/lib/router";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

// Issue statuses that count as "the CEO has finished acting on this directive".
const DONE_STATUSES = new Set(["done", "completed", "succeeded", "closed", "cancelled"]);

function directiveProgress(d: PortfolioDirective): { done: number; total: number; pct: number } {
  const total = d.companyCount || d.items.length;
  let done = 0;
  for (const [status, count] of Object.entries(d.statusCounts)) {
    if (DONE_STATUSES.has(status)) done += count;
  }
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

interface DirectiveCardProps {
  directive: PortfolioDirective;
  prefixByCompanyId: Map<string, string>;
  collapsed: boolean;
  onToggle: () => void;
}

function DirectiveCard({ directive, prefixByCompanyId, collapsed, onToggle }: DirectiveCardProps) {
  const { done, total, pct } = directiveProgress(directive);
  const allDone = total > 0 && done === total;
  const items = useMemo(
    () => [...directive.items].sort((a, b) => a.companyName.localeCompare(b.companyName)),
    [directive.items],
  );

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent/30 transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        )}
        <Megaphone className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold truncate">{directive.title}</span>
            <span className="text-xs text-muted-foreground shrink-0">
              {timeAgo(new Date(directive.createdAt))}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="h-1.5 flex-1 max-w-48 rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full rounded-full", allDone ? "bg-green-500" : "bg-primary")}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              {done}/{total} {total === 1 ? "company" : "companies"} done
            </span>
          </div>
        </div>
      </button>

      {!collapsed && (
        <div className="border-t border-border divide-y divide-border/60">
          {items.map((item) => {
            const prefix = prefixByCompanyId.get(item.companyId);
            const label = item.identifier ?? item.issueId.slice(0, 8);
            return (
              <div
                key={item.issueId}
                className="flex items-center gap-3 px-4 py-2 pl-11 hover:bg-accent/30 transition-colors"
              >
                <span className="text-sm truncate flex-1 min-w-0">{item.companyName}</span>
                {prefix ? (
                  <Link
                    to={`/${prefix}/issues/${item.issueId}`}
                    className="text-xs font-mono text-muted-foreground hover:text-foreground hover:underline shrink-0"
                  >
                    {label}
                  </Link>
                ) : (
                  <span className="text-xs font-mono text-muted-foreground shrink-0">{label}</span>
                )}
                <StatusBadge status={item.status} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface NewDirectiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companies: Company[];
  isSubmitting: boolean;
  onSubmit: (input: { intent: string; companyIds?: string[] }) => void;
}

function NewDirectiveDialog({ open, onOpenChange, companies, isSubmitting, onSubmit }: NewDirectiveDialogProps) {
  const [intent, setIntent] = useState("");
  const [scopeAll, setScopeAll] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Operating companies only — HQ is the cockpit, never a directive target.
  const targetable = useMemo(
    () => companies.filter((c) => !c.isPortfolioRoot).sort((a, b) => a.name.localeCompare(b.name)),
    [companies],
  );

  // Reset when the dialog opens.
  useEffect(() => {
    if (open) {
      setIntent("");
      setScopeAll(true);
      setSelectedIds(new Set());
    }
  }, [open]);

  function toggleCompany(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const trimmed = intent.trim();
  const chosen = scopeAll ? targetable : targetable.filter((c) => selectedIds.has(c.id));
  const canSubmit = trimmed.length > 0 && chosen.length > 0 && !isSubmitting;

  function submit() {
    if (!canSubmit) return;
    onSubmit({
      intent: trimmed,
      companyIds: scopeAll ? undefined : chosen.map((c) => c.id),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New portfolio directive</DialogTitle>
          <DialogDescription>
            State one high-level intent. It's handed to each targeted company's CEO, who breaks it
            down and delegates to the right agent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Textarea
            autoFocus
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="e.g. Acknowledge and reply to every company's Google reviews"
            className="min-h-24 text-sm"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
            }}
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Target
              </span>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setScopeAll((v) => !v)}
              >
                {scopeAll ? "Choose companies" : "All companies"}
              </button>
            </div>
            {scopeAll ? (
              <p className="text-sm text-muted-foreground">
                All {targetable.length} operating {targetable.length === 1 ? "company" : "companies"}.
              </p>
            ) : (
              <div className="max-h-44 overflow-y-auto rounded-md border border-border divide-y divide-border/60">
                {targetable.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleCompany(c.id)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/40"
                  >
                    <Checkbox checked={selectedIds.has(c.id)} className="h-3.5 w-3.5" />
                    <CompanyPatternIcon
                      companyName={c.name}
                      logoUrl={c.logoUrl}
                      brandColor={c.brandColor}
                      className="h-4 w-4 shrink-0 rounded-[3px]"
                    />
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
                {targetable.length === 0 && (
                  <p className="px-3 py-2 text-sm text-muted-foreground">No operating companies.</p>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Broadcasting…
              </>
            ) : (
              `Broadcast to ${chosen.length} ${chosen.length === 1 ? "CEO" : "CEOs"}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PortfolioDirectives() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Portfolio Directives" }]);
  }, [setBreadcrumbs]);

  const isPortfolioRoot = selectedCompany?.isPortfolioRoot ?? false;

  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-directives", selectedCompanyId],
    queryFn: () => issuesApi.listPortfolioDirectives(selectedCompanyId!),
    enabled: !!selectedCompanyId && isPortfolioRoot,
    refetchInterval: 15_000,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const broadcast = useMutation({
    mutationFn: (input: { intent: string; companyIds?: string[] }) =>
      issuesApi.broadcastDirective(selectedCompanyId!, input),
    onSuccess: (result) => {
      setDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["portfolio-directives", selectedCompanyId] });
      const sent = result.dispatched.length;
      const skipped = result.skipped.length;
      pushToast({
        title:
          sent > 0
            ? `Directive sent to ${sent} ${sent === 1 ? "CEO" : "CEOs"}`
            : "No CEOs reached",
        body:
          skipped > 0
            ? `${skipped} ${skipped === 1 ? "company" : "companies"} skipped — see the directive for reasons.`
            : undefined,
        tone: sent > 0 ? "success" : "warn",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Couldn't broadcast the directive",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    },
  });

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  function toggleCollapse(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const directives = data?.directives ?? [];
  const prefixByCompanyId = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of (data?.companies ?? []) as Company[]) map.set(c.id, c.issuePrefix);
    return map;
  }, [data?.companies]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Megaphone} message="Select a company to view Portfolio Directives." />;
  }
  if (!isPortfolioRoot) {
    return (
      <EmptyState
        icon={Megaphone}
        message="Portfolio Directives are only available on the HQ (portfolio root) company."
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-base font-semibold">Portfolio Directives</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            High-level intents you broadcast from HQ, cascading through each company's CEO.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {isLoading ? "Loading…" : `${directives.length} ${directives.length === 1 ? "directive" : "directives"}`}
          </span>
          <Button size="sm" className="h-8" onClick={() => setDialogOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> New directive
          </Button>
        </div>
      </div>

      <NewDirectiveDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        companies={(data?.companies ?? []) as Company[]}
        isSubmitting={broadcast.isPending}
        onSubmit={(input) => broadcast.mutate(input)}
      />

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading directives…</p>}
        {!isLoading && directives.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
            <Megaphone className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground max-w-md">
              No directives yet. Broadcast a portfolio-wide intent — e.g. &ldquo;acknowledge and
              reply to every company's Google reviews&rdquo; — and it fans out to each company's CEO.
              You can also do this from Clippy here at HQ.
            </p>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> New directive
            </Button>
          </div>
        )}
        {!isLoading &&
          directives.map((d) => (
            <DirectiveCard
              key={d.directiveId}
              directive={d}
              prefixByCompanyId={prefixByCompanyId}
              collapsed={collapsedIds.has(d.directiveId)}
              onToggle={() => toggleCollapse(d.directiveId)}
            />
          ))}
      </div>
    </div>
  );
}
