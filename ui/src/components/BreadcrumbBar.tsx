import { Link, useLocation } from "@/lib/router";
import { Menu } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
import { useGeneralSettings } from "../context/GeneralSettingsContext";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Fragment, useMemo } from "react";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";
import { resolveScopeKind, type ScopeKind } from "@/lib/scope-kind";

/**
 * Text for the small, secondary label showing which of the operating
 * contexts from docs/plans/2026-09-02-ux-control-center-scope.md the current
 * page is in — separate from the page title next to it, which only ever said
 * what page you're on, never what scope (a portfolio-wide page and HQ's own
 * page look identical there, both mounted under the same /HQ/... prefix).
 * Confirmed live by Barry 2026-09-02 that nothing in the header told them
 * apart. Returns null when there's nothing to show yet (e.g. no company has
 * resolved), so callers can skip rendering the label and its separator both.
 *
 * companyCount must already exclude HQ itself and archived companies — the
 * same filter every other portfolio-count display in the app uses
 * (PortfolioBrief.tsx, PortfolioCosts.tsx: `.filter(c => !c.isPortfolioRoot
 * && c.status !== "archived")`). Code-reviewed 2026-09-02: an earlier version
 * passed the raw, unfiltered list, which both overcounted against every
 * other portfolio company count in the app and mis-pluralized "1 companies".
 */
function resolveScopeLabelText(params: {
  scopeKind: ScopeKind;
  companyName: string | null;
  portfolioCompanyCount: number;
}): string | null {
  const { scopeKind, companyName, portfolioCompanyCount } = params;
  switch (scopeKind) {
    case "portfolio":
      if (portfolioCompanyCount <= 0) return "Portfolio";
      return `Portfolio · ${portfolioCompanyCount} compan${portfolioCompanyCount === 1 ? "y" : "ies"}`;
    case "instance":
      return "Instance settings";
    case "personal":
      return companyName || "Personal";
    case "hq":
    case "company":
      return companyName || null;
  }
}

function ScopeLabel({ text, withSeparator = false }: { text: string; withSeparator?: boolean }) {
  return (
    <>
      <span className="shrink-0 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {text}
      </span>
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
    <div className="flex items-center gap-1 ml-auto shrink-0 pl-2">
      <PluginSlotOutlet slotTypes={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      <PluginLauncherOutlet placementZones={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
    </div>
  );
}

export function BreadcrumbBar() {
  const { breadcrumbs, mobileToolbar } = useBreadcrumbs();
  const { toggleSidebar, sidebarOpen, isMobile } = useSidebar();
  const { companies, selectedCompanyId, selectedCompany } = useCompany();
  const { keyboardShortcutsEnabled } = useGeneralSettings();
  const location = useLocation();

  // Reads the URL first, falling back to context — see useRouteCompany.ts's
  // own comment for why: CompanyContext's selection updates one render after
  // a cross-company navigation, so reading it directly here could flash the
  // previous company's scope label for a beat. That hook exists specifically
  // because this exact race broke something real once (a documented
  // production incident on the Email page); code-reviewed 2026-09-02 into
  // using it here too rather than repeating the bug in a new place.
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

  const globalToolbarSlotContext = useMemo(
    () => ({
      companyId: selectedCompanyId ?? null,
      companyPrefix: selectedCompany?.issuePrefix ?? null,
    }),
    [selectedCompanyId, selectedCompany?.issuePrefix],
  );

  const globalToolbarSlots = <GlobalToolbarPlugins context={globalToolbarSlotContext} />;

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

  if (isMobile && mobileToolbar) {
    return (
      <div className="border-b border-border px-2 h-12 shrink-0 flex items-center">
        {mobileToolbar}
      </div>
    );
  }

  if (breadcrumbs.length === 0) {
    return (
      <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center gap-2">
        {menuButton}
        {scopeLabelText && <ScopeLabel text={scopeLabelText} />}
        <div className="ml-auto">{globalToolbarSlots}</div>
      </div>
    );
  }

  // Single breadcrumb = page title (uppercase)
  if (breadcrumbs.length === 1) {
    return (
      <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center">
        {menuButton}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {scopeLabelText && <ScopeLabel text={scopeLabelText} withSeparator />}
          <h1 className="min-w-0 truncate text-[13px] font-semibold uppercase tracking-[0.12em] text-foreground/90">
            {breadcrumbs[0].label}
          </h1>
        </div>
        {globalToolbarSlots}
      </div>
    );
  }

  // Multiple breadcrumbs = breadcrumb trail
  return (
    <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center">
      {menuButton}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {scopeLabelText && <ScopeLabel text={scopeLabelText} withSeparator />}
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
      </div>
      {globalToolbarSlots}
    </div>
  );
}
