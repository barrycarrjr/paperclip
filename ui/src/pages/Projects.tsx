import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { InfoPopoverButton } from "../components/InfoPopoverButton";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate, projectUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Hexagon, Plus } from "lucide-react";

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const projects = useMemo(
    () => (allProjects ?? []).filter((p) => !p.archivedAt),
    [allProjects],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
            <InfoPopoverButton
              title="What projects are for"
              info={
                <>
                  <p>
                    A project bundles the work that ladders up to a single
                    initiative — issues, routines, and the goals they serve.
                    Most pages let you filter or color-code by project, so the
                    bucket is also how the rest of the app stays scannable.
                  </p>
                  <p className="font-medium text-foreground">Project vs goal vs issue</p>
                  <ul className="ml-4 list-disc space-y-1">
                    <li>
                      <span className="font-medium">Goal</span> — the long-running
                      <em> why</em>. Outcomes the company is chasing.
                    </li>
                    <li>
                      <span className="font-medium">Project</span> — the
                      <em> where</em>. The bucket the day-to-day work lives in.
                    </li>
                    <li>
                      <span className="font-medium">Issue</span> — one task with a
                      definition of done. Issues belong to a project.
                    </li>
                  </ul>
                  <p className="font-medium text-foreground">Color</p>
                  <p>
                    Each project picks a color. That dot shows up beside issues,
                    routines, and runs across the app, so you can scan a list and
                    see which initiative each item belongs to.
                  </p>
                  <p className="font-medium text-foreground">When to add one</p>
                  <p>
                    When several issues share an initiative worth tracking
                    together. Skip it if the project would only ever hold a
                    single issue.
                  </p>
                </>
              }
              contentClassName="w-96"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Workstreams that group related issues and routines under a shared initiative or area of focus.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={openNewProject}>
          <Plus className="h-4 w-4 mr-1" />
          Add Project
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message="No projects yet."
          action="Add Project"
          onAction={openNewProject}
        />
      )}

      {projects.length > 0 && (
        <div className="border border-border">
          {projects.map((project) => (
            <EntityRow
              key={project.id}
              title={project.name}
              subtitle={project.description ?? undefined}
              to={projectUrl(project)}
              trailing={
                <div className="flex items-center gap-3">
                  {project.targetDate && (
                    <span className="text-xs text-muted-foreground">
                      {formatDate(project.targetDate)}
                    </span>
                  )}
                  <StatusBadge status={project.status} />
                </div>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
