import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { CircleDot, Bot, Hexagon, SquarePen, Plus, PlugZap } from "lucide-react";
import { Identity } from "./Identity";
import { agentUrl, projectUrl } from "../lib/utils";
import { usePluginSlots } from "@/plugins/slots";
import { CORE_WORKSPACE_CATALOG, isWorkspaceAvailable } from "@/lib/workspace-catalog";
import { instanceSettingsApi } from "@/api/instanceSettings";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const isPortfolioRoot = selectedCompany?.isPortfolioRoot ?? false;
  const { openNewIssue, openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const searchQuery = query.trim();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
        if (isMobile) setSidebarOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, setSidebarOpen]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const { data: issues = [] } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open && searchQuery.length === 0,
  });

  const { data: searchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.search(selectedCompanyId!, searchQuery, undefined, 10),
    queryFn: () => issuesApi.list(selectedCompanyId!, { q: searchQuery, limit: 10, includeRoutineExecutions: true }),
    enabled: !!selectedCompanyId && open && searchQuery.length > 0,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });

  // Instance-wide and shared with the sidebar's own copy through the query
  // cache, so opening the palette does not refetch it.
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: open,
  });

  const { data: allProjects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });
  const projects = useMemo(
    () => allProjects.filter((p) => !p.archivedAt),
    [allProjects],
  );

  // Real installed plugin pages (Notepad, To-dos, Phone, ...), not a
  // hand-copied list — see workspace-catalog.ts's file comment for why core
  // and plugin destinations are combined from two different sources instead
  // of one hand-maintained list covering both.
  const { slots: pluginPageSlots } = usePluginSlots({
    slotTypes: ["page"],
    companyId: selectedCompanyId,
    enabled: open,
  });
  // A "page" slot can omit routePath (e.g. a page meant to be embedded
  // elsewhere, not top-level navigable — see packages/shared/src/types/plugin.ts).
  // Memoized and filtered up front, code-reviewed 2026-09-02: the group's
  // render guard below must check THIS count, not pluginPageSlots.length —
  // checking the unfiltered count let a "Plugins" heading with zero items
  // under it render whenever every installed page slot happened to lack a
  // routePath.
  const routablePluginSlots = useMemo(
    () => pluginPageSlots.filter((slot) => slot.routePath),
    [pluginPageSlots],
  );
  // Visibility of the Portfolio group is gated at the JSX call site below, so
  // neither list depends on isPortfolioRoot. Both DO depend on availability:
  // offering a destination the sidebar has already hidden sends someone to a
  // page that cannot help them, which is the whole point of the requirement.
  const availability = useMemo(
    () => ({
      isolatedWorkspacesEnabled: experimentalSettings?.enableIsolatedWorkspaces === true,
    }),
    [experimentalSettings?.enableIsolatedWorkspaces],
  );
  const corePages = useMemo(
    () =>
      CORE_WORKSPACE_CATALOG.filter(
        (entry) => !entry.portfolioRootOnly && isWorkspaceAvailable(entry, availability),
      ),
    [availability],
  );
  const portfolioPages = useMemo(
    () =>
      CORE_WORKSPACE_CATALOG.filter(
        (entry) => entry.portfolioRootOnly && isWorkspaceAvailable(entry, availability),
      ),
    [availability],
  );

  function go(path: string) {
    setOpen(false);
    navigate(path);
  }

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  const visibleIssues = useMemo(
    () => (searchQuery.length > 0 ? searchedIssues : issues),
    [issues, searchedIssues, searchQuery],
  );

  return (
    <CommandDialog open={open} onOpenChange={(v) => {
        setOpen(v);
        if (v && isMobile) setSidebarOpen(false);
      }}>
      <CommandInput
        placeholder="Search issues, agents, projects..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => {
              setOpen(false);
              openNewIssue();
            }}
          >
            <SquarePen className="mr-2 h-4 w-4" />
            Create new issue
            <span className="ml-auto text-xs text-muted-foreground">C</span>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              openNewAgent();
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create new agent
          </CommandItem>
          <CommandItem onSelect={() => go("/projects")}>
            <Plus className="mr-2 h-4 w-4" />
            Create new project
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Pages">
          {corePages.map((entry) => (
            <CommandItem key={entry.id} onSelect={() => go(`/${entry.routeRoot}`)}>
              <entry.icon className="mr-2 h-4 w-4" />
              {entry.label}
            </CommandItem>
          ))}
        </CommandGroup>

        {routablePluginSlots.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Plugins">
              {routablePluginSlots.map((slot) => (
                <CommandItem
                  key={`${slot.pluginKey}:${slot.id}`}
                  value={`${slot.pluginDisplayName} ${slot.displayName}`}
                  onSelect={() => go(`/${slot.routePath}`)}
                >
                  <PlugZap className="mr-2 h-4 w-4" />
                  {slot.displayName}
                  <span className="text-xs text-muted-foreground ml-2">{slot.pluginDisplayName}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {isPortfolioRoot && portfolioPages.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Portfolio">
              {portfolioPages.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={entry.label.toLowerCase()}
                  onSelect={() => go(`/${entry.routeRoot}`)}
                >
                  <entry.icon className="mr-2 h-4 w-4" />
                  {entry.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {visibleIssues.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Issues">
              {visibleIssues.slice(0, 10).map((issue) => (
                <CommandItem
                  key={issue.id}
                  value={
                    searchQuery.length > 0
                      ? `${searchQuery} ${issue.identifier ?? ""} ${issue.title}`
                      : undefined
                  }
                  onSelect={() => go(`/issues/${issue.identifier ?? issue.id}`)}
                >
                  <CircleDot className="mr-2 h-4 w-4" />
                  <span className="text-muted-foreground mr-2 font-mono text-xs">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  <span className="flex-1 truncate">{issue.title}</span>
                  {issue.assigneeAgentId && (() => {
                    const name = agentName(issue.assigneeAgentId);
                    return name ? <Identity name={name} size="sm" className="ml-2 hidden sm:inline-flex" /> : null;
                  })()}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {agents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {agents.slice(0, 10).map((agent) => (
                <CommandItem key={agent.id} onSelect={() => go(agentUrl(agent))}>
                  <Bot className="mr-2 h-4 w-4" />
                  {agent.name}
                  <span className="text-xs text-muted-foreground ml-2">{agent.role}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {projects.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Projects">
              {projects.slice(0, 10).map((project) => (
                <CommandItem key={project.id} onSelect={() => go(projectUrl(project))}>
                  <Hexagon className="mr-2 h-4 w-4" />
                  {project.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
