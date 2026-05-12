import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ClipboardList, Plus, ScrollText, Sparkles } from "lucide-react";
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
          <SectionHeader type="routine" />
          <RoutineList query={routineQuery} />
        </TabsContent>
        <TabsContent value="skill" className="space-y-4">
          <SectionHeader type="skill" />
          <SkillList query={skillQuery} />
        </TabsContent>
        <TabsContent value="agent" className="space-y-4">
          <SectionHeader type="agent" />
          <AgentList query={agentQuery} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SectionHeader({ type }: { type: TemplateType }) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{meta.description}</span>
      </div>
      <Button asChild size="sm">
        <Link to={`/instance/settings/templates/${type}/new`}>
          <Plus className="h-3.5 w-3.5" /> New {meta.label.slice(0, -1).toLowerCase()} template
        </Link>
      </Button>
    </div>
  );
}

type ListQuery<T> = {
  data?: { templates: T[] };
  isLoading: boolean;
  error: unknown;
};

function RoutineList({ query }: { query: ListQuery<RoutineTemplate> }) {
  return (
    <TemplateListView
      type="routine"
      query={query}
      renderRow={(t) => (
        <>
          <RowTitle name={t.name} description={t.description} />
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

function SkillList({ query }: { query: ListQuery<SkillTemplate> }) {
  return (
    <TemplateListView
      type="skill"
      query={query}
      renderRow={(t) => (
        <>
          <RowTitle name={t.name} description={t.description} />
          <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline">key: {t.skillKey}</Badge>
            <Badge variant="outline">{t.skillName}</Badge>
          </div>
        </>
      )}
    />
  );
}

function AgentList({ query }: { query: ListQuery<AgentTemplate> }) {
  return (
    <TemplateListView
      type="agent"
      query={query}
      renderRow={(t) => (
        <>
          <RowTitle name={t.name} description={t.description} />
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

function RowTitle({ name, description }: { name: string; description: string | null }) {
  return (
    <div>
      <div className="font-medium">{name}</div>
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
