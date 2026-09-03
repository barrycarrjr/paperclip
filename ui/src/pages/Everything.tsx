import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { LayoutGrid, PlugZap } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useActiveCompanyId } from "@/hooks/useRouteCompany";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { usePluginSlots } from "@/plugins/slots";
import { visibleWorkspaceCatalog } from "@/lib/workspace-catalog";

/**
 * Complete discovery: every real destination this company can reach, in one
 * place — the "All workspaces" entry from
 * docs/plans/2026-09-02-ux-control-center-scope.md's primary navigation
 * table. Named "Everything" (Barry's call, 2026-09-03) rather than literally
 * "All workspaces" or "Catalog" to avoid colliding with the existing,
 * unrelated "Workspaces" nav item (isolated execution environments for
 * parallel agent work).
 *
 * Not a replacement for the pinned daily shortcuts already in the sidebar —
 * this is where a less-used destination (or a tool-only plugin with no page
 * of its own) is still reachable, matching F29/A18's "no feature disappears"
 * requirement. Built directly on the same catalog + plugin-slot data the
 * Command Palette search already uses (workspace-catalog.ts, usePluginSlots)
 * rather than a third hand-maintained list.
 *
 * Uses `useActiveCompanyId` (the URL's company), not `useCompany()`'s
 * `selectedCompanyId`/`selectedCompany` directly (2026-09-03, Barry asked
 * whether switching companies could ever leak another company's Portfolio
 * section here). The context selection is synced from the route by an effect
 * in Layout that runs AFTER the render it was triggered by, so the render
 * right after a cross-company switch would otherwise briefly show the
 * PREVIOUS company's `isPortfolioRoot` — meaning a switch away from HQ could
 * flash the Portfolio section on a normal company's Everything page for one
 * frame. `useRouteCompany.ts`'s own comment documents this as a real,
 * previously-measured production incident on the Email page, not a
 * theoretical one.
 */
export function Everything() {
  const { companies } = useCompany();
  const activeCompanyId = useActiveCompanyId();
  const activeCompany = useMemo(
    () => companies.find((company) => company.id === activeCompanyId) ?? null,
    [companies, activeCompanyId],
  );
  const { setBreadcrumbs } = useBreadcrumbs();
  const isPortfolioRoot = activeCompany?.isPortfolioRoot ?? false;

  useEffect(() => {
    setBreadcrumbs([{ label: "Everything" }]);
  }, [setBreadcrumbs]);

  const catalogEntries = useMemo(
    () => visibleWorkspaceCatalog({ isPortfolioRoot }),
    [isPortfolioRoot],
  );
  const corePages = useMemo(
    () => catalogEntries.filter((entry) => !entry.portfolioRootOnly),
    [catalogEntries],
  );
  const portfolioPages = useMemo(
    () => catalogEntries.filter((entry) => entry.portfolioRootOnly),
    [catalogEntries],
  );

  const { slots: pluginPageSlots } = usePluginSlots({
    slotTypes: ["page"],
    companyId: activeCompanyId,
  });
  const routablePluginSlots = useMemo(
    () => pluginPageSlots.filter((slot) => slot.routePath),
    [pluginPageSlots],
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 md:px-6">
      <div className="mb-8 flex items-center gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-muted/40">
          <LayoutGrid className="h-5 w-5 text-muted-foreground" />
        </span>
        <div>
          <h1 className="text-xl font-semibold">Everything</h1>
          <p className="text-sm text-muted-foreground">
            Every workspace this company can reach — including the ones not pinned to the sidebar.
          </p>
        </div>
      </div>

      <EverythingSection title="Pages">
        {corePages.map((entry) => (
          <EverythingCard key={entry.id} to={`/${entry.routeRoot}`} label={entry.label} icon={entry.icon} />
        ))}
      </EverythingSection>

      {routablePluginSlots.length > 0 && (
        <EverythingSection title="Plugins">
          {routablePluginSlots.map((slot) => (
            <EverythingCard
              key={`${slot.pluginKey}:${slot.id}`}
              to={`/${slot.routePath}`}
              label={slot.displayName}
              sublabel={slot.pluginDisplayName}
              icon={PlugZap}
            />
          ))}
        </EverythingSection>
      )}

      {portfolioPages.length > 0 && (
        <EverythingSection title="Portfolio">
          {portfolioPages.map((entry) => (
            <EverythingCard key={entry.id} to={`/${entry.routeRoot}`} label={entry.label} icon={entry.icon} />
          ))}
        </EverythingSection>
      )}
    </div>
  );
}

function EverythingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">{children}</div>
    </div>
  );
}

function EverythingCard({
  to,
  label,
  sublabel,
  icon: Icon,
}: {
  to: string;
  label: string;
  sublabel?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2.5 text-sm transition-colors hover:bg-accent/50 hover:border-accent-foreground/20"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {sublabel && <span className="block truncate text-xs text-muted-foreground">{sublabel}</span>}
      </span>
    </Link>
  );
}
