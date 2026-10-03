import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "../api/projects";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
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
import { Bot, Hexagon, Layers, Plus } from "lucide-react";

function ProjectsEmptyHero({ onNewProject }: { onNewProject: () => void }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 py-12 text-center">
      <div className="relative">
        <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-5">
          <Hexagon className="h-10 w-10 text-primary" strokeWidth={1.5} />
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-foreground">Organize Work into Projects</h2>
        <p className="max-w-lg text-sm text-muted-foreground leading-relaxed">
          Projects bring together tasks, routines, and deliverables under a single initiative—giving your agents and team a cohesive home for related efforts.
        </p>
      </div>

      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3 text-left">
        <div className="rounded-lg border border-border/70 bg-card p-4 shadow-xs">
          <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Hexagon className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-medium text-foreground">Dedicated Initiatives</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-normal">
            Group related code repositories, roadmaps, and bug fixes into distinct workspaces.
          </p>
        </div>

        <div className="rounded-lg border border-border/70 bg-card p-4 shadow-xs">
          <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Layers className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-medium text-foreground">Visual Identification</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-normal">
            Custom project colors tag issues, routines, and activity feeds so you can scan progress instantly.
          </p>
        </div>

        <div className="rounded-lg border border-border/70 bg-card p-4 shadow-xs">
          <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Bot className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-medium text-foreground">Focused Agent Context</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-normal">
            Equip agents with specific prompt instructions, tools, and repo boundaries per project.
          </p>
        </div>
      </div>

      <Button onClick={onNewProject} size="lg" className="mt-2">
        <Plus className="mr-2 h-4 w-4" />
        Create your first project
      </Button>
    </div>
  );
}

export function Projects() {
  // URL-derived, not useCompany()'s selection state (P4 sweep, 2026-09-03) —
  // see Calendar.tsx's identical fix for the general pattern.
  const selectedCompanyId = useActiveCompanyId();
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
