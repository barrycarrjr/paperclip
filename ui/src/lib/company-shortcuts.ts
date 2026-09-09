import type { LucideIcon } from "lucide-react";
import { Bot, CalendarClock, CircleDot, Mail, Phone } from "lucide-react";
import { workspaceCatalogEntryForRouteRoot } from "./workspace-catalog";
import { TEAM_ROUTE_ROOT } from "./team-tabs";
import { WORK_ROUTE_ROOT } from "./work-tabs";

/**
 * The shortcut buttons on the company rail's hover menu.
 *
 * The rail is the narrow strip of company logos down the far left. Hovering a
 * logo used to draw that company's whole menu, which was richer than the
 * mockup and slower to read; the mockup shows the company's name, one line
 * saying what the company is, and five buttons. See
 * docs/plans/2026-09-07-mockup-vs-app.md, difference 12, and the scope
 * document's "A stable scope layer", which asks for the compact rail and its
 * hover shortcuts to stay as a fast path.
 *
 * The mockup's five are Email, Calendar, Team, Work and Phone. Four of those
 * are core pages and one, Phone, is an add-on, so the set is worked out per
 * company rather than being a fixed list:
 *
 * - Email is left out of HQ and out of any company with no mailbox, which is
 *   exactly what the main menu does (SidebarMenu.tsx's showEmailNav).
 * - Calendar is left out of HQ, again matching the main menu: HQ has no
 *   calendar of its own.
 * - Team and Work are always offered. Each is now one page with tabs.
 * - Phone only appears where the Phone add-on is installed AND covers this
 *   company, and it points at a page the add-on really registered. A button
 *   that leads nowhere is worse than no button.
 *
 * Labels are read from the workspace catalog wherever the catalog has an
 * entry, the same rule work-tabs.ts and team-tabs.ts follow, so a shortcut
 * cannot end up calling a destination something different from the menu, the
 * search box and the page's own heading. Icons are the ones the main menu uses
 * for the same destination, so a shortcut looks like the menu line it stands
 * in for.
 */
export interface CompanyShortcut {
  /** Stable key, and the route root wherever there is one. */
  id: string;
  label: string;
  /** Company relative. Whatever renders it adds the company's prefix. */
  to: string;
  icon: LucideIcon;
}

/**
 * Pages the Phone add-on contributes, in the order its own menu lists them.
 *
 * There is no single "/phone" page to point at. Phone is a group of pages
 * contributed by the PBX add-on (Active calls, Queues, Call history and the
 * rest), so the shortcut opens the first one that is actually installed.
 * Listing them in the add-on's own order means the button lands where its
 * menu would have taken you, and an install missing all of them gets no
 * button at all instead of a dead link.
 */
export const PHONE_LANDING_ROUTE_PATHS = [
  "phone-active-calls",
  "phone-queues",
  "phone-call-history",
  "recordings",
];

export interface PhoneAddOnState {
  /** The routePath of every page installed add-ons contribute. */
  installedRoutePaths: string[];
  /** True when a phone account covers this company. */
  coversCompany: boolean;
}

/**
 * Where the Phone shortcut goes, or null when there should be no button.
 *
 * Null in three cases, all of which mean the same thing to a person: the
 * add-on is not installed, it is installed but no phone account covers this
 * company, or it is installed but registered none of the pages above.
 */
export function resolvePhoneShortcutPath(phone: PhoneAddOnState): string | null {
  if (!phone.coversCompany) return null;
  const installed = new Set(phone.installedRoutePaths);
  const landing = PHONE_LANDING_ROUTE_PATHS.find((routePath) => installed.has(routePath));
  return landing ? `/${landing}` : null;
}

function catalogLabel(routeRoot: string, fallback: string): string {
  // Falls back rather than throwing if the catalog entry ever disappears, for
  // the same reason work-tabs.ts does: a missing entry is a regression for a
  // test to catch, not a reason to take the whole rail down.
  return workspaceCatalogEntryForRouteRoot(routeRoot)?.label ?? fallback;
}

export function resolveCompanyShortcuts(params: {
  isPortfolioRoot: boolean;
  hasMailbox: boolean;
  phone: PhoneAddOnState;
}): CompanyShortcut[] {
  const { isPortfolioRoot, hasMailbox, phone } = params;
  const shortcuts: CompanyShortcut[] = [];

  if (hasMailbox && !isPortfolioRoot) {
    shortcuts.push({
      id: "email",
      label: catalogLabel("email", "Email"),
      to: "/email",
      icon: Mail,
    });
  }

  if (!isPortfolioRoot) {
    shortcuts.push({
      id: "calendar",
      label: catalogLabel("calendar", "Calendar"),
      to: "/calendar",
      icon: CalendarClock,
    });
  }

  shortcuts.push({
    id: TEAM_ROUTE_ROOT,
    label: catalogLabel(TEAM_ROUTE_ROOT, "Team"),
    to: `/${TEAM_ROUTE_ROOT}`,
    icon: Bot,
  });

  shortcuts.push({
    // "Work" is not in the workspace catalog: /work is a front door that opens
    // the first of five real pages, and the catalog lists those five. So the
    // label is written here, and it has to stay the same word SidebarMenu.tsx
    // uses for the same entry.
    id: WORK_ROUTE_ROOT,
    label: "Work",
    to: `/${WORK_ROUTE_ROOT}`,
    icon: CircleDot,
  });

  const phonePath = resolvePhoneShortcutPath(phone);
  if (phonePath) {
    shortcuts.push({
      // The add-on calls this group Phone in its own menu, so the shortcut
      // does too.
      id: "phone",
      label: "Phone",
      to: phonePath,
      icon: Phone,
    });
  }

  return shortcuts;
}
