import {
  Inbox,
  Brain,
  CircleDot,
  Target,
  DollarSign,
  Mail,
  Network,
  Repeat,
  CalendarClock,
  GitBranch,
  MessageSquare,
  Globe2,
  Bot,
  Sunrise,
  FolderKanban,
  Megaphone,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Company } from "@paperclipai/shared";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { PortfolioNavList, type PortfolioNavEntry } from "./PortfolioNavList";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useEmailToolsPlugin } from "../hooks/useEmailToolsPlugin";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SidebarPeekProvider } from "../context/SidebarPeekContext";

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
  const liveRunCount = liveRuns?.length ?? 0;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(company.id),
    queryFn: () => agentsApi.list(company.id),
  });
  const activeAgentCount = (agents ?? []).filter(
    (a) => a.status !== "terminated",
  ).length;
  const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;
  const { hasMailboxForCompany: showEmailNav, pluginId: emailPluginId } =
    useEmailToolsPlugin(company.id);
  const showPortfolioEmailNav = company.isPortfolioRoot === true && !!emailPluginId;

  const pluginContext = {
    companyId: company.id,
    companyPrefix: company.issuePrefix ?? null,
  };

  const body = (
    <>
      {company.isPortfolioRoot && (
        <SidebarSection
          label="Portfolio"
          info="Cross-company views for managing the whole portfolio from one place."
        >
          <PortfolioNavList
            entries={[
              {
                id: "portfolio-brief",
                to: "/portfolio-brief",
                label: "Portfolio Brief",
                icon: Sunrise,
                info: "Cross-portfolio overview: per-company health, drafts awaiting your tap, overnight outcomes, today's open issues, and trends — grouped by company.",
              },
              {
                id: "portfolio-issues",
                to: "/portfolio-issues",
                label: "Portfolio Issues",
                icon: Globe2,
                info: "A bird's-eye view of open issues across every company in the portfolio. Filter, bulk-update, and comment without switching companies.",
              },
              {
                id: "portfolio-directives",
                to: "/portfolio-directives",
                label: "Portfolio Directives",
                icon: Megaphone,
                info: "Directives you've broadcast from HQ — one high-level intent fanned out to each company's CEO. Watch each cascade land and track how far each company has taken it.",
              },
              {
                id: "portfolio-agents",
                to: "/portfolio-agents",
                label: "Portfolio Agents",
                icon: Bot,
                info: "See every agent across all companies at a glance. Filter by status or role, and bulk-pause or resume agents portfolio-wide.",
              },
              {
                id: "portfolio-routines",
                to: "/portfolio-routines",
                label: "Portfolio Routines",
                icon: Repeat,
                info: "See all scheduled routines across every company — filter by status, spot errors, and track next-run times in one place.",
              },
              {
                id: "portfolio-calendar",
                to: "/portfolio-calendar",
                label: "Portfolio Calendar",
                icon: CalendarClock,
                info: "Reminders and scheduled events across every company — as a combined list or a single month grid. Filter by company or status.",
              },
              ...(showPortfolioEmailNav
                ? [
                    {
                      id: "portfolio-email",
                      to: "/portfolio-email",
                      label: "Portfolio Email",
                      icon: Mail,
                      info: "Triage every enabled mailbox in one view — no need to switch companies. Triage actions and rules work the same as the per-company view.",
                    } satisfies PortfolioNavEntry,
                  ]
                : []),
              {
                id: "portfolio-costs",
                to: "/portfolio-costs",
                label: "Portfolio Costs",
                icon: DollarSign,
                info: "Month-to-date spend and budget utilisation for every company in the portfolio, sortable and filterable.",
              },
            ]}
          />
        </SidebarSection>
      )}

      <div className="flex flex-col gap-0.5">
        <SidebarNavItem
          to="/brief"
          label="Brief"
          icon={Sunrise}
          liveCount={liveRunCount}
          info="Your overview: what your agents got done overnight, what's awaiting your tap, what's lined up today, key metrics, and active runs in one place."
        />
        <SidebarNavItem
          to="/inbox"
          label="Inbox"
          icon={Inbox}
          badge={inboxBadge.inbox}
          badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
          alert={inboxBadge.failedRuns > 0}
          info="Items that need your attention: failed runs, agent questions, mentions, and approvals waiting on you."
        />
        <SidebarNavItem
          to="/clippy"
          label="Clippy"
          icon={MessageSquare}
          info="Talk to Clippy — Paperclip's in-app assistant. Switch to Agent mode to let it run tools and make changes for you."
        />
        {showEmailNav && (
          <SidebarNavItem
            to="/email"
            label="Email"
            icon={Mail}
            info="View and triage your inbox. Triage actions move mail immediately and update your rules so future messages follow automatically."
          />
        )}
      </div>

      <SidebarSection
        label="Work"
        info="Day-to-day work: tasks, schedules, and the goals they ladder up to."
      >
        <SidebarNavItem
          to="/issues"
          label="Issues"
          icon={CircleDot}
          info="Discrete pieces of work with a clear definition of done. Anything an agent or person needs to do — bugs, questions, one-off jobs — lives here."
        />
        <SidebarNavItem
          to="/routines"
          label="Routines"
          icon={Repeat}
          info="Recurring work that runs on a schedule or trigger. Use routines for anything that should happen repeatedly without you asking each time."
        />
        <SidebarNavItem
          to="/calendar"
          label="Calendar"
          icon={CalendarClock}
          info="Reminders and scheduled events for this company. A reminder is a calendar event with notifications turned on. View them as a list or on a month grid."
        />
        <SidebarNavItem
          to="/goals"
          label="Goals"
          icon={Target}
          info="Higher-level objectives this company is working toward. Goals can have sub-goals and link to the issues that contribute to them."
        />
        <SidebarNavItem
          to="/projects"
          label="Projects"
          icon={FolderKanban}
          info="Group related issues, routines, and goals together. Each project gets its own scoped view."
        />
        <SidebarNavItem
          to="/work-queues"
          label="Work queues"
          icon={Inbox}
          info="Named work streams (support, leads, errors). Webhooks or operators drop items in; agents claim and complete one item at a time."
        />
        <SidebarNavItem
          to="/memories"
          label="Memories"
          icon={Brain}
          info="Durable notes — facts, preferences, decisions — that agents save and recall across runs. Scope to the whole company or to a specific agent."
        />
        {showWorkspacesLink ? (
          <SidebarNavItem
            to="/workspaces"
            label="Workspaces"
            icon={GitBranch}
            info="Isolated environments where agents can work in parallel without stepping on each other's files. (Experimental.)"
          />
        ) : null}
      </SidebarSection>

      <SidebarSection
        label="Team"
        info="The roster for this company. Agents and their reporting structure live on the Org chart; assistants you talk to directly are listed here for quick access."
      >
        <SidebarNavItem
          to="/org"
          label="Org chart"
          icon={Network}
          textBadge={
            activeAgentCount > 0
              ? `${activeAgentCount} agent${activeAgentCount === 1 ? "" : "s"}`
              : undefined
          }
          info="Visualise how agents in this company report to each other — who delegates to whom, and where the CEO sits."
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
