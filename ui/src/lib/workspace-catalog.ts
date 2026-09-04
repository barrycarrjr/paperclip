import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Boxes,
  Brain,
  CalendarClock,
  CircleDot,
  DollarSign,
  GitBranch,
  Globe2,
  Hexagon,
  History,
  Inbox,
  Mail,
  Megaphone,
  MessageSquare,
  Network,
  Receipt,
  Repeat,
  ShieldCheck,
  Sunrise,
  Target,
  UserCog,
  ListTodo,
} from "lucide-react";

/**
 * Static catalog of core (non-plugin) destinations, for anything that needs
 * to list "the real workspaces this app has" without hand-copying route
 * paths and labels yet again — see docs/plans/2026-09-02-ux-control-center-implementation.md
 * P1's third bullet ("host-owned workspace/navigation description").
 *
 * This is a first, narrower version of that idea: it only covers the pages
 * worth surfacing in a catalog/search context (CommandPalette today), not
 * every field that bullet eventually wants (pin state, capability
 * restrictions, local sub-navigation). Deliberately excludes pure redirects
 * (e.g. "/dashboard" -> "/brief"), deeply-nested detail routes (issue/agent
 * detail — reached via search results, not this list), and settings/admin
 * surfaces already reachable through the company/instance menus (adding
 * those here is future scope, not a gap this slice claims to close).
 *
 * Plugin-contributed pages are NOT listed here — they're already available
 * with real labels via usePluginSlots({ slotTypes: ["page"] }) in
 * ui/src/plugins/slots.tsx; combine that with this list rather than
 * duplicating plugin metadata into a second registry.
 *
 * routeRoot values must stay valid company-scoped route roots — every entry
 * here should also exist in boardRoutes() (App.tsx) and, via that,
 * PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS (packages/shared/src/constants.ts).
 * The routeRoot half of that is now enforced by workspace-catalog.test.ts
 * ("every routeRoot is a real registered board route").
 *
 * Labels and icons here must match what the sidebar (SidebarMenu.tsx) and
 * every other surface already call the same destination — this file is not
 * license to rename anything. Code-reviewed 2026-09-02: a first version used
 * "Attention" for Inbox and "Automations" for Routines, anticipating labels
 * this project's own preservation doc names as a FUTURE, not-yet-approved
 * rename target (F04, F17) — while every other surface, including this same
 * diff's own MobileBottomNav.tsx and its test, still said "Inbox". That's a
 * product/labeling decision for Barry to make once, consistently, everywhere
 * at once — not something to smuggle in as a side effect of fixing search
 * completeness, and not safe to do inconsistently within a single diff. If
 * that rename ever happens, it needs to land here, in SidebarMenu.tsx, and
 * in the destination pages' own headers together.
 */
export interface WorkspaceCatalogEntry {
  id: string;
  label: string;
  routeRoot: string;
  icon: LucideIcon;
  /** Only rendered when the selected company is the portfolio root (HQ). */
  portfolioRootOnly?: boolean;
  /**
   * A switch that has to be on before this workspace does anything.
   *
   * Only set where a real, checkable condition exists in the app today. Most
   * core workspaces have none: they work for every company, and inventing a
   * requirement for them would be guessing at product behaviour rather than
   * describing it. Plugin-backed availability (a mailbox, a PBX account)
   * is deliberately NOT modelled here — those pages already know their own
   * setup rules and say so better than a generic flag could.
   */
  requires?: WorkspaceRequirement;
}

/**
 * The conditions this catalog can actually check.
 *
 * A closed union rather than a free string, so a consumer that forgets to
 * handle a new one fails to compile instead of silently treating the
 * workspace as available.
 */
export type WorkspaceRequirement = "isolatedWorkspaces";

export interface WorkspaceAvailabilityInput {
  /** Instance experimental setting `enableIsolatedWorkspaces`. */
  isolatedWorkspacesEnabled: boolean;
}

/**
 * Whether a workspace can be used right now.
 *
 * Undefined input is treated as NOT available on purpose. The settings query
 * is still in flight on a cold load, and briefly offering a destination that
 * then turns out to be off is worse than briefly not offering one: the first
 * sends someone somewhere that cannot help them, the second corrects itself
 * a moment later.
 */
export function isWorkspaceAvailable(
  entry: WorkspaceCatalogEntry,
  input: Partial<WorkspaceAvailabilityInput> | null | undefined,
): boolean {
  if (!entry.requires) return true;
  switch (entry.requires) {
    case "isolatedWorkspaces":
      return input?.isolatedWorkspacesEnabled === true;
    default: {
      // Exhaustiveness guard: a new requirement must be handled above rather
      // than defaulting to "available".
      const unhandled: never = entry.requires;
      void unhandled;
      return false;
    }
  }
}

/** Plain sentence for why a workspace is not usable, or null when it is. */
export function workspaceUnavailableReason(
  entry: WorkspaceCatalogEntry,
  input: Partial<WorkspaceAvailabilityInput> | null | undefined,
): string | null {
  if (isWorkspaceAvailable(entry, input)) return null;
  switch (entry.requires) {
    case "isolatedWorkspaces":
      return "Isolated workspaces are switched off for this instance.";
    default:
      return "This is not available here.";
  }
}

export const CORE_WORKSPACE_CATALOG: WorkspaceCatalogEntry[] = [
  { id: "brief", label: "Brief", routeRoot: "brief", icon: Sunrise },
  { id: "email", label: "Email", routeRoot: "email", icon: Mail },
  { id: "inbox", label: "Inbox", routeRoot: "inbox", icon: Inbox },
  { id: "calendar", label: "Calendar", routeRoot: "calendar", icon: CalendarClock },
  { id: "issues", label: "Issues", routeRoot: "issues", icon: CircleDot },
  { id: "projects", label: "Projects", routeRoot: "projects", icon: Hexagon },
  { id: "goals", label: "Goals", routeRoot: "goals", icon: Target },
  { id: "routines", label: "Routines", routeRoot: "routines", icon: Repeat },
  { id: "work-queues", label: "Work queues", routeRoot: "work-queues", icon: ListTodo },
  { id: "agents", label: "Agents", routeRoot: "agents", icon: Bot },
  // Added 2026-09-03 (P4 audit): had a dedicated sidebar entry but no
  // presence in Command Palette or Everything at all.
  { id: "org", label: "Org chart", routeRoot: "org", icon: Network },
  { id: "assistants", label: "Assistants", routeRoot: "assistants", icon: UserCog },
  // Added 2026-09-03 (P4 audit): the route is always registered, but had no
  // catalog/search presence even when the experimental flag that gates it
  // (enableIsolatedWorkspaces) is on.
  //
  // Corrected 2026-09-04: it was listed unconditionally, on the reasoning
  // that the page redirects to /issues when the flag is off so nothing
  // breaks. Nothing breaks, but the sidebar hides this entry when the flag
  // is off (SidebarMenu.tsx) while search and Everything kept offering it,
  // and clicking it landed you on Issues with no explanation. Silently
  // sending someone somewhere else is exactly what the scope document rules
  // out ("Unsupported access shows a clear unavailable/setup/permission
  // state"), so the requirement is declared here and every surface reads it.
  { id: "workspaces", label: "Workspaces", routeRoot: "workspaces", icon: GitBranch, requires: "isolatedWorkspaces" },
  { id: "clippy", label: "Clippy", routeRoot: "clippy", icon: MessageSquare },
  { id: "memories", label: "Memories", routeRoot: "memories", icon: Brain },
  { id: "skills", label: "Skills", routeRoot: "skills", icon: Boxes },
  { id: "approvals", label: "Approvals", routeRoot: "approvals", icon: ShieldCheck },
  { id: "receipts", label: "Receipts", routeRoot: "receipts", icon: Receipt },
  { id: "costs", label: "Costs", routeRoot: "costs", icon: DollarSign },
  { id: "activity", label: "Activity", routeRoot: "activity", icon: History },
  { id: "portfolio-brief", label: "Portfolio Brief", routeRoot: "portfolio-brief", icon: Sunrise, portfolioRootOnly: true },
  { id: "portfolio-email", label: "Portfolio Email", routeRoot: "portfolio-email", icon: Mail, portfolioRootOnly: true },
  { id: "portfolio-issues", label: "Portfolio Issues", routeRoot: "portfolio-issues", icon: Globe2, portfolioRootOnly: true },
  { id: "portfolio-directives", label: "Portfolio Directives", routeRoot: "portfolio-directives", icon: Megaphone, portfolioRootOnly: true },
  { id: "portfolio-agents", label: "Portfolio Agents", routeRoot: "portfolio-agents", icon: Bot, portfolioRootOnly: true },
  { id: "portfolio-approvals", label: "Portfolio Approvals", routeRoot: "portfolio-approvals", icon: ShieldCheck, portfolioRootOnly: true },
  { id: "portfolio-routines", label: "Portfolio Routines", routeRoot: "portfolio-routines", icon: Repeat, portfolioRootOnly: true },
  { id: "portfolio-calendar", label: "Portfolio Calendar", routeRoot: "portfolio-calendar", icon: CalendarClock, portfolioRootOnly: true },
  { id: "portfolio-receipts", label: "Portfolio Receipts", routeRoot: "portfolio-receipts", icon: Receipt, portfolioRootOnly: true },
  { id: "portfolio-activity", label: "Portfolio Activity", routeRoot: "portfolio-activity", icon: History, portfolioRootOnly: true },
  { id: "portfolio-costs", label: "Portfolio Costs", routeRoot: "portfolio-costs", icon: DollarSign, portfolioRootOnly: true },
];

/**
 * The workspaces worth offering right now.
 *
 * `availability` is optional so existing callers keep working, but passing it
 * is what stops search and the Everything page offering a destination the
 * sidebar has already hidden.
 */
export function visibleWorkspaceCatalog(params: {
  isPortfolioRoot: boolean;
  availability?: Partial<WorkspaceAvailabilityInput> | null;
}): WorkspaceCatalogEntry[] {
  return CORE_WORKSPACE_CATALOG.filter((entry) => {
    if (entry.portfolioRootOnly && !params.isPortfolioRoot) return false;
    // Entries with no requirement are unaffected, so omitting `availability`
    // only ever leaves the gated ones out — never adds something new.
    if (params.availability !== undefined && !isWorkspaceAvailable(entry, params.availability)) {
      return false;
    }
    return true;
  });
}

/** Look up a catalog entry by the first segment of a company-relative path. */
export function workspaceCatalogEntryForRouteRoot(
  routeRoot: string,
): WorkspaceCatalogEntry | null {
  const normalized = routeRoot.replace(/^\/+/, "").split("/")[0]?.toLowerCase();
  if (!normalized) return null;
  return CORE_WORKSPACE_CATALOG.find((entry) => entry.routeRoot === normalized) ?? null;
}

export interface PinnedWorkspaceItem {
  id: string;
  label: string;
  /** Company-relative; the router adds the company prefix. */
  to: string;
  icon: LucideIcon;
  info?: string;
}

/**
 * Turn a person's pinned ids into the items a company can actually show.
 *
 * Pins are stored per user, so the same list is asked about in every company.
 * Three things are therefore dropped rather than rendered: a portfolio-only
 * page outside HQ, a workspace whose requirement is not met, and a plugin page
 * this company does not have. Dropping is right and un-pinning would not be —
 * the pin is still correct for the companies where it works, and silently
 * editing someone's saved list because they visited a different company would
 * lose a setting they never changed.
 *
 * Order follows the person's list, not the catalog's, because they chose it.
 * Anything unrecognised is skipped, so a stale pin left by a removed plugin
 * disappears quietly instead of rendering a dead link.
 */
export function resolvePinnedWorkspaceItems(params: {
  pinned: string[];
  isPortfolioRoot: boolean;
  availability?: Partial<WorkspaceAvailabilityInput> | null;
  pluginSlots: { routePath: string | null; displayName: string }[];
}): PinnedWorkspaceItem[] {
  const { pinned, isPortfolioRoot, availability, pluginSlots } = params;
  if (pinned.length === 0) return [];

  const coreById = new Map(CORE_WORKSPACE_CATALOG.map((entry) => [entry.id, entry]));
  const pluginByRoute = new Map(
    pluginSlots
      .filter((slot): slot is { routePath: string; displayName: string } => Boolean(slot.routePath))
      .map((slot) => [slot.routePath, slot]),
  );

  const items: PinnedWorkspaceItem[] = [];
  const seen = new Set<string>();

  for (const id of pinned) {
    if (seen.has(id)) continue;
    seen.add(id);

    const core = coreById.get(id);
    if (core) {
      if (core.portfolioRootOnly && !isPortfolioRoot) continue;
      if (!isWorkspaceAvailable(core, availability)) continue;
      items.push({
        id: core.id,
        label: core.label,
        to: `/${core.routeRoot}`,
        icon: core.icon,
        info: `Pinned. ${core.label} for this company.`,
      });
      continue;
    }

    const plugin = pluginByRoute.get(id);
    if (plugin) {
      items.push({
        id,
        label: plugin.displayName,
        to: `/${id}`,
        icon: Boxes,
        info: `Pinned. Provided by a plugin.`,
      });
    }
  }

  return items;
}
