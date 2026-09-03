import { useMemo } from "react";
import { NavLink, useLocation } from "@/lib/router";
import {
  House,
  CircleDot,
  SquarePen,
  Users,
  Inbox,
  Mail,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { CORE_WORKSPACE_CATALOG } from "@/lib/workspace-catalog";

// Code-reviewed 2026-09-02: three independent review passes flagged that the
// Email entry below was hand-typed (label/icon/route) right next to
// workspace-catalog.ts, the file this same diff introduced specifically so
// destinations like this stop being hand-copied — see its own comment.
// Sourced from there instead so a later label or icon change can't silently
// disagree between the mobile nav and everywhere else that reads the catalog.
// Falls back to a plain Mail icon/label rather than throwing if the entry is
// ever removed from the catalog — that's a real regression
// workspace-catalog.test.ts should catch, not something worth crashing the
// whole mobile shell over.
const emailCatalogEntry = CORE_WORKSPACE_CATALOG.find((entry) => entry.id === "email");

interface MobileBottomNavProps {
  visible: boolean;
}

interface MobileNavLinkItem {
  type: "link";
  to: string;
  label: string;
  icon: typeof House;
  badge?: number;
}

interface MobileNavActionItem {
  type: "action";
  label: string;
  icon: typeof SquarePen;
  onClick: () => void;
}

type MobileNavItem = MobileNavLinkItem | MobileNavActionItem;

export function MobileBottomNav({ visible }: MobileBottomNavProps) {
  const location = useLocation();
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const inboxBadge = useInboxBadge(selectedCompanyId);

  const items = useMemo<MobileNavItem[]>(
    () => [
      { type: "link", to: "/dashboard", label: "Home", icon: House },
      { type: "link", to: "/issues", label: "Issues", icon: CircleDot },
      { type: "action", label: "Create", icon: SquarePen, onClick: () => openNewIssue() },
      { type: "link", to: "/agents/all", label: "Agents", icon: Users },
      {
        type: "link",
        to: "/inbox",
        label: "Inbox",
        icon: Inbox,
        badge: inboxBadge.inbox,
      },
      // Added 2026-09-02 (docs/plans/2026-09-02-ux-control-center-preservation.md
      // B06): Email is the stated #1 daily workflow
      // (2026-09-02-ux-control-center-scope.md) but was completely absent
      // from mobile navigation. Appended rather than swapped in for an
      // existing item, so no current one-tap destination is lost.
      {
        type: "link",
        to: `/${emailCatalogEntry?.routeRoot ?? "email"}`,
        label: emailCatalogEntry?.label ?? "Email",
        icon: emailCatalogEntry?.icon ?? Mail,
      },
    ],
    [openNewIssue, inboxBadge.inbox],
  );

  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 transition-transform duration-200 ease-out md:hidden pb-[env(safe-area-inset-bottom)]",
        visible ? "translate-y-0" : "translate-y-full",
      )}
      aria-label="Mobile navigation"
    >
      <div className="grid h-16 grid-cols-6 px-1">
        {items.map((item) => {
          if (item.type === "action") {
            const Icon = item.icon;
            const active = /\/issues\/new(?:\/|$)/.test(location.pathname);
            return (
              <button
                key={item.label}
                type="button"
                onClick={item.onClick}
                className={cn(
                  "relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-md text-[10px] font-medium transition-colors",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          }

          const Icon = item.icon;
          return (
            <NavLink
              key={item.label}
              to={item.to}
              state={SIDEBAR_SCROLL_RESET_STATE}
              className={({ isActive }) =>
                cn(
                  "relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-md text-[10px] font-medium transition-colors",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <Icon className={cn("h-[18px] w-[18px]", isActive && "stroke-[2.3]")} />
                    {item.badge != null && item.badge > 0 && (
                      <span className="absolute -right-2 -top-2 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    )}
                  </span>
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
