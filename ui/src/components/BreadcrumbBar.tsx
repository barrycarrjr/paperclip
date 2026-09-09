import { Link, useLocation, useNavigate } from "@/lib/router";
import { Check, ChevronsUpDown, Menu, Search, Sparkles } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
import { useGeneralSettings } from "../context/GeneralSettingsContext";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Fragment, useCallback, useMemo, useState } from "react";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";
import { StarterCatalogDialog } from "./StarterCatalogDialog";
import {
  companyPathForPortfolioPage,
  isInstanceSettingsPath,
  portfolioPathForPage,
  resolveScopeChoices,
  resolveScopeExplanation,
  resolveScopeKind,
  resolveScopeLabelText,
  type ScopeChoice,
  type ScopeExplanation,
} from "@/lib/scope-kind";

/**
 * The scope you are in, as a button you can open, and the scopes you can
 * move to.
 *
 * The label on its own answers "where am I" but not "so what". A person
 * looking at HQ cannot tell from the word "HQ" whether they are seeing HQ's
 * own team or every company added together, and that ambiguity is the exact
 * thing the scope layer exists to remove (see
 * docs/plans/2026-09-02-ux-control-center-scope.md). So the label became a
 * button, and opening it spells out in plain words what the scope means,
 * what is inside it, and the rule that stops it borrowing another scope's
 * data. The wording lives in lib/scope-kind.ts next to the classifier that
 * decides which scope you are in, so the two cannot drift apart.
 *
 * It used to explain and nothing more, on the reasoning that companies are
 * already chosen on the rail so a second switcher would be one too many. That
 * held right up until Portfolio needed choosing: Portfolio is not a company,
 * so the rail's company list could never offer it, and the panel that already
 * said "This is not the all company total. Open Portfolio for that." gave no
 * way to open Portfolio. It now lists the scopes underneath the explanation,
 * Portfolio first and HQ below it, exactly as the mockup's own scope picker
 * does. The rail keeps its list; this is the same list plus the one entry the
 * rail cannot hold.
 */
function ScopeButton({
  text,
  explanation,
  choices,
  onChoose,
  withSeparator = false,
}: {
  text: string;
  explanation: ScopeExplanation;
  choices: ScopeChoice[];
  onChoose: (choice: ScopeChoice) => void;
  withSeparator?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Current scope: ${text}`}
            className="group flex min-w-0 shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate">{text}</span>
            <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-60 group-hover:opacity-100" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-80 space-y-3 p-4">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">{explanation.title}</p>
            <p className="text-[13px] leading-snug text-muted-foreground">{explanation.meaning}</p>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
              What it includes
            </p>
            <p className="text-[13px] leading-snug text-foreground/90">{explanation.includes}</p>
          </div>
          <p className="border-t border-border pt-2 text-[12px] leading-snug text-muted-foreground">
            {explanation.guardrail}
          </p>
          {choices.length > 0 && (
            <div className="space-y-1 border-t border-border pt-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                Go to
              </p>
              <div className="-mx-1 max-h-64 overflow-y-auto">
                {choices.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    aria-current={choice.current ? "true" : undefined}
                    onClick={() => {
                      setOpen(false);
                      onChoose(choice);
                    }}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {choice.title}
                      </span>
                      <span className="block text-[12px] leading-snug text-muted-foreground">
                        {choice.description}
                      </span>
                    </span>
                    {choice.current && (
                      <Check
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {withSeparator && <span className="shrink-0 text-muted-foreground/50">·</span>}
    </>
  );
}

type GlobalToolbarContext = { companyId: string | null; companyPrefix: string | null };

function GlobalToolbarPlugins({ context }: { context: GlobalToolbarContext }) {
  const { slots } = usePluginSlots({ slotTypes: ["globalToolbarButton"], companyId: context.companyId });
  const { launchers } = usePluginLaunchers({ placementZones: ["globalToolbarButton"], companyId: context.companyId, enabled: !!context.companyId });
  if (slots.length === 0 && launchers.length === 0) return null;
  return (
    <div className="flex items-center gap-1 shrink-0">
      <PluginSlotOutlet slotTypes={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      <PluginLauncherOutlet placementZones={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
    </div>
  );
}

export function BreadcrumbBar() {
  const { breadcrumbs, mobileToolbar } = useBreadcrumbs();
  const { toggleSidebar, sidebarOpen, isMobile } = useSidebar();
  const { companies, selectedCompanyId, selectedCompany, setSelectedCompanyId } = useCompany();
  const { keyboardShortcutsEnabled } = useGeneralSettings();
  const location = useLocation();
  const navigate = useNavigate();
  const [starterOpen, setStarterOpen] = useState(false);

  // Reads the URL first, falling back to context, see useRouteCompany.ts's
  // own comment for why: CompanyContext's selection updates one render after
  // a cross-company navigation, so reading it directly here could flash the
  // previous company's scope label for a beat. That hook exists specifically
  // because this exact race broke something real once (a documented
  // production incident on the Email page); code-reviewed 2026-09-02 into
  // using it here too rather than repeating the bug in a new place. The
  // "Start work" panel below is handed the same id for the same reason: it
  // creates work in a company, so starting it against a one-render-stale
  // company would file the work in the wrong place.
  const activeCompanyId = useActiveCompanyId();
  const activeCompany = useMemo(
    () => companies.find((c) => c.id === activeCompanyId) ?? null,
    [companies, activeCompanyId],
  );
  const portfolioCompanyCount = useMemo(
    () => companies.filter((c) => !c.isPortfolioRoot && c.status !== "archived").length,
    [companies],
  );

  const scopeKind = useMemo(
    () =>
      resolveScopeKind({
        pathname: location.pathname,
        selectedCompany: activeCompany
          ? { isPortfolioRoot: activeCompany.isPortfolioRoot, kind: activeCompany.kind }
          : null,
      }),
    [location.pathname, activeCompany],
  );
  const scopeLabelText = useMemo(
    () =>
      resolveScopeLabelText({
        scopeKind,
        companyName: activeCompany?.name ?? null,
        portfolioCompanyCount,
      }),
    [scopeKind, activeCompany?.name, portfolioCompanyCount],
  );
  const scopeExplanation = useMemo(
    () =>
      resolveScopeExplanation({
        scopeKind,
        companyName: activeCompany?.name ?? null,
        portfolioCompanyCount,
      }),
    [scopeKind, activeCompany?.name, portfolioCompanyCount],
  );

  const scopeChoices = useMemo(
    () =>
      resolveScopeChoices({
        companies,
        scopeKind,
        activeCompanyId,
        portfolioCompanyCount,
      }),
    [companies, scopeKind, activeCompanyId, portfolioCompanyCount],
  );
  const hqCompany = useMemo(
    () => companies.find((c) => c.isPortfolioRoot && c.status !== "archived") ?? null,
    [companies],
  );

  /**
   * Act on a picked scope.
   *
   * Only two of the three cases need a destination naming. Picking Portfolio
   * does, because Portfolio is a set of pages under HQ's own address rather
   * than a company, so selecting a company alone would not move you. Picking a
   * company while a portfolio page is open does too, for the mirror image of
   * the same reason. Everything else is an ordinary company switch and is left
   * exactly as the rail does it, remembered page and all, so this does not
   * quietly change how switching company behaves.
   */
  const chooseScope = useCallback(
    (choice: ScopeChoice) => {
      if (choice.kind === "portfolio") {
        if (!hqCompany) return;
        setSelectedCompanyId(hqCompany.id, { source: "shortcut" });
        navigate(`/${hqCompany.issuePrefix}${portfolioPathForPage(location.pathname)}`);
        return;
      }
      const company = choice.company;
      if (!company) return;
      if (company.id === activeCompanyId) {
        const leavingPortfolio = companyPathForPortfolioPage(location.pathname);
        const target = leavingPortfolio
          ?? (isInstanceSettingsPath(location.pathname) ? "/dashboard" : null);
        if (!target) return;
        setSelectedCompanyId(company.id, { source: "shortcut" });
        navigate(`/${company.issuePrefix}${target}`);
        return;
      }
      setSelectedCompanyId(company.id);
    },
    [activeCompanyId, hqCompany, location.pathname, navigate, setSelectedCompanyId],
  );

  // The same synthetic key press the sidebar's search button used, and the
  // same one the "/" and Cmd+K shortcuts fire. CommandPalette owns the
  // listener, so the button opens the real palette instead of a second copy
  // of it, and every existing way in keeps working untouched.
  const openSearch = useCallback(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));
  }, []);

  const globalToolbarSlotContext = useMemo(
    () => ({
      companyId: selectedCompanyId ?? null,
      companyPrefix: selectedCompany?.issuePrefix ?? null,
    }),
    [selectedCompanyId, selectedCompany?.issuePrefix],
  );

  // Work is always created inside one company, so the button only appears
  // where the current scope names one. In portfolio scope the active company
  // is HQ purely because portfolio-* pages are mounted under HQ's own prefix,
  // and the scope document's guardrail for that row says creation "requires
  // an explicit target; never silently defaults to HQ", and a primary button
  // that quietly filed portfolio work into HQ would be that exact fault.
  // Instance settings are not a company at all. The sidebar no longer carries
  // its own entry, so in those two places there is no way to start work at
  // all. That is deliberate: pick a company first, then start work in it.
  const canStartWorkHere =
    !!activeCompanyId && scopeKind !== "portfolio" && scopeKind !== "instance";

  const menuLabel = sidebarOpen ? "Hide sidebar" : "Show sidebar";
  const menuButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="mr-2 shrink-0"
          onClick={toggleSidebar}
          aria-label={menuLabel}
          // Layout looks this up to put focus back here when the phone drawer
          // closes, including when the drawer was opened by a swipe and so had
          // no button to remember.
          data-sidebar-toggle="true"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        <span className="inline-flex items-center gap-2">
          <span>{menuLabel}</span>
          {keyboardShortcutsEnabled && (
            <kbd className="rounded border border-border bg-background/60 px-1 font-mono text-[10px] text-muted-foreground">
              [
            </kbd>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  );

  const topBarActions = (
    <div className="flex shrink-0 items-center gap-1 pl-2">
      <GlobalToolbarPlugins context={globalToolbarSlotContext} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground shrink-0 hover:text-foreground"
            onClick={openSearch}
            aria-label="Search"
          >
            <Search className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          <span className="inline-flex items-center gap-2">
            <span>Search</span>
            {keyboardShortcutsEnabled && (
              <kbd className="rounded border border-border bg-background/60 px-1 font-mono text-[10px] text-muted-foreground">
                ⌘K
              </kbd>
            )}
          </span>
        </TooltipContent>
      </Tooltip>
      {canStartWorkHere && (
        <Button
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2.5 text-[13px]"
          onClick={() => setStarterOpen(true)}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span>Start work</span>
        </Button>
      )}
    </div>
  );

  // Mounted closed alongside the bar rather than only while open, so the
  // panel keeps its typed request and drafted plan if you close it by
  // accident. Every query inside it is gated on `open`, so a closed one
  // costs nothing.
  const starterDialog = canStartWorkHere && activeCompanyId ? (
    <StarterCatalogDialog
      companyId={activeCompanyId}
      open={starterOpen}
      onClose={() => setStarterOpen(false)}
    />
  ) : null;

  if (isMobile && mobileToolbar) {
    return (
      <div className="border-b border-border px-2 h-12 shrink-0 flex items-center">
        {mobileToolbar}
      </div>
    );
  }

  const scopeButton = scopeLabelText ? (
    <ScopeButton
      text={scopeLabelText}
      explanation={scopeExplanation}
      choices={scopeChoices}
      onChoose={chooseScope}
      // The middot only makes sense when the scope and the page name sit on
      // one line. On a phone they are stacked, so there is nothing to
      // separate.
      withSeparator={!isMobile && breadcrumbs.length > 0}
    />
  ) : null;

  let pageTitle = null;
  if (breadcrumbs.length === 1) {
    // Single breadcrumb = page title (uppercase)
    pageTitle = (
      <h1 className="min-w-0 truncate text-[13px] font-semibold uppercase tracking-[0.12em] text-foreground/90">
        {breadcrumbs[0].label}
      </h1>
    );
  } else if (breadcrumbs.length > 1) {
    // Multiple breadcrumbs = breadcrumb trail
    pageTitle = (
      <Breadcrumb className="min-w-0 overflow-hidden">
        <BreadcrumbList className="flex-nowrap">
          {breadcrumbs.map((crumb, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return (
              <Fragment key={i}>
                {i > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem className={isLast ? "min-w-0" : "shrink-0"}>
                  {isLast || !crumb.href ? (
                    <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link to={crumb.href}>{crumb.label}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  // On a phone the scope and the page name cannot share a line. The scope
  // button is as wide as the company's name and does not give way, so the
  // page name was being squeezed to nothing and a phone user had no way to
  // tell which page they were on. Stacking them gives each its own line and
  // its own cut-off point, inside the same bar height, and the scope button
  // now shortens its own text with an ellipsis instead of being sliced by the
  // edge of the box it sits in.
  if (isMobile) {
    return (
      <div
        data-testid="top-bar"
        className="border-b border-border px-4 h-12 shrink-0 flex items-center"
      >
        {menuButton}
        <div className="flex min-w-0 flex-1 flex-col justify-center overflow-hidden leading-tight">
          {scopeButton}
          {pageTitle}
        </div>
        {topBarActions}
        {starterDialog}
      </div>
    );
  }

  return (
    <div
      data-testid="top-bar"
      className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center"
    >
      {menuButton}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {scopeButton}
        {pageTitle}
      </div>
      {topBarActions}
      {starterDialog}
    </div>
  );
}
