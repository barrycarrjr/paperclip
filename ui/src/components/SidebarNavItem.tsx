import { NavLink, useNavigate } from "@/lib/router";
import { applyCompanyPrefix } from "@/lib/company-routes";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebarPeek } from "../context/SidebarPeekContext";
import { SidebarInfoButton } from "./SidebarInfoButton";
import type { LucideIcon } from "lucide-react";

interface SidebarNavItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  className?: string;
  badge?: number;
  badgeTone?: "default" | "danger";
  textBadge?: string;
  textBadgeTone?: "default" | "amber";
  alert?: boolean;
  liveCount?: number;
  info?: string;
}

export function SidebarNavItem({
  to,
  label,
  icon: Icon,
  end,
  className,
  badge,
  badgeTone = "default",
  textBadge,
  textBadgeTone = "default",
  alert = false,
  liveCount,
  info,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const peek = useSidebarPeek();
  const { companies, setSelectedCompanyId } = useCompany();
  const navigate = useNavigate();

  const baseClassName = cn(
    "relative flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
    "text-foreground/75 hover:bg-accent/50 hover:text-foreground",
    info && "pr-8",
    className,
  );

  const innerChildren = (
    <>
      <span className={cn("relative shrink-0", "[&_svg]:transition-colors")}>
        <Icon className="h-4 w-4" />
        {alert && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
        )}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {textBadge && (
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
            textBadgeTone === "amber"
              ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          {textBadge}
        </span>
      )}
      {liveCount != null && liveCount > 0 && (
        <span className="ml-auto flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
          <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">{liveCount} live</span>
        </span>
      )}
      {badge != null && badge > 0 && (
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-xs leading-none",
            badgeTone === "danger"
              ? "bg-red-600/90 text-red-50"
              : "bg-primary text-primary-foreground",
          )}
        >
          {badge}
        </span>
      )}
    </>
  );

  // In peek mode (rendered inside a CompanyRail hover flyout), the menu is
  // showing a different company than the one currently selected. Clicking an
  // item must switch the selected company *before* navigating — otherwise the
  // bare path (`/brief`, `/inbox`) would render against the still-selected
  // company. Skip NavLink's active-state styling: no item is "active" from the
  // peeked company's perspective.
  //
  // Code-reviewed 2026-09-02: setSelectedCompanyId(...) then navigate(to)
  // looked like it did this, but didn't. setSelectedCompanyId only queues a
  // state update; the very next line's navigate(to) still runs with the
  // *current* page's company prefix, because our navigate wrapper
  // (lib/router.tsx's useNavigate) resolves that prefix from the URL/route
  // params at the top of THIS render, not from peek.peekCompanyId — there is
  // no synchronous link between the two. The comment above already named the
  // exact risk ("otherwise the bare path would render against the
  // still-selected company") without the fix actually closing it: clicking
  // Clippy from a peeked company's flyout silently opened the CURRENT
  // company's Clippy instead, with no visible error (the resulting URL is a
  // normal, single-prefixed, working page, so it doesn't look broken at a
  // glance — this is how it passed an earlier live check that only looked
  // for the double-prefix symptom this same routing work fixed elsewhere).
  // The fix is to resolve the peeked company's own prefix explicitly here
  // and navigate to that exact path, instead of trusting the wrapper to
  // infer it from ambient state that hasn't caught up yet.
  if (peek) {
    const link = (
      <a
        href={to}
        onClick={(e) => {
          e.preventDefault();
          setSelectedCompanyId(peek.peekCompanyId, { source: "shortcut" });
          const peekedCompany = companies.find((company) => company.id === peek.peekCompanyId);
          navigate(peekedCompany ? applyCompanyPrefix(to, peekedCompany.issuePrefix) : to);
          peek.onItemClick?.();
          if (isMobile) setSidebarOpen(false);
        }}
        className={baseClassName}
      >
        {innerChildren}
      </a>
    );

    if (!info) return link;
    return (
      <div className="group relative">
        {link}
        <SidebarInfoButton
          title={label}
          info={info}
          className="absolute right-2 top-1/2 -translate-y-1/2"
        />
      </div>
    );
  }

  const link = (
    <NavLink
      to={to}
      state={SIDEBAR_SCROLL_RESET_STATE}
      end={end}
      onClick={() => { if (isMobile) setSidebarOpen(false); }}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
          isActive
            ? "bg-accent text-foreground before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[2px] before:-translate-y-1/2 before:bg-foreground before:content-['']"
            : "text-foreground/75 hover:bg-accent/50 hover:text-foreground",
          info && "pr-8",
          className,
        )
      }
    >
      {innerChildren}
    </NavLink>
  );

  if (!info) return link;

  return (
    <div className="group relative">
      {link}
      <SidebarInfoButton
        title={label}
        info={info}
        className="absolute right-2 top-1/2 -translate-y-1/2"
      />
    </div>
  );
}
