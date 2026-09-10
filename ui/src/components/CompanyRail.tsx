import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, Plus } from "lucide-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  DndContext,
  closestCenter,
  MouseSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { heartbeatsApi } from "../api/heartbeats";
import { authApi } from "../api/auth";
import { useCompanyOrder } from "../hooks/useCompanyOrder";
import { useLocation, useNavigate } from "@/lib/router";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import type { Company } from "@paperclipai/shared";
import { CompanyPatternIcon } from "./CompanyPatternIcon";
import { isLiveRunStatus } from "../lib/liveIssueIds";
// SidebarMenu is no longer drawn inside the rail's flyout (see
// CompanyPeekContent below). Its peek mode is left in place so the whole menu
// can be put back here in one edit if the short list turns out to be too
// short.
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarSection } from "./SidebarSection";
import { SidebarPeekProvider } from "../context/SidebarPeekContext";
import { useEmailToolsPlugin } from "../hooks/useEmailToolsPlugin";
import { usePhoneToolsPlugin } from "../hooks/usePhoneToolsPlugin";
import { useRememberedCompanyPage } from "../hooks/useRememberedCompanyPage";
import { usePluginSlots } from "../plugins/slots";
import { resolveCompanyShortcuts } from "../lib/company-shortcuts";
import {
  companyPathForPortfolioPage,
  resolveScopeChoiceDescription,
} from "../lib/scope-kind";

/**
 * Body of the panel that opens beside a company logo on the rail.
 *
 * It shows the company's full name, one line saying what that company is, the
 * page you last had open in it, and a short list of shortcut buttons. That is
 * the shape the mockup asks for (docs/plans/2026-09-07-mockup-vs-app.md,
 * difference 12); it used to be the company's whole menu, which was richer
 * than the mockup and slower to read.
 *
 * The one line note is the same sentence the company picker in the top bar
 * uses for the same company, so the two cannot end up describing a company
 * differently.
 *
 * "Where you left off" stays. Switching company now keeps you on the page you
 * are reading, so this row is the only explicit way back to the page a company
 * had open last time you were in it, and the scope document allows it on
 * exactly those terms.
 *
 * Every row is a SidebarNavItem inside a SidebarPeekProvider, which is what
 * makes a click here switch to this company with the "shortcut" source. That
 * source is what stops the remembered page overriding where you asked to go.
 */
function CompanyPeekContent({
  company,
  portfolioCompanyCount,
  onItemClick,
}: {
  company: Company;
  portfolioCompanyCount: number;
  onItemClick: () => void;
}) {
  const location = useLocation();
  const isPortfolioRoot = company.isPortfolioRoot === true;
  const { hasMailboxForCompany } = useEmailToolsPlugin(company.id);
  const { hasAccountForCompany } = usePhoneToolsPlugin(company.id);
  const { slots: pluginPageSlots } = usePluginSlots({
    slotTypes: ["page"],
    companyId: company.id,
  });
  const shortcuts = useMemo(
    () =>
      resolveCompanyShortcuts({
        isPortfolioRoot,
        hasMailbox: hasMailboxForCompany,
        phone: {
          installedRoutePaths: pluginPageSlots
            .map((slot) => slot.routePath)
            .filter((routePath): routePath is string => !!routePath),
          coversCompany: hasAccountForCompany,
        },
      }),
    [isPortfolioRoot, hasMailboxForCompany, hasAccountForCompany, pluginPageSlots],
  );
  const rememberedPage = useRememberedCompanyPage(company, location.pathname);
  const note = resolveScopeChoiceDescription({
    scopeKind: isPortfolioRoot ? "hq" : company.kind === "personal" ? "personal" : "company",
    companyName: company.name,
    portfolioCompanyCount,
  });

  return (
    <SidebarPeekProvider peekCompanyId={company.id} onItemClick={onItemClick}>
      <div className="border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          {company.brandColor ? (
            <span
              className="size-3.5 shrink-0 rounded-sm"
              style={{ backgroundColor: company.brandColor }}
            />
          ) : null}
          <span className="truncate text-sm font-semibold text-foreground">
            {company.name}
          </span>
          {isPortfolioRoot && (
            <span className="ml-auto text-[10px] uppercase tracking-[0.1em] text-muted-foreground/80">
              Root
            </span>
          )}
          {company.kind === "personal" && (
            // Worth saying out loud. Personal looks like every other company in
            // this list, and the one thing that matters about it, that nobody
            // else can see it, is invisible otherwise.
            <span
              className="ml-auto text-[10px] uppercase tracking-[0.1em] text-muted-foreground/80"
              title="Private to you. Nobody else on this instance can see it, including administrators."
            >
              Private
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{note}</p>
      </div>
      {rememberedPage && (
        <div className="border-b border-border py-2">
          <SidebarSection
            label="Where you left off"
            info="The last page you had open in this company. Clicking the company logo itself keeps you on the page you are reading instead."
          >
            <SidebarNavItem
              to={rememberedPage.to}
              label={rememberedPage.pageLabel ?? "The page you had open"}
              icon={rememberedPage.icon}
            />
          </SidebarSection>
        </div>
      )}
      <nav
        className="flex flex-col gap-0.5 py-2"
        aria-label={`Shortcuts for ${company.name}`}
      >
        {shortcuts.map((shortcut) => (
          <SidebarNavItem
            key={shortcut.id}
            to={shortcut.to}
            label={shortcut.label}
            icon={shortcut.icon}
          />
        ))}
      </nav>
    </SidebarPeekProvider>
  );
}

/** How a panel came to be open, which decides whether it takes focus. */
type PeekOpenedBy = "pointer" | "keyboard" | "touch";

/** How long the pointer rests on a logo before the panel opens. */
const PEEK_OPEN_DELAY_MS = 500;
/** Grace period so the pointer can travel from the logo across to the panel. */
const PEEK_CLOSE_DELAY_MS = 200;
/** How long a finger stays down before the panel opens. */
const PEEK_LONG_PRESS_MS = 500;

/**
 * The state and the event handlers for one company logo's shortcut panel.
 *
 * The panel is only offered when the wide menu is not already on screen beside
 * the rail, because then the same destinations are two clicks away in plain
 * sight, and never while a logo is being dragged. On a phone the wide menu
 * lives in the same slide-out drawer as the rail, so the same rule leaves the
 * panel out there.
 *
 * Three ways in, and they are deliberately different, because a panel of
 * buttons is not a tooltip:
 *
 * - Pointer: rest on the logo. The panel does NOT take focus, so it cannot
 *   interrupt someone typing somewhere else on the page.
 * - Keyboard: focus the logo and press the right arrow key, which reads as
 *   "go into the thing to my right". The panel takes focus, so the next Tab
 *   lands on the first shortcut, Escape closes it, and focus comes back to the
 *   logo it opened from. The logo's own tooltip says the key out loud so it
 *   does not have to be guessed.
 * - Touch: press and hold the logo. There is no hover on a touch screen, and
 *   an ordinary tap has to keep meaning "open this company". The tap that ends
 *   a long press is swallowed so holding a logo does not also switch company.
 *
 * This used to be a hover card. A hover card sets tabindex="-1" on everything
 * inside it, by design, because it is meant for a preview rather than for
 * controls; that made every shortcut unreachable by keyboard. A popover is the
 * primitive for content you can actually click.
 */
function useCompanyPeek(isDragging: boolean) {
  const { isMobile, sidebarOpen } = useSidebar();
  const [openedBy, setOpenedBy] = useState<PeekOpenedBy | null>(null);
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const longPressTimer = useRef<number | null>(null);
  // Read while the panel is closing, when openedBy has already gone back to
  // null, to decide whether focus should return to the logo.
  const lastOpenedBy = useRef<PeekOpenedBy | null>(null);
  const swallowNextClick = useRef(false);

  const peekEnabled = !isMobile && !isDragging && !sidebarOpen;
  const peekOpen = peekEnabled && openedBy !== null;

  const clearTimers = useCallback(() => {
    for (const timer of [openTimer, closeTimer, longPressTimer]) {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    }
  }, []);

  const openPeek = useCallback(
    (by: PeekOpenedBy) => {
      clearTimers();
      lastOpenedBy.current = by;
      setOpenedBy(by);
    },
    [clearTimers],
  );

  const closePeek = useCallback(() => {
    clearTimers();
    setOpenedBy(null);
  }, [clearTimers]);

  const closeAfterDelay = useCallback(() => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpenedBy(null), PEEK_CLOSE_DELAY_MS);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);
  // Starting a drag, or opening the wide menu, takes the panel with it.
  useEffect(() => {
    if (!peekEnabled) {
      clearTimers();
      setOpenedBy(null);
    }
  }, [peekEnabled, clearTimers]);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  /** True when this click only happened because a long press ended. */
  const consumeSwallowedClick = useCallback(() => {
    if (!swallowNextClick.current) return false;
    swallowNextClick.current = false;
    return true;
  }, []);

  const anchorProps = {
    "aria-haspopup": peekEnabled ? ("menu" as const) : undefined,
    "aria-expanded": peekEnabled ? peekOpen : undefined,
    onPointerEnter: (event: React.PointerEvent) => {
      // A touch screen reports a pointer too, and it means a tap, not a hover.
      if (!peekEnabled || event.pointerType === "touch") return;
      // A hold whose finger lifted somewhere else can leave this set. Any
      // fresh approach to the logo means the next click is a real one.
      swallowNextClick.current = false;
      clearTimers();
      openTimer.current = window.setTimeout(() => openPeek("pointer"), PEEK_OPEN_DELAY_MS);
    },
    onPointerLeave: (event: React.PointerEvent) => {
      if (event.pointerType === "touch") return;
      closeAfterDelay();
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (!peekEnabled || event.key !== "ArrowRight") return;
      event.preventDefault();
      openPeek("keyboard");
    },
    onTouchStart: () => {
      if (!peekEnabled) return;
      swallowNextClick.current = false;
      clearTimers();
      longPressTimer.current = window.setTimeout(() => {
        swallowNextClick.current = true;
        openPeek("touch");
      }, PEEK_LONG_PRESS_MS);
    },
    onTouchEnd: cancelLongPress,
    onTouchMove: cancelLongPress,
    onTouchCancel: cancelLongPress,
  };

  const contentProps = {
    onOpenAutoFocus: (event: Event) => {
      // A panel that opened because the pointer happened to rest on a logo
      // must not take focus away from whatever the person was doing.
      if (lastOpenedBy.current === "pointer") event.preventDefault();
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      if (lastOpenedBy.current !== "pointer") anchorRef.current?.focus();
    },
    onPointerEnter: (event: React.PointerEvent) => {
      if (event.pointerType === "touch") return;
      clearTimers();
    },
    onPointerLeave: (event: React.PointerEvent) => {
      if (event.pointerType === "touch") return;
      closeAfterDelay();
    },
  };

  return {
    peekEnabled,
    peekOpen,
    anchorRef,
    anchorProps,
    contentProps,
    consumeSwallowedClick,
    closePeek,
    /** Radix asks to close on Escape and on a click outside. Nothing else opens it. */
    onOpenChange: (next: boolean) => {
      if (!next) closePeek();
    },
  };
}

function SortableCompanyItem({
  company,
  isSelected,
  hasLiveAgents,
  inboxCount,
  portfolioCompanyCount,
  onSelect,
}: {
  company: Company;
  isSelected: boolean;
  hasLiveAgents: boolean;
  inboxCount: number;
  portfolioCompanyCount: number;
  onSelect: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: company.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.8 : 1,
  };

  const peek = useCompanyPeek(isDragging);
  const [tooltipHoverOpen, setTooltipHoverOpen] = useState(false);
  const tooltipOpen = tooltipHoverOpen && !peek.peekOpen;

  const avatar = (
    <a
      ref={peek.anchorRef}
      href={`/${company.issuePrefix}/dashboard`}
      {...peek.anchorProps}
      onClick={(e) => {
        e.preventDefault();
        if (isDragging) return;
        // The tap that ends a press and hold opened the panel; it must not
        // also switch company underneath it.
        if (peek.consumeSwallowedClick()) return;
        peek.closePeek();
        onSelect();
      }}
      className="relative flex items-center justify-center group overflow-visible"
    >
      {/* Selection indicator pill */}
      <div
        className={cn(
          "absolute left-[-14px] w-1 rounded-r-full bg-foreground transition-[height] duration-150",
          isSelected ? "h-5" : "h-0 group-hover:h-2",
        )}
      />
      <div
        className={cn("relative overflow-visible transition-transform duration-150", isDragging && "scale-105")}
      >
        <CompanyPatternIcon
          companyName={company.name}
          logoUrl={company.logoUrl}
          brandColor={company.brandColor}
          className={cn(
            isSelected ? "rounded-[14px]" : "rounded-[22px] group-hover:rounded-[14px]",
            isDragging && "shadow-lg",
          )}
        />
        {hasLiveAgents && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 z-10">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-80" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-background" />
            </span>
          </span>
        )}
        {inboxCount > 0 && (
          <span
            className="pointer-events-none absolute -bottom-1 -right-1 z-10 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-none text-white ring-2 ring-background tabular-nums"
            aria-label={`${inboxCount} unread item${inboxCount === 1 ? "" : "s"} waiting for you`}
          >
            {inboxCount > 99 ? "99+" : inboxCount}
          </span>
        )}
      </div>
    </a>
  );

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="overflow-visible">
      <Popover open={peek.peekOpen} onOpenChange={peek.onOpenChange}>
        <Tooltip
          delayDuration={300}
          open={tooltipOpen}
          onOpenChange={setTooltipHoverOpen}
        >
          <PopoverAnchor asChild>
            <TooltipTrigger asChild>{avatar}</TooltipTrigger>
          </PopoverAnchor>
          <TooltipContent side="right" sideOffset={8}>
            <p>{company.name}</p>
            {inboxCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {inboxCount} item{inboxCount === 1 ? "" : "s"} waiting for you
              </p>
            )}
            {peek.peekEnabled && (
              <p className="text-xs text-muted-foreground">
                Right arrow key for shortcuts
              </p>
            )}
          </TooltipContent>
        </Tooltip>
        {peek.peekEnabled && (
          <PopoverContent
            side="right"
            align="start"
            sideOffset={8}
            className="w-64 p-0"
            {...peek.contentProps}
          >
            <CompanyPeekContent
              company={company}
              portfolioCompanyCount={portfolioCompanyCount}
              onItemClick={peek.closePeek}
            />
          </PopoverContent>
        )}
      </Popover>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Portfolio as a second rail button, above HQ — DISABLED 2026-09-08, kept
 * here as the put-back path rather than deleted.
 *
 * This shipped on the premise that HQ is a real company with its own team
 * and work, separate from "the bird's-eye view of everything else" (see
 * docs/plans/2026-09-02-ux-control-center-scope.md, decision D05). The operator
 * corrected that premise the same day this landed: HQ was never meant to be
 * its own operating company, it IS the bird's-eye view. Checking the live
 * data backed this up — HQ's two real agents (Builder, Steward) and its 345
 * real issues are all oversight/housekeeping work ("Steward — daily sweep",
 * "Confirm backups ran", "Reply to new Google reviews"), not a second
 * business HQ runs on its own. So a second icon for "the bird's-eye view"
 * duplicated the job the single HQ icon already does. HQ's own Overview page
 * still shows that oversight backlog, and the Portfolio aggregate pages are
 * still one click away from there as pinned workspaces (seeded by
 * hooks/useHqDefaultPins.ts the first time HQ opens).
 *
 * Putting this back needs, in CompanyRail.tsx:
 * - `Globe2` re-added to the lucide-react import at the top of the file.
 * - `isPortfolioRoutePath`, `isPortfolioScopeAvailable`, `portfolioPathForPage`
 *   re-added to the `../lib/scope-kind` import.
 * - `inPortfolioScope`, `showPortfolio`, and `portfolioDescription` computed
 *   again in CompanyRail() (they read `location.pathname`/`hqCompany`/
 *   `reorderableCompanies.length`, same as `hqDescription` still does).
 * - The block below rendered again above `<PinnedHqItem>`, and
 *   PinnedHqItem's `isSelected` reverted to
 *   `hqCompany.id === highlightedCompanyId && !inPortfolioScope`.
 *
 * function PortfolioRailItem({
 *   isSelected,
 *   description,
 *   onSelect,
 * }: {
 *   isSelected: boolean;
 *   description: string;
 *   onSelect: () => void;
 * }) {
 *   return (
 *     <div className="overflow-visible">
 *       <Tooltip delayDuration={300}>
 *         <TooltipTrigger asChild>
 *           <button
 *             type="button"
 *             onClick={onSelect}
 *             aria-label="Portfolio"
 *             aria-pressed={isSelected}
 *             className="relative flex items-center justify-center group overflow-visible"
 *           >
 *             <div
 *               className={cn(
 *                 "absolute left-[-14px] w-1 rounded-r-full bg-foreground transition-[height] duration-150",
 *                 isSelected ? "h-5" : "h-0 group-hover:h-2",
 *               )}
 *             />
 *             <div
 *               className={cn(
 *                 "flex h-11 w-11 items-center justify-center rounded-[14px] border transition-colors duration-150",
 *                 isSelected
 *                   ? "border-foreground/20 bg-accent text-accent-foreground"
 *                   : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
 *               )}
 *             >
 *               <Globe2 className="h-5 w-5" />
 *             </div>
 *           </button>
 *         </TooltipTrigger>
 *         <TooltipContent side="right" sideOffset={8}>
 *           <p className="font-medium">Portfolio</p>
 *           <p className="text-xs text-muted-foreground">{description}</p>
 *         </TooltipContent>
 *       </Tooltip>
 *     </div>
 *   );
 * }
 * ----------------------------------------------------------------------- */

/**
 * HQ pinned at the top — always rendered first, never draggable, always
 * rounded-square shape (other companies toggle between circle and square
 * on hover/select). Tooltip identifies it as the portfolio root.
 */
function PinnedHqItem({
  company,
  isSelected,
  hasLiveAgents,
  inboxCount,
  portfolioCompanyCount,
  description,
  onSelect,
}: {
  company: Company;
  isSelected: boolean;
  hasLiveAgents: boolean;
  inboxCount: number;
  portfolioCompanyCount: number;
  description: string;
  onSelect: () => void;
}) {
  const peek = useCompanyPeek(false);
  const [tooltipHoverOpen, setTooltipHoverOpen] = useState(false);
  const tooltipOpen = tooltipHoverOpen && !peek.peekOpen;

  const avatar = (
    <a
      ref={peek.anchorRef}
      href={`/${company.issuePrefix}/dashboard`}
      {...peek.anchorProps}
      onClick={(e) => {
        e.preventDefault();
        if (peek.consumeSwallowedClick()) return;
        peek.closePeek();
        onSelect();
      }}
      className="relative flex items-center justify-center group overflow-visible"
    >
      {/* Selection indicator pill */}
      <div
        className={cn(
          "absolute left-[-14px] w-1 rounded-r-full bg-foreground transition-[height] duration-150",
          isSelected ? "h-5" : "h-0 group-hover:h-2",
        )}
      />
      <div className="relative overflow-visible">
        <CompanyPatternIcon
          companyName={company.name}
          logoUrl={company.logoUrl}
          brandColor={company.brandColor}
          /* Always rounded-square — HQ is visually distinct from peer companies which morph from circle on hover. */
          className="rounded-[14px] ring-1 ring-foreground/20"
        />
        {hasLiveAgents && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 z-10">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-80" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-background" />
            </span>
          </span>
        )}
        {inboxCount > 0 && (
          <span
            className="pointer-events-none absolute -bottom-1 -right-1 z-10 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-none text-white ring-2 ring-background tabular-nums"
            aria-label={`${inboxCount} unread item${inboxCount === 1 ? "" : "s"} waiting for you`}
          >
            {inboxCount > 99 ? "99+" : inboxCount}
          </span>
        )}
      </div>
    </a>
  );

  return (
    <div className="overflow-visible">
      <Popover open={peek.peekOpen} onOpenChange={peek.onOpenChange}>
        <Tooltip
          delayDuration={300}
          open={tooltipOpen}
          onOpenChange={setTooltipHoverOpen}
        >
          <PopoverAnchor asChild>
            <TooltipTrigger asChild>{avatar}</TooltipTrigger>
          </PopoverAnchor>
          <TooltipContent side="right" sideOffset={8}>
            <p className="font-medium">{company.name}</p>
            {/* Was "Portfolio root", which read as "this button is the
                portfolio". It is the one entry point for both HQ's own
                oversight work and the portfolio aggregate view, so this says
                what it actually opens. */}
            <p className="text-xs text-muted-foreground">{description}</p>
            {inboxCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {inboxCount} item{inboxCount === 1 ? "" : "s"} waiting for you
              </p>
            )}
            {peek.peekEnabled && (
              <p className="text-xs text-muted-foreground">
                Right arrow key for shortcuts
              </p>
            )}
          </TooltipContent>
        </Tooltip>
        {peek.peekEnabled && (
          <PopoverContent
            side="right"
            align="start"
            sideOffset={8}
            className="w-64 p-0"
            {...peek.contentProps}
          >
            <CompanyPeekContent
              company={company}
              portfolioCompanyCount={portfolioCompanyCount}
              onItemClick={peek.closePeek}
            />
          </PopoverContent>
        )}
      </Popover>
    </div>
  );
}

export function CompanyRail() {
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openOnboarding } = useDialog();
  const navigate = useNavigate();
  const location = useLocation();
  const isInstanceRoute = location.pathname.startsWith("/instance/");
  const highlightedCompanyId = isInstanceRoute ? null : selectedCompanyId;
  const sidebarCompanies = useMemo(
    () => companies.filter((company) => company.status !== "archived"),
    [companies],
  );
  const hqCompany = useMemo(
    () => sidebarCompanies.find((c) => c.isPortfolioRoot) ?? null,
    [sidebarCompanies],
  );
  const reorderableCompanies = useMemo(
    () => sidebarCompanies.filter((c) => !c.isPortfolioRoot),
    [sidebarCompanies],
  );
  const hqDescription = useMemo(
    () =>
      resolveScopeChoiceDescription({
        scopeKind: "hq",
        companyName: hqCompany?.name ?? null,
        portfolioCompanyCount: reorderableCompanies.length,
      }),
    [hqCompany?.name, reorderableCompanies.length],
  );
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const companyIds = useMemo(() => sidebarCompanies.map((company) => company.id), [sidebarCompanies]);

  const liveRunsQueries = useQueries({
    queries: companyIds.map((companyId) => ({
      queryKey: queryKeys.liveRuns(companyId),
      queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
      refetchInterval: 10_000,
    })),
  });
  const sidebarBadgeQueries = useQueries({
    queries: companyIds.map((companyId) => ({
      queryKey: queryKeys.sidebarBadges(companyId),
      queryFn: () => sidebarBadgesApi.get(companyId),
      refetchInterval: 15_000,
    })),
  });
  const hasLiveAgentsByCompanyId = useMemo(() => {
    const result = new Map<string, boolean>();
    companyIds.forEach((companyId, index) => {
      // Only queued/running pulse the dot; scheduled_retry rows in the
      // response mean "will run later", not "working now".
      result.set(
        companyId,
        (liveRunsQueries[index]?.data ?? []).some((r) => isLiveRunStatus(r.status)),
      );
    });
    return result;
  }, [companyIds, liveRunsQueries]);
  const inboxCountByCompanyId = useMemo(() => {
    const result = new Map<string, number>();
    companyIds.forEach((companyId, index) => {
      result.set(companyId, sidebarBadgeQueries[index]?.data?.inbox ?? 0);
    });
    return result;
  }, [companyIds, sidebarBadgeQueries]);

  const { orderedCompanies, persistOrder } = useCompanyOrder({
    companies: reorderableCompanies,
    userId: currentUserId,
  });

  // Require 8px of movement before starting a drag to avoid interfering with clicks
  const sensors = useSensors(
    // Keep sidebar reordering mouse-only so touch input can scroll/tap without drag affordances.
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ids = orderedCompanies.map((c) => c.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      persistOrder(arrayMove(ids, oldIndex, newIndex));
    },
    [orderedCompanies, persistOrder]
  );

  return (
    <div className="flex flex-col items-center w-[72px] shrink-0 h-full bg-background border-r border-border">
      {/* Paperclip icon - aligned with top sections (implied line, no visible border) */}
      <div className="flex items-center justify-center h-12 w-full shrink-0">
        <Paperclip className="h-5 w-5 text-foreground" />
      </div>

      {/* Company list */}
      <div className="flex-1 flex flex-col items-center gap-2 py-3 w-full overflow-y-auto overflow-x-hidden scrollbar-none">
        {hqCompany && (
          <>
            <PinnedHqItem
              company={hqCompany}
              // HQ is the one entry point for both its own oversight work and
              // the Portfolio aggregate pages (see the disabled
              // PortfolioRailItem block above), so it lights up on a
              // portfolio page too — there is no second button left to
              // confuse it with.
              isSelected={hqCompany.id === highlightedCompanyId}
              hasLiveAgents={hasLiveAgentsByCompanyId.get(hqCompany.id) ?? false}
              inboxCount={inboxCountByCompanyId.get(hqCompany.id) ?? 0}
              portfolioCompanyCount={reorderableCompanies.length}
              description={hqDescription}
              onSelect={() => {
                // Coming back from a portfolio page is not a company switch,
                // so nothing would happen without an explicit destination:
                // HQ is already selected, and its remembered page can be the
                // portfolio page you are trying to leave.
                const leavingPortfolio = companyPathForPortfolioPage(location.pathname);
                if (leavingPortfolio) {
                  setSelectedCompanyId(hqCompany.id, { source: "shortcut" });
                  navigate(`/${hqCompany.issuePrefix}${leavingPortfolio}`);
                  return;
                }
                setSelectedCompanyId(hqCompany.id);
                if (isInstanceRoute) {
                  navigate(`/${hqCompany.issuePrefix}/dashboard`);
                }
              }}
            />
            {orderedCompanies.length > 0 && (
              <div className="w-8 h-px bg-border my-1 shrink-0" aria-hidden />
            )}
          </>
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={orderedCompanies.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {orderedCompanies.map((company) => (
              <SortableCompanyItem
                key={company.id}
                company={company}
                isSelected={company.id === highlightedCompanyId}
                hasLiveAgents={hasLiveAgentsByCompanyId.get(company.id) ?? false}
                inboxCount={inboxCountByCompanyId.get(company.id) ?? 0}
                portfolioCompanyCount={reorderableCompanies.length}
                onSelect={() => {
                  setSelectedCompanyId(company.id);
                  if (isInstanceRoute) {
                    navigate(`/${company.issuePrefix}/dashboard`);
                  }
                }}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* Separator before add button */}
      <div className="w-8 h-px bg-border mx-auto shrink-0" />

      {/* Add company button */}
      <div className="flex items-center justify-center py-2 shrink-0">
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              onClick={() => openOnboarding()}
              className="flex items-center justify-center w-11 h-11 rounded-[22px] hover:rounded-[14px] border-2 border-dashed border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-[border-color,color,border-radius] duration-150"
              aria-label="Add company"
            >
              <Plus className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <p>Add company</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
