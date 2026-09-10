import { useCallback, useEffect, useMemo } from "react";
import { Outlet, useLocation, useNavigate } from "@/lib/router";
import { Bot, Plus } from "lucide-react";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { PageTabBar } from "../components/PageTabBar";
import { TeamCurrentWork } from "../components/TeamCurrentWork";
import { TeamActivityTimeline } from "../components/TeamActivityTimeline";
import { EmptyState } from "../components/EmptyState";
import { useCompany } from "../context/CompanyContext";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { cn } from "../lib/utils";
import { TEAM_DEFAULT_TAB, TEAM_TABS, teamTabForPath } from "../lib/team-tabs";

/**
 * The Team page: one page that opens on what the team is doing right now,
 * instead of three separate menu lines.
 *
 * This is a shell, not a merge. It draws the tab strip and then hands over to
 * whichever page the address names, unchanged. The agent roster, the org
 * chart and the assistants list were not combined, rewritten or removed, and
 * neither were the agent's own tabs (instructions, skills, runs, budget,
 * configuration), which stay on the agent's page one click deeper. That is
 * what the scope document asks for when it says to retain all of it "behind a
 * current-work-first view".
 *
 * A tab is an address, not a piece of state. Clicking a tab is an ordinary
 * navigation to that page's existing address, so a tab can be linked to,
 * survives a reload, and the browser's back button walks back through the
 * tabs you visited. See lib/team-tabs.ts for the tab list.
 */
export function TeamLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const activeCompanyId = useActiveCompanyId();
  const { companies } = useCompany();

  const companyName = useMemo(
    () => companies.find((company) => company.id === activeCompanyId)?.name ?? null,
    [companies, activeCompanyId],
  );

  // Falls back to the first tab rather than to nothing, so the strip always
  // has one tab marked. In practice this shell only renders on the four tab
  // addresses, so the fallback is a safety net, not a normal path.
  const activeTab = teamTabForPath(location.pathname) ?? TEAM_DEFAULT_TAB;

  const items = useMemo(() => TEAM_TABS.map((tab) => ({ value: tab.id, label: tab.label })), []);

  const goToTab = useCallback(
    (value: string) => {
      const tab = TEAM_TABS.find((candidate) => candidate.id === value);
      if (!tab || tab.id === activeTab.id) return;
      // A normal push, not a replace: stepping between tabs is something the
      // back button should be able to undo.
      navigate(tab.to);
    },
    [navigate, activeTab.id],
  );

  // The org chart draws into a fixed-height viewport and asks its parent for
  // the full height of the main area. Ordinary scrolling lists must not get
  // it, or a short list would push the tab strip up off a tall screen.
  const fillHeight = activeTab.id === "org";

  return (
    <div className={cn("flex min-w-0 flex-col gap-4", fillHeight && "h-full min-h-0")}>
      <div className="flex flex-col gap-2 border-b border-border pb-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {companyName ? `Team in ${companyName}` : "Team"}
        </p>
        {/*
          activationMode="manual" for the same reason the Work page sets it,
          written out in full there: without it a single tab click asks to
          change tab twice, once on mouse down and once when the button takes
          focus, and both pushes land on the browser's history so the back
          button needs two presses.
        */}
        <Tabs value={activeTab.id} onValueChange={goToTab} activationMode="manual">
          <PageTabBar
            items={items}
            value={activeTab.id}
            onValueChange={goToTab}
            align="start"
            label="Team section"
          />
        </Tabs>
      </div>
      <div className={cn("min-w-0", fillHeight && "min-h-0 flex-1")}>
        <Outlet />
      </div>
    </div>
  );
}

/**
 * The current-work tab at /team: one line per agent saying what it is doing
 * right now, and nothing that the app cannot back with real data.
 */
export function Team() {
  const companyId = useActiveCompanyId();
  const { openNewAgent } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Team" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-sm text-muted-foreground">
          What each agent is doing right now, and the controls to do something about it.
          Click a number to narrow the list, or open anyone for the detail. The roster,
          the reporting lines and the assistants stay one click away on the tabs above.
        </p>
        <Button size="sm" variant="outline" className="shrink-0" onClick={openNewAgent}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New agent
        </Button>
      </div>

      {companyId ? (
        <TeamCurrentWork companyId={companyId} />
      ) : (
        <EmptyState icon={Bot} message="Select a company to see what its team is doing." />
      )}
    </div>
  );
}

/**
 * The timeline tab at /team/timeline: the same team, but along a clock
 * rather than at a single moment. Answers the questions the right-now view
 * cannot, such as whether somebody has actually been working this afternoon.
 */
export function TeamTimeline() {
  const companyId = useActiveCompanyId();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Team", href: "/team" }, { label: "Timeline" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        What the whole team has been doing over time. Each bar is a run; click one to
        open it.
      </p>

      {companyId ? (
        <TeamActivityTimeline companyId={companyId} />
      ) : (
        <EmptyState icon={Bot} message="Select a company to see what its team has been doing." />
      )}
    </div>
  );
}
