import {
  Inbox,
  Brain,
  CircleDot,
  Target,
  DollarSign,
  Search,
  SquarePen,
  Network,
  Repeat,
  GitBranch,
  MessageSquare,
  Globe2,
  Bot,
  Sunrise,
  FolderKanban,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useGeneralSettings } from "../context/GeneralSettingsContext";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";

export function Sidebar() {
  const { openNewIssue } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { keyboardShortcutsEnabled } = useGeneralSettings();
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  // Agent count drives the "8 agents" hint next to the Org chart link in
  // the TEAM section. We don't list agents in the sidebar — the canonical
  // hierarchy view is /org.
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const activeAgentCount = (agents ?? []).filter(
    (a) => a.status !== "terminated",
  ).length;
  const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-sidebar flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarCompanyMenu />
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0 hover:text-foreground"
          onClick={openSearch}
          aria-label="Search (⌘K)"
        >
          <Search className="h-4 w-4" />
        </Button>
      </div>

      <div className="px-3 pt-1 pb-2 shrink-0">
        <button
          onClick={() => openNewIssue()}
          className="group flex w-full items-center gap-2.5 border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-foreground hover:border-foreground/30 hover:bg-accent transition-all"
        >
          <SquarePen className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
          <span className="truncate">New issue</span>
          {keyboardShortcutsEnabled && (
            <kbd className="ml-auto text-[10px] text-muted-foreground/70 font-mono group-hover:text-muted-foreground transition-colors">C</kbd>
          )}
        </button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-1">
        {selectedCompany?.isPortfolioRoot && (
          <SidebarSection
            label="Portfolio"
            info="Cross-company views for managing the whole portfolio from one place."
          >
            <SidebarNavItem
              to="/portfolio-brief"
              label="Portfolio Brief"
              icon={Sunrise}
              info="Cross-portfolio overview: per-company health, drafts awaiting your tap, overnight outcomes, today's open issues, and trends — grouped by company."
            />
            <SidebarNavItem
              to="/portfolio-issues"
              label="Portfolio Issues"
              icon={Globe2}
              info="A bird's-eye view of open issues across every company in the portfolio. Filter, bulk-update, and comment without switching companies."
            />
            <SidebarNavItem
              to="/portfolio-agents"
              label="Portfolio Agents"
              icon={Bot}
              info="See every agent across all companies at a glance. Filter by status or role, and bulk-pause or resume agents portfolio-wide."
            />
            <SidebarNavItem
              to="/portfolio-routines"
              label="Portfolio Routines"
              icon={Repeat}
              info="See all scheduled routines across every company — filter by status, spot errors, and track next-run times in one place."
            />
            <SidebarNavItem
              to="/portfolio-costs"
              label="Portfolio Costs"
              icon={DollarSign}
              info="Month-to-date spend and budget utilisation for every company in the portfolio, sortable and filterable."
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
      </nav>
    </aside>
  );
}
