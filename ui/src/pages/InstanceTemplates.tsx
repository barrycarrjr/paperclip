import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ClipboardList, Download, Plus, ScrollText, Sparkles } from "lucide-react";
import type {
  AgentTemplate,
  RoutineTemplate,
  SkillTemplate,
  TemplateType,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { templatesApi } from "@/api/templates";
import { queryKeys } from "@/lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TemplateLibraryDialog } from "@/components/TemplateLibraryDialog";

const TYPE_META: Record<TemplateType, { label: string; icon: typeof Bot; description: string }> = {
  routine: {
    label: "Routines",
    icon: ClipboardList,
    description: "Recurring jobs you author once and deploy to many companies.",
  },
  skill: {
    label: "Skills",
    icon: ScrollText,
    description: "Markdown skills (SKILL.md) you can install into any company.",
  },
  agent: {
    label: "Agents",
    icon: Bot,
    description: "Pre-configured agents you can stamp into any company.",
  },
};

export function InstanceTemplates() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [tab, setTab] = useState<TemplateType>("routine");
  const [libraryOpen, setLibraryOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Templates" },
    ]);
  }, [setBreadcrumbs]);

  const routineQuery = useQuery({
    queryKey: queryKeys.templates.list("routine"),
    queryFn: () => templatesApi.listRoutine(),
  });
  const skillQuery = useQuery({
    queryKey: queryKeys.templates.list("skill"),
    queryFn: () => templatesApi.listSkill(),
  });
  const agentQuery = useQuery({
    queryKey: queryKeys.templates.list("agent"),
    queryFn: () => templatesApi.listAgent(),
  });

  // Background-fetch the library so update-available state is correctly
  // reflected on the per-row badges below.
  const libraryQuery = useQuery({
    queryKey: queryKeys.templates.library(),
    queryFn: () => templatesApi.listLibrary(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const upstreamHashByKindName = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of libraryQuery.data?.templates ?? []) {
      if (t.kind === "bundle") continue;
      map.set(`${t.kind}:${t.name}`, t.contentHash);
    }
    return map;
  }, [libraryQuery.data]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-2">
        <Sparkles className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Templates</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Author routines, skills, and agents once at the portfolio level, then deploy them
        into one or many companies. Edits to a template don't auto-propagate &mdash; redeploy
        to push changes.
      </p>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TemplateType)}>
        <TabsList>
          <TabsTrigger value="routine">
            <ClipboardList className="h-3.5 w-3.5" /> Routines
          </TabsTrigger>
          <TabsTrigger value="skill">
            <ScrollText className="h-3.5 w-3.5" /> Skills
          </TabsTrigger>
          <TabsTrigger value="agent">
            <Bot className="h-3.5 w-3.5" /> Agents
          </TabsTrigger>
        </TabsList>

        <TabsContent value="routine" className="space-y-4">
          <SectionHeader type="routine" onImport={() => setLibraryOpen(true)} />
          <RoutineList query={routineQuery} upstreamHashByKindName={upstreamHashByKindName} />
        </TabsContent>
        <TabsContent value="skill" className="space-y-4">
          <SectionHeader type="skill" onImport={() => setLibraryOpen(true)} />
          <SkillList query={skillQuery} upstreamHashByKindName={upstreamHashByKindName} />
        </TabsContent>
        <TabsContent value="agent" className="space-y-4">
          <SectionHeader type="agent" onImport={() => setLibraryOpen(true)} />
          <AgentList query={agentQuery} upstreamHashByKindName={upstreamHashByKindName} />
        </TabsContent>
      </Tabs>

      <TemplateLibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        defaultTab={tab}
      />
    </div>
  );
}

function SectionHeader({ type, onImport }: { type: TemplateType; onImport: () => void }) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{meta.description}</span>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onImport}>
          <Download className="h-3.5 w-3.5" /> Import from library
        </Button>
        <Button asChild size="sm">
          <Link to={`/instance/settings/templates/${type}/new`}>
            <Plus className="h-3.5 w-3.5" /> New {meta.label.slice(0, -1).toLowerCase()} template
          </Link>
        </Button>
      </div>
    </div>
  );
}

type ListQuery<T> = {
  data?: { templates: T[] };
  isLoading: boolean;
  error: unknown;
};

type WithSource = { source: { name: string; contentHash: string } | null };

function hasUpdate(
  template: WithSource,
  kind: "routine" | "skill" | "agent",
  upstreamHashByKindName: Map<string, string>,
): boolean {
  if (!template.source?.name) return false;
  const upstreamHash = upstreamHashByKindName.get(`${kind}:${template.source.name}`);
  return !!upstreamHash && upstreamHash !== template.source.contentHash;
}

function RoutineList({
  query,
  upstreamHashByKindName,
}: {
  query: ListQuery<RoutineTemplate>;
  upstreamHashByKindName: Map<string, string>;
}) {
  return (
    <TemplateListView
      type="routine"
      query={query}
      renderRow={(t) => (
        <>
          <RowTitle
            name={t.name}
            description={t.description}
            updateAvailable={hasUpdate(t, "routine", upstreamHashByKindName)}
            imported={!!t.source}
          />
          <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline">Routine: {t.routineTitle}</Badge>
            {t.defaultAssigneeRole && (
              <Badge variant="outline">Role: {t.defaultAssigneeRole}</Badge>
            )}
            {t.variables.length > 0 && (
              <Badge variant="outline">{t.variables.length} variable{t.variables.length === 1 ? "" : "s"}</Badge>
            )}
          </div>
        </>
      )}
    />
  );
}

function SkillList({
  query,
  upstreamHashByKindName,
}: {
  query: ListQuery<SkillTemplate>;
  upstreamHashByKindName: Map<string, string>;
}) {
  return (
    <TemplateListView
      type="skill"
      query={query}
      renderRow={(t) => (
        <>
          <RowTitle
            name={t.name}
            description={t.description}
            updateAvailable={hasUpdate(t, "skill", upstreamHashByKindName)}
            imported={!!t.source}
          />
          <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline">key: {t.skillKey}</Badge>
            <Badge variant="outline">{t.skillName}</Badge>
          </div>
        </>
      )}
    />
  );
}

function AgentList({
  query,
  upstreamHashByKindName,
}: {
  query: ListQuery<AgentTemplate>;
  upstreamHashByKindName: Map<string, string>;
}) {
  return (
    <TemplateListView
      type="agent"
      query={query}
      renderRow={(t) => (
        <>
          <RowTitle
            name={t.name}
            description={t.description}
            updateAvailable={hasUpdate(t, "agent", upstreamHashByKindName)}
            imported={!!t.source}
          />
          <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline">name: {t.agentName}</Badge>
            <Badge variant="outline">role: {t.role}</Badge>
            <Badge variant="outline">{t.adapterType}</Badge>
          </div>
        </>
      )}
    />
  );
}

function RowTitle({
  name,
  description,
  updateAvailable,
  imported,
}: {
  name: string;
  description: string | null;
  updateAvailable?: boolean;
  imported?: boolean;
}) {
  return (
    <div>
      <div className="font-medium flex items-center gap-2 flex-wrap">
        {name}
        {updateAvailable ? (
          <Badge variant="secondary" className="text-xs">Update available</Badge>
        ) : imported ? (
          <Badge variant="outline" className="text-xs">Imported</Badge>
        ) : null}
      </div>
      {description && (
        <div className="text-sm text-muted-foreground line-clamp-2">{description}</div>
      )}
    </div>
  );
}

function TemplateListView<T extends { id: string; name: string }>({
  type,
  query,
  renderRow,
}: {
  type: TemplateType;
  query: ListQuery<T>;
  renderRow: (t: T) => React.ReactNode;
}) {
  const items = useMemo(() => query.data?.templates ?? [], [query.data]);

  if (query.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }
  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        Failed to load templates: {(query.error as Error).message}
      </div>
    );
  }
  if (items.length === 0) {
    const Icon = TYPE_META[type].icon;
    return (
      <Card className="bg-muted/30">
        <CardContent className="flex flex-col items-center justify-center py-10 gap-3">
          <Icon className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium">No {TYPE_META[type].label.toLowerCase()} templates yet</p>
          <Button asChild size="sm">
            <Link to={`/instance/settings/templates/${type}/new`}>
              <Plus className="h-3.5 w-3.5" /> Create one
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <ul className="divide-y rounded-md border bg-card">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            to={`/instance/settings/templates/${type}/${item.id}`}
            className="block px-4 py-3 hover:bg-muted/40 space-y-2"
          >
            {renderRow(item)}
          </Link>
        </li>
      ))}
    </ul>
  );
}
