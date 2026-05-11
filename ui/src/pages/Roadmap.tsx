/**
 * @fileoverview Roadmap page — cross-portfolio idea board.
 *
 * Renders the merged roadmap.json published by the configured extensions
 * repo's latest release. Items span skills, agents, routines, features, and
 * plugins. Built plugins surface as `shipped`, coming-soon stubs as
 * `planned`, curated items pass through verbatim.
 *
 * Data: `GET /api/roadmap` via `roadmapApi.list()` (cached 60s server-side).
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Map as MapIcon, ExternalLink } from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { roadmapApi, type RoadmapItem, type RoadmapItemStatus, type RoadmapItemType } from "@/api/roadmap";
import { queryKeys } from "@/lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const TYPE_ORDER: RoadmapItemType[] = [
  "feature",
  "agent",
  "skill",
  "routine",
  "plugin",
  "other",
];

const TYPE_LABEL: Record<RoadmapItemType, string> = {
  feature: "Features",
  agent: "Agents",
  skill: "Skills",
  routine: "Routines",
  plugin: "Plugins",
  other: "Other",
};

const STATUS_ORDER: RoadmapItemStatus[] = [
  "in-progress",
  "planned",
  "idea",
  "shipped",
  "wont-do",
];

const STATUS_LABEL: Record<RoadmapItemStatus, string> = {
  idea: "Idea",
  planned: "Planned",
  "in-progress": "In progress",
  shipped: "Shipped",
  "wont-do": "Won't do",
};

function statusBadgeClass(status: RoadmapItemStatus): string {
  switch (status) {
    case "in-progress":
      return "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "planned":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "idea":
      return "border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-300";
    case "shipped":
      return "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300";
    case "wont-do":
      return "border-muted-foreground/30 bg-muted/40 text-muted-foreground";
  }
}

type StatusFilter = "all" | "active";

export function Roadmap() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [typeFilter, setTypeFilter] = useState<RoadmapItemType | "all">("all");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/brief" },
      { label: "Roadmap" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.roadmap.all,
    queryFn: () => roadmapApi.list(),
    staleTime: 60_000,
  });

  const visibleItems = useMemo(() => {
    const items = data?.items ?? [];
    return items.filter((item) => {
      if (typeFilter !== "all" && item.type !== typeFilter) return false;
      if (statusFilter === "active" && (item.status === "shipped" || item.status === "wont-do")) {
        return false;
      }
      return true;
    });
  }, [data?.items, statusFilter, typeFilter]);

  const grouped = useMemo(() => {
    const byType = new Map<RoadmapItemType, RoadmapItem[]>();
    for (const item of visibleItems) {
      const key = (TYPE_ORDER.includes(item.type) ? item.type : "other") as RoadmapItemType;
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push(item);
    }
    for (const list of byType.values()) {
      list.sort((a, b) => {
        const ai = STATUS_ORDER.indexOf(a.status);
        const bi = STATUS_ORDER.indexOf(b.status);
        if (ai !== bi) return ai - bi;
        return a.title.localeCompare(b.title);
      });
    }
    return TYPE_ORDER.map((t) => ({ type: t, items: byType.get(t) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [visibleItems]);

  const totalCounts = useMemo(() => {
    const counts: Record<RoadmapItemStatus, number> = {
      idea: 0,
      planned: 0,
      "in-progress": 0,
      shipped: 0,
      "wont-do": 0,
    };
    for (const item of data?.items ?? []) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    }
    return counts;
  }, [data?.items]);

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading roadmap...</div>;
  }
  if (error) {
    return (
      <div className="p-4 text-sm text-destructive">
        Failed to load roadmap: {(error as Error).message}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-2">
        <MapIcon className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Roadmap</h1>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Status:</span>
        <Button
          size="sm"
          variant={statusFilter === "active" ? "default" : "outline"}
          onClick={() => setStatusFilter("active")}
        >
          Active ({totalCounts.idea + totalCounts.planned + totalCounts["in-progress"]})
        </Button>
        <Button
          size="sm"
          variant={statusFilter === "all" ? "default" : "outline"}
          onClick={() => setStatusFilter("all")}
        >
          All ({(data?.items.length ?? 0)})
        </Button>

        <span className="ml-4 text-muted-foreground">Type:</span>
        <Button
          size="sm"
          variant={typeFilter === "all" ? "default" : "outline"}
          onClick={() => setTypeFilter("all")}
        >
          All
        </Button>
        {TYPE_ORDER.map((t) => (
          <Button
            key={t}
            size="sm"
            variant={typeFilter === t ? "default" : "outline"}
            onClick={() => setTypeFilter(t)}
          >
            {TYPE_LABEL[t]}
          </Button>
        ))}
      </div>

      {grouped.length === 0 ? (
        <Card className="bg-muted/30">
          <CardContent className="flex flex-col items-center justify-center py-10">
            <MapIcon className="h-10 w-10 text-muted-foreground mb-4" />
            <p className="text-sm font-medium">Nothing on the roadmap yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Add entries to <code>roadmap.json</code> or <code>coming-soon.json</code>
              {" "}in the extensions repo, then cut a new release.
            </p>
          </CardContent>
        </Card>
      ) : (
        grouped.map((group) => (
          <section key={group.type} className="space-y-3">
            <h2 className="text-base font-semibold">
              {TYPE_LABEL[group.type]}{" "}
              <span className="text-muted-foreground font-normal">
                ({group.items.length})
              </span>
            </h2>
            <ul className="divide-y rounded-md border bg-card">
              {group.items.map((item) => (
                <li key={item.id}>
                  <div className="flex items-start gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.title}</span>
                        <Badge
                          variant="outline"
                          className={cn("shrink-0", statusBadgeClass(item.status))}
                        >
                          {STATUS_LABEL[item.status]}
                        </Badge>
                        {item.addedAt && (
                          <span className="text-xs text-muted-foreground">
                            added {item.addedAt}
                          </span>
                        )}
                      </div>
                      {item.description && (
                        <p className="text-sm text-muted-foreground mt-1">
                          {item.description}
                        </p>
                      )}
                      {item.notes && (
                        <p className="text-xs text-muted-foreground/80 mt-2 whitespace-pre-wrap">
                          {item.notes}
                        </p>
                      )}
                    </div>
                    {item.type === "plugin" && item.linkedPluginId && (
                      <div className="shrink-0">
                        <Button variant="outline" size="sm" className="h-8" asChild>
                          <Link to="/instance/settings/plugins">
                            <ExternalLink className="h-3.5 w-3.5" />
                            Plugin Manager
                          </Link>
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
