import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { GoalTree } from "../components/GoalTree";
import { EmptyState } from "../components/EmptyState";
import { InfoPopoverButton } from "../components/InfoPopoverButton";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Target, Plus, Check, ListTree } from "lucide-react";

function GoalsEmptyHero({ onNewGoal }: { onNewGoal: () => void }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 py-12 text-center">
      <div className="relative">
        <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-5">
          <Target className="h-10 w-10 text-primary" strokeWidth={1.5} />
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-foreground">Align Your Agents with Company Goals</h2>
        <p className="max-w-lg text-sm text-muted-foreground leading-relaxed">
          Goals represent the high-level objectives and strategic outcomes your company is working toward. Day-to-day tasks, cases, and projects ladder directly up to these goals.
        </p>
      </div>

      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3 text-left">
        <div className="rounded-lg border border-border/70 bg-card p-4 shadow-xs">
          <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Target className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-medium text-foreground">Strategic Intent</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-normal">
            Give agents context on <em>why</em> work matters so they make smart decisions autonomously.
          </p>
        </div>

        <div className="rounded-lg border border-border/70 bg-card p-4 shadow-xs">
          <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <ListTree className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-medium text-foreground">Goal Hierarchy</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-normal">
            Break top-level company goals into sub-goals and milestones that teams can easily deliver.
          </p>
        </div>

        <div className="rounded-lg border border-border/70 bg-card p-4 shadow-xs">
          <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Check className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-medium text-foreground">Traceable Impact</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-normal">
            Link tasks and cases to goals so every pull request and article clearly connects to outcomes.
          </p>
        </div>
      </div>

      <Button onClick={onNewGoal} size="lg" className="mt-2">
        <Plus className="mr-2 h-4 w-4" />
        Create your first goal
      </Button>
    </div>
  );
}

export function Goals() {
  // URL-derived, not useCompany()'s selection state (P4 sweep, 2026-09-03) —
  // see Calendar.tsx's identical fix for the general pattern.
  const selectedCompanyId = useActiveCompanyId();
  const { openNewGoal } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const header = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Goals</h1>
          <InfoPopoverButton
            title="What goals are for"
            info={
              <>
                <p>
                  Goals are the higher-level objectives this company is working
                  toward. They're the "why" — issues are the "what." A goal
                  rarely closes in a single sprint; it's the standing intent
                  agents and operators ladder their work up to.
                </p>
                <p className="font-medium text-foreground">Goal vs issue</p>
                <ul className="ml-4 list-disc space-y-1">
                  <li>
                    Issues have a definition of done and an assignee. They
                    finish.
                  </li>
                  <li>
                    Goals have a direction and an owner. They evolve as the
                    company learns.
                  </li>
                  <li>
                    Issues link up to goals so the work is traceable to
                    intent. Open an issue and you'll see which goal(s) it
                    contributes to.
                  </li>
                </ul>
                <p className="font-medium text-foreground">How to structure them</p>
                <p>
                  Use levels to keep things scannable. Top-level{" "}
                  <span className="font-medium">company</span> goals
                  (a handful at most) sit at the root. Underneath, smaller
                  child goals capture the next layer of "how do we get there."
                  Sub-goals can have their own sub-goals — keep the tree as
                  shallow as the work allows.
                </p>
                <p className="font-medium text-foreground">When to add one</p>
                <p>
                  When something matters longer than a single issue's worth
                  of work, or when multiple issues should obviously belong to
                  the same effort. If the goal would just restate one issue,
                  skip it.
                </p>
              </>
            }
            contentClassName="w-96"
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Higher-level objectives this company is working toward. Issues ladder up to goals.
        </p>
      </div>
      {goals && goals.length > 0 && (
        <Button size="sm" variant="outline" onClick={() => openNewGoal()}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Goal
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {header}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {goals && goals.length === 0 && (
        <EmptyState
          icon={Target}
          message="No goals yet. Add one for each major outcome the company is working toward — keep the top level small (a handful at most) and break the rest down into child goals as needed."
          action="Add Goal"
          onAction={() => openNewGoal()}
        />
      )}

      {goals && goals.length > 0 && (
        <GoalTree goals={goals} goalLink={(goal) => `/goals/${goal.id}`} />
      )}
    </div>
  );
}
