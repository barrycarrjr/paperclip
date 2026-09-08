import {
  Inbox,
  Bot,
  CircleDot,
  LayoutGrid,
  Mail,
  CalendarClock,
  Sunrise,
} from "lucide-react";
import { useMemo } from "react";
import { useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Company } from "@paperclipai/shared";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { isLiveRunStatus } from "../lib/liveIssueIds";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useHqDefaultPins } from "../hooks/useHqDefaultPins";
import { usePinnedWorkspaces } from "../hooks/usePinnedWorkspaces";
import { usePluginSlots } from "../plugins/slots";
import { resolvePinnedWorkspaceItems } from "../lib/workspace-catalog";
import { isTeamPath } from "../lib/team-tabs";
import { isWorkPath } from "../lib/work-tabs";
import { useEmailToolsPlugin } from "../hooks/useEmailToolsPlugin";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SidebarPeekProvider } from "../context/SidebarPeekContext";

/**
 * The main menu.
 *
 * Shortened 2026-09-07 to the eight destinations in the agreed primary
 * navigation table (docs/plans/2026-09-02-ux-control-center-scope.md, "A small
 * primary navigation"), which is also what the mockup shows: Email, Calendar,
 * pinned tools, Overview, Attention, Team, Work, and Everything. See
 * docs/plans/2026-09-07-mockup-vs-app.md, difference 1.
 *
 * Everything that used to have its own line here still exists, still has its
 * route, and is still listed on the Everything page and in the command palette,
 * because both build themselves from lib/workspace-catalog.ts. Nothing was
 * deleted; the old menu is kept, commented out, at the bottom of this file so
 * it can be put back in one edit.
 *
 * HQ is the exception to the automatic Email and Calendar lines. HQ is where
 * you look across companies, and neither a single mailbox nor a single
 * calendar means anything there, so in HQ "Your workspaces" holds only what
 * the person pinned. It does not start out empty: the pages the old Portfolio
 * block listed are pinned for them the first time they open HQ, once, by
 * hooks/useHqDefaultPins.ts.
 */
interface SidebarMenuProps {
  company: Company;
  /**
   * When true, the menu is rendered inside a CompanyRail hover flyout for a
   * non-selected company. Items switch the selected company before navigating
   * (see SidebarNavItem). Defaults to false.
   */
  peekMode?: boolean;
  /** Called after a peek item is clicked — flyout uses this to close itself. */
  onPeekItemClick?: () => void;
}

export function SidebarMenu({ company, peekMode = false, onPeekItemClick }: SidebarMenuProps) {
  const location = useLocation();
  const inboxBadge = useInboxBadge(company.id);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(company.id),
    queryFn: () => heartbeatsApi.liveRunsForCompany(company.id),
    refetchInterval: 10_000,
  });
  // scheduled_retry rows now come back from live-runs; only queued/running
  // count as "live" for the pulsing badge.
  const liveRunCount = (liveRuns ?? []).filter((r) => isLiveRunStatus(r.status)).length;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(company.id),
    queryFn: () => agentsApi.list(company.id),
  });
  const activeAgentCount = (agents ?? []).filter(
    (a) => a.status !== "terminated",
  ).length;
  const isPortfolioRoot = company.isPortfolioRoot === true;
  const { hasMailboxForCompany: hasMailbox } = useEmailToolsPlugin(company.id);
  // HQ never gets the automatic Email line, even on an instance where the
  // email add-on is installed. Its cross-company mail page is a pin like any
  // other, seeded below with the rest of HQ's starting pins.
  const showEmailNav = hasMailbox && !isPortfolioRoot;
  // Put HQ's starting pins in place the first time this person opens HQ. Never
  // from a hover flyout: peeking at HQ from the company rail is not opening
  // it, and quietly rewriting someone's saved list because their pointer
  // passed over a logo would be the wrong moment to do anything at all.
  useHqDefaultPins(isPortfolioRoot && !peekMode);
  // The person's pinned tools, resolved against what this company can
  // actually open. A pin is per user (Phone is a tool you use, not a fact
  // about a company), so the same pin can be shown here and hidden in a
  // company whose plugin is not installed — hiding it is right, dropping the
  // pin would not be.
  const { pinned } = usePinnedWorkspaces();
  const { slots: pinnablePluginSlots } = usePluginSlots({
    slotTypes: ["page"],
    companyId: company.id,
  });
  const pinnedItems = useMemo(
    () =>
      resolvePinnedWorkspaceItems({
        pinned,
        isPortfolioRoot,
        availability: {
          isolatedWorkspacesEnabled: experimentalSettings?.enableIsolatedWorkspaces === true,
        },
        pluginSlots: pinnablePluginSlots.map((slot) => ({
          routePath: slot.routePath ?? null,
          displayName: slot.displayName,
        })),
      }),
    [
      pinned,
      isPortfolioRoot,
      experimentalSettings?.enableIsolatedWorkspaces,
      pinnablePluginSlots,
    ],
  );

  const pluginContext = {
    companyId: company.id,
    companyPrefix: company.issuePrefix ?? null,
  };

  const body = (
    <>
      <SidebarSection
        label="Your workspaces"
        info="The places you use every day. Pin anything else from the Everything page and it shows up here too."
      >
        {showEmailNav && (
          <SidebarNavItem
            to="/email"
            label="Email"
            icon={Mail}
            info="View and triage your inbox. Triage actions move mail immediately and update your rules so future messages follow automatically."
          />
        )}
        {/* Not in HQ. One company's calendar is a real thing you look at; HQ
            has no calendar of its own, and Portfolio Calendar is one of the
            pins HQ starts with instead. */}
        {!isPortfolioRoot && (
          <SidebarNavItem
            to="/calendar"
            label="Calendar"
            icon={CalendarClock}
            info="Reminders and scheduled events for this company. A reminder is a calendar event with notifications turned on. View them as a list or on a month grid."
          />
        )}
        {/* "Pinned tools" from the scope document's primary navigation table.
            Renders nothing at all when nothing is pinned, so in an ordinary
            company this section is just Email and Calendar for anyone who has
            not used it. In HQ it is the whole section. Pin from the Everything
            page. */}
        {pinnedItems.map((item) => (
          <SidebarNavItem
            key={item.id}
            to={item.to}
            label={item.label}
            icon={item.icon}
            info={item.info}
          />
        ))}
      </SidebarSection>

      <SidebarSection
        label="Control center"
        info="What happened, what needs you, who is working, and what is being worked on."
      >
        <SidebarNavItem
          to="/brief"
          label="Overview"
          icon={Sunrise}
          liveCount={liveRunCount}
          info="What your agents got done overnight, what's awaiting your tap, what's lined up today, key metrics, and active runs in one place."
        />
        <SidebarNavItem
          to="/inbox"
          label="Attention"
          icon={Inbox}
          badge={inboxBadge.inbox}
          badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
          alert={inboxBadge.failedRuns > 0}
          info="Everything waiting on you: agents' questions, work waiting for your sign-off, approvals, failed runs, join requests, and the work you have looked at recently."
        />
        <SidebarNavItem
          to="/team"
          label="Team"
          icon={Bot}
          alsoActive={isTeamPath(location.pathname)}
          textBadge={
            activeAgentCount > 0
              ? `${activeAgentCount} agent${activeAgentCount === 1 ? "" : "s"}`
              : undefined
          }
          info="Who is doing what right now, with tabs for the full roster, the org chart and the assistants. Each tab is still its own page and keeps its own web address, so a saved link still opens the same thing."
        />
        <SidebarNavItem
          to="/work"
          label="Work"
          icon={CircleDot}
          alsoActive={isWorkPath(location.pathname)}
          info="One page with tabs for tasks, projects, goals, automations and intake queues. Each tab is still its own page with its own controls, and each keeps its own web address, so a saved link still opens the same thing."
        />
      </SidebarSection>

      <PluginSlotOutlet
        slotTypes={["sidebar"]}
        context={pluginContext}
        className="flex flex-col gap-0.5"
        itemClassName="text-[13px] font-medium"
        missingBehavior="placeholder"
      />

      <PluginSlotOutlet
        slotTypes={["sidebarPanel"]}
        context={pluginContext}
        className="flex flex-col gap-3"
        itemClassName="rounded-lg border border-border p-3"
        missingBehavior="placeholder"
      />

      {/* "All workspaces" from scope.md's primary nav table — complete
          discovery, last in the list on purpose: everything above is a
          daily shortcut, this is the catch-all for the rest. */}
      <div className="flex flex-col gap-0.5">
        <SidebarNavItem
          to="/everything"
          label="Everything"
          icon={LayoutGrid}
          info="Every workspace this company can reach, including the ones not listed above. It is the same list the search box uses."
        />
      </div>
    </>
  );

  if (peekMode) {
    return (
      <SidebarPeekProvider peekCompanyId={company.id} onItemClick={onPeekItemClick}>
        {body}
      </SidebarPeekProvider>
    );
  }

  return body;
}

/* ---------------------------------------------------------------------------
 * The longer menu this replaced, kept so it can be put back in one edit.
 *
 * Disabled 2026-09-07 (see the note at the top of this file). Every
 * destination below is still a live page with a live route; it is listed on
 * the Everything page and in the command palette instead of having its own
 * line here. The Portfolio block only ever rendered on HQ.
 *
 * Putting any of it back needs its icons and the PortfolioNavList import
 * restored at the top of the file:
 *   Activity, Brain, Target, DollarSign, Network, Receipt, Repeat, GitBranch,
 *   MessageSquare, Globe2, UserCog, ShieldCheck, FolderKanban, Megaphone
 *   import { PortfolioNavList, type PortfolioNavEntry } from "./PortfolioNavList";
 * and, for the Portfolio block, the showWorkspacesLink / showPortfolioEmailNav
 * values that used to be computed alongside showEmailNav:
 *   const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;
 *   const { hasMailboxForCompany: showEmailNav, pluginId: emailPluginId } =
 *     useEmailToolsPlugin(company.id);
 *   const showPortfolioEmailNav = company.isPortfolioRoot === true && !!emailPluginId;
 *
 * {company.isPortfolioRoot && (
 *   <SidebarSection
 *     label="Portfolio"
 *     info="Cross-company views for managing the whole portfolio from one place."
 *   >
 *     <PortfolioNavList
 *       entries={[
 *         {
 *           id: "portfolio-brief",
 *           to: "/portfolio-brief",
 *           label: "Portfolio Brief",
 *           icon: Sunrise,
 *           info: "Cross-portfolio overview: per-company health, drafts awaiting your tap, overnight outcomes, today's open issues, and trends — grouped by company.",
 *         },
 *         {
 *           id: "portfolio-approvals",
 *           to: "/portfolio-approvals",
 *           label: "Portfolio Approvals",
 *           icon: ShieldCheck,
 *           info: "Every draft and approval waiting on you, across all companies, in one list.",
 *         },
 *         {
 *           id: "portfolio-issues",
 *           to: "/portfolio-issues",
 *           label: "Portfolio Issues",
 *           icon: Globe2,
 *           info: "A bird's-eye view of open issues across every company in the portfolio. Filter, bulk-update, and comment without switching companies.",
 *         },
 *         {
 *           id: "portfolio-directives",
 *           to: "/portfolio-directives",
 *           label: "Portfolio Directives",
 *           icon: Megaphone,
 *           info: "Directives you've broadcast from HQ — one high-level intent fanned out to each company's CEO. Watch each cascade land and track how far each company has taken it.",
 *         },
 *         {
 *           id: "portfolio-agents",
 *           to: "/portfolio-agents",
 *           label: "Portfolio Agents",
 *           icon: Bot,
 *           info: "See every agent across all companies at a glance. Filter by status or role, and bulk-pause or resume agents portfolio-wide.",
 *         },
 *         {
 *           id: "portfolio-activity",
 *           to: "/portfolio-activity",
 *           label: "Portfolio Activity",
 *           icon: Activity,
 *           info: "The raw record of everything agents and people did, across all companies, newest first.",
 *         },
 *         {
 *           id: "portfolio-receipts",
 *           to: "/portfolio-receipts",
 *           label: "Portfolio Receipts",
 *           icon: Receipt,
 *           info: "What your agents actually produced across all companies (emails sent, drafts made, issues finished), grouped by day.",
 *         },
 *         {
 *           id: "portfolio-routines",
 *           to: "/portfolio-routines",
 *           label: "Portfolio Routines",
 *           icon: Repeat,
 *           info: "See all scheduled routines across every company — filter by status, spot errors, and track next-run times in one place.",
 *         },
 *         {
 *           id: "portfolio-calendar",
 *           to: "/portfolio-calendar",
 *           label: "Portfolio Calendar",
 *           icon: CalendarClock,
 *           info: "Reminders and scheduled events across every company — as a combined list or a single month grid. Filter by company or status.",
 *         },
 *         ...(showPortfolioEmailNav
 *           ? [
 *               {
 *                 id: "portfolio-email",
 *                 to: "/portfolio-email",
 *                 label: "Portfolio Email",
 *                 icon: Mail,
 *                 info: "Triage every enabled mailbox in one view — no need to switch companies. Triage actions and rules work the same as the per-company view.",
 *               } satisfies PortfolioNavEntry,
 *             ]
 *           : []),
 *         {
 *           id: "portfolio-costs",
 *           to: "/portfolio-costs",
 *           label: "Portfolio Costs",
 *           icon: DollarSign,
 *           info: "Month-to-date spend and budget utilisation for every company in the portfolio, sortable and filterable.",
 *         },
 *       ]}
 *     />
 *   </SidebarSection>
 * )}
 *
 * <SidebarNavItem
 *   to="/clippy"
 *   label="Clippy"
 *   icon={MessageSquare}
 *   info="Talk to Clippy — Paperclip's in-app assistant. Switch to Agent mode to let it run tools and make changes for you."
 * />
 *
 * <SidebarSection
 *   label="Work"
 *   info="Day-to-day work: tasks, schedules, and the goals they ladder up to."
 * >
 *   <SidebarNavItem
 *     to="/issues"
 *     label="Issues"
 *     icon={CircleDot}
 *     info="Discrete pieces of work with a clear definition of done. Anything an agent or person needs to do — bugs, questions, one-off jobs — lives here."
 *   />
 *   <SidebarNavItem
 *     to="/routines"
 *     label="Routines"
 *     icon={Repeat}
 *     info="Recurring work that runs on a schedule or trigger. Use routines for anything that should happen repeatedly without you asking each time."
 *   />
 *   <SidebarNavItem
 *     to="/goals"
 *     label="Goals"
 *     icon={Target}
 *     info="Higher-level objectives this company is working toward. Goals can have sub-goals and link to the issues that contribute to them."
 *   />
 *   <SidebarNavItem
 *     to="/projects"
 *     label="Projects"
 *     icon={FolderKanban}
 *     info="Group related issues, routines, and goals together. Each project gets its own scoped view."
 *   />
 *   <SidebarNavItem
 *     to="/work-queues"
 *     label="Work queues"
 *     icon={Inbox}
 *     info="Named work streams (support, leads, errors). Webhooks or operators drop items in; agents claim and complete one item at a time."
 *   />
 *   <SidebarNavItem
 *     to="/memories"
 *     label="Memories"
 *     icon={Brain}
 *     info="Durable notes — facts, preferences, decisions — that agents save and recall across runs. Scope to the whole company or to a specific agent."
 *   />
 *   {showWorkspacesLink ? (
 *     <SidebarNavItem
 *       to="/workspaces"
 *       label="Workspaces"
 *       icon={GitBranch}
 *       info="Isolated environments where agents can work in parallel without stepping on each other's files. (Experimental.)"
 *     />
 *   ) : null}
 * </SidebarSection>
 *
 * <SidebarSection
 *   label="Records"
 *   info="What already happened in this company: decisions waiting on you, outcomes produced, and the raw activity log."
 * >
 *   <SidebarNavItem
 *     to="/approvals/pending"
 *     label="Approvals"
 *     icon={ShieldCheck}
 *     info="Actions agents drafted that will not run until you approve them. They are counted in the Attention number above, so this one has no badge of its own."
 *   />
 *   <SidebarNavItem
 *     to="/receipts"
 *     label="Receipts"
 *     icon={Receipt}
 *     info="What your agents actually produced (emails sent, drafts made, issues finished), grouped by day."
 *   />
 *   <SidebarNavItem
 *     to="/activity"
 *     label="Activity"
 *     icon={Activity}
 *     info="The raw record of everything agents and people did in this company, newest first."
 *   />
 * </SidebarSection>
 *
 * <SidebarSection
 *   label="Team"
 *   info="The roster for this company. Agents and their reporting structure live on the Org chart; assistants you talk to directly are listed here for quick access."
 * >
 *   <SidebarNavItem
 *     to="/org"
 *     label="Org chart"
 *     icon={Network}
 *     textBadge={activeAgentCount > 0 ? `${activeAgentCount} agents` : undefined}
 *     info="Visualise how agents in this company report to each other — who delegates to whom, and where the CEO sits."
 *   />
 *   <SidebarNavItem
 *     to="/agents/all"
 *     label="All agents"
 *     icon={Bot}
 *     info="The full roster with status filters — active, paused, error, and terminated."
 *   />
 *   <SidebarNavItem
 *     to="/assistants"
 *     label="Assistants"
 *     icon={UserCog}
 *     info="Agents built as a persona to talk to directly — phone, chat, or both — distinct from agents doing background work."
 *   />
 * </SidebarSection>
 * ------------------------------------------------------------------------- */
