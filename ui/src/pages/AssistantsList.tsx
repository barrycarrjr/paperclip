import { useEffect, useMemo } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Bot, Plus, Pencil } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { Button } from "@/components/ui/button";

export function AssistantsList() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Assistants" }]);
  }, [setBreadcrumbs]);

  const assistants = useMemo(
    () => (agents ?? [])
      .filter((a: Agent) => a.role === "assistant" && a.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name)),
    [agents],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view assistants." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Assistants</h1>
        {assistants.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => navigate("/assistants/new")}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Assistant
          </Button>
        )}
      </div>

      <p className="text-sm text-muted-foreground max-w-2xl">
        Assistants are AI personas that act on your behalf — they can place outbound phone calls,
        read and draft email, and manage your calendar. SMS is on the way. Each assistant has its
        own voice, instructions, and budget.
      </p>

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {assistants.length === 0 ? (
        <EmptyState
          icon={Bot}
          message="No assistants yet. Build your first AI assistant in about 5 minutes — no prompt-writing required."
          action="Create your first Assistant"
          onAction={() => navigate("/assistants/new")}
        />
      ) : (
        <div className="border border-border">
          {assistants.map((agent) => (
            <EntityRow
              key={agent.id}
              title={agent.name}
              subtitle={agent.title ? `${agent.title}` : "Assistant"}
              to={agentUrl(agent)}
              leading={
                <span className="relative flex h-2.5 w-2.5">
                  <span
                    className={`absolute inline-flex h-full w-full rounded-full ${agentStatusDot[agent.status] ?? agentStatusDotDefault}`}
                  />
                </span>
              }
              trailing={
                <div className="flex items-center gap-2">
                  <StatusBadge status={agent.status} />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${agent.name}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      navigate(`/assistants/${agent.id}/edit`);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
