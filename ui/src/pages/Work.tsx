import { useCallback, useMemo, type ReactNode } from "react";
import { Outlet, Route, useLocation, useNavigate } from "@/lib/router";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "../components/PageTabBar";
import { useCompany } from "../context/CompanyContext";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
import { WORK_DEFAULT_TAB, WORK_TABS, workTabForPath } from "../lib/work-tabs";

/**
 * The Work page: one page with tabs, instead of five separate menu lines.
 *
 * This is a shell, not a merge. It draws the tab strip and then hands over to
 * whichever of the five existing pages the address names, unchanged. Nothing
 * was combined, rewritten or removed, which is what the scope document asks
 * for when it says tasks are not queues or routines and that each keeps its
 * own lifecycle, deep controls and links.
 *
 * A tab is an address, not a piece of state. Clicking a tab is an ordinary
 * navigation to that page's existing address, so a tab can be linked to,
 * survives a reload, and the browser's back button walks back through the
 * tabs you visited. See lib/work-tabs.ts for the tab list and why the labels
 * are read from the workspace catalog.
 *
 * The company this page belongs to is named twice over: in the heading here,
 * and by the scope button in the top bar, which every page already has and
 * which none of these five pages changed.
 */
export function WorkLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const activeCompanyId = useActiveCompanyId();
  const { companies } = useCompany();

  const companyName = useMemo(
    () => companies.find((company) => company.id === activeCompanyId)?.name ?? null,
    [companies, activeCompanyId],
  );

  // Falls back to the first tab rather than to nothing, so the strip always
  // has one tab marked. In practice this shell only renders on the five tab
  // addresses, so the fallback is a safety net, not a normal path.
  const activeTab = workTabForPath(location.pathname) ?? WORK_DEFAULT_TAB;

  const items = useMemo(
    () => WORK_TABS.map((tab) => ({ value: tab.id, label: tab.label })),
    [],
  );

  const goToTab = useCallback(
    (value: string) => {
      const tab = WORK_TABS.find((candidate) => candidate.id === value);
      if (!tab || tab.id === activeTab.id) return;
      // A normal push, not a replace: stepping between tabs is something the
      // back button should be able to undo.
      navigate(tab.to);
    },
    [navigate, activeTab.id],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-2 border-b border-border pb-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {companyName ? `Work in ${companyName}` : "Work"}
        </p>
        {/*
          activationMode="manual" is what keeps one tab click to one entry in
          the browser's history. Left on its default, the tab strip asks to
          change tab twice for a single click: once when the mouse goes down,
          and again when the button takes focus a moment later. Neither call
          knows the other happened, because the address has not changed yet
          when the second one runs, so both push a new entry for the same page
          and the back button then needs two presses to leave the tab. Manual
          means only a real choice changes the tab: a click, or moving to a tab
          with the arrow keys and pressing Enter. Moving between tabs with the
          arrow keys no longer loads a page per tab you pass through either,
          which is the same fault seen from the keyboard.
        */}
        <Tabs value={activeTab.id} onValueChange={goToTab} activationMode="manual">
          <PageTabBar
            items={items}
            value={activeTab.id}
            onValueChange={goToTab}
            align="start"
            label="Work section"
          />
        </Tabs>
      </div>
      <Outlet />
    </div>
  );
}

/**
 * The routes the Work page's tabs live on.
 *
 * Built here rather than typed out in App.tsx so the tab list and the routes
 * cannot fall out of step: adding a tab to WORK_TABS adds its route, and the
 * order, labels and addresses all come from the one place. The caller says
 * which page each tab opens, which keeps the five page imports where every
 * other route's page import already is, and lets a test exercise this exact
 * routing code with light stand-ins instead of the real pages.
 */
export function workTabRoutes(pageForTab: (tabId: string) => ReactNode) {
  return (
    <Route element={<WorkLayout />}>
      {WORK_TABS.map((tab) => (
        <Route key={tab.id} path={tab.id} element={pageForTab(tab.id)} />
      ))}
    </Route>
  );
}
