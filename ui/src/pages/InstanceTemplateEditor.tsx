import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Rocket, Save, Trash2 } from "lucide-react";
import type {
  AgentTemplateDetail,
  CreateAgentTemplate,
  CreateRoutineTemplate,
  CreateSkillTemplate,
  RoutineTemplateDetail,
  SkillTemplateDetail,
  TemplateType,
} from "@paperclipai/shared";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { templatesApi } from "@/api/templates";
import { queryKeys } from "@/lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { TemplateDeployDialog } from "@/components/TemplateDeployDialog";

const TYPE_LABEL: Record<TemplateType, string> = {
  routine: "Routine",
  skill: "Skill",
  agent: "Agent",
};

export function InstanceTemplateEditor() {
  const params = useParams<{ type: string; id: string }>();
  const type = (params.type ?? "routine") as TemplateType;
  const isNew = params.id === "new" || !params.id;
  const id = isNew ? null : (params.id as string);

  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Templates", href: "/instance/settings/templates" },
      { label: `${TYPE_LABEL[type]}: ${isNew ? "New" : "Edit"}` },
    ]);
  }, [setBreadcrumbs, type, isNew]);

  if (type === "routine") return <RoutineEditor id={id} />;
  if (type === "skill") return <SkillEditor id={id} />;
  if (type === "agent") return <AgentEditor id={id} />;
  return <div className="p-4 text-sm">Unknown template type: {type}</div>;
}

function BackLink() {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link to="/instance/settings/templates">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to templates
      </Link>
    </Button>
  );
}

function RoutineEditor({ id }: { id: string | null }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deployOpen, setDeployOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: queryKeys.templates.detail("routine", id ?? "new"),
    queryFn: () => templatesApi.getRoutine(id!),
    enabled: Boolean(id),
  });
  const detail = detailQuery.data;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [routineTitle, setRoutineTitle] = useState("");
  const [routineDescription, setRoutineDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [concurrencyPolicy, setConcurrencyPolicy] = useState("coalesce_if_active");
  const [catchUpPolicy, setCatchUpPolicy] = useState("skip_missed");
  const [defaultAssigneeRole, setDefaultAssigneeRole] = useState("");
  const [triggers, setTriggers] = useState<RoutineTriggerDraft[]>([]);

  useEffect(() => {
    if (!detail) return;
    setName(detail.name);
    setDescription(detail.description ?? "");
    setRoutineTitle(detail.routineTitle);
    setRoutineDescription(detail.routineDescription ?? "");
    setPriority(detail.priority);
    setConcurrencyPolicy(detail.concurrencyPolicy);
    setCatchUpPolicy(detail.catchUpPolicy);
    setDefaultAssigneeRole(detail.defaultAssigneeRole ?? "");
    setTriggers(detail.triggers.filter((t) => t.kind === "schedule").map(triggerToDraft));
  }, [detail?.id]);

  const buildBody = (): CreateRoutineTemplate => ({
    name: name.trim(),
    description: description.trim() || null,
    routineTitle: routineTitle.trim(),
    routineDescription: routineDescription.trim() || null,
    priority: priority as CreateRoutineTemplate["priority"],
    concurrencyPolicy: concurrencyPolicy as CreateRoutineTemplate["concurrencyPolicy"],
    catchUpPolicy: catchUpPolicy as CreateRoutineTemplate["catchUpPolicy"],
    variables: [],
    defaultAssigneeRole: defaultAssigneeRole.trim() || null,
    triggers: triggers.map(draftToTrigger),
  });

  const createMutation = useMutation({
    mutationFn: () => templatesApi.createRoutine(buildBody()),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.templates.list("routine") });
      navigate(`/instance/settings/templates/routine/${created.id}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => templatesApi.updateRoutine(id!, buildBody()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.templates.list("routine") });
      await queryClient.invalidateQueries({ queryKey: queryKeys.templates.detail("routine", id!) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => templatesApi.remove("routine", id!),
    onSuccess: () => {
      // Navigate first so the operator gets immediate feedback even if the
      // background refetch is slow; invalidating *before* navigate let the
      // await stall onSuccess and stranded the user on the now-stale editor.
      navigate("/instance/settings/templates");
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates.list("routine") });
    },
  });

  const saving = createMutation.isPending || updateMutation.isPending;
  const error = createMutation.error || updateMutation.error;

  const onSave = () => {
    if (id) updateMutation.mutate();
    else createMutation.mutate();
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <BackLink />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          {id ? `Routine template: ${detail?.name ?? "Loading"}` : "New routine template"}
        </h1>
        {id && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setDeployOpen(true)}>
              <Rocket className="h-3.5 w-3.5" /> Deploy
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirm("Delete this template? Deployed routines stay in place.")) {
                  deleteMutation.mutate();
                }
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <Field label="Template name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Daily support digest" />
          </Field>
          <Field label="Template description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Routine title">
              <Input value={routineTitle} onChange={(e) => setRoutineTitle(e.target.value)} placeholder="Title applied on deploy" />
            </Field>
            <Field label="Default assignee role (optional)">
              <Input value={defaultAssigneeRole} onChange={(e) => setDefaultAssigneeRole(e.target.value)} placeholder="e.g. ceo, support_lead" />
            </Field>
          </div>
          <Field label="Routine description / prompt body">
            <Textarea
              value={routineDescription}
              onChange={(e) => setRoutineDescription(e.target.value)}
              rows={6}
              placeholder="The prompt or description the routine fires with."
            />
          </Field>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Priority">
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">low</SelectItem>
                  <SelectItem value="medium">medium</SelectItem>
                  <SelectItem value="high">high</SelectItem>
                  <SelectItem value="critical">critical</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Concurrency">
              <Select value={concurrencyPolicy} onValueChange={setConcurrencyPolicy}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="coalesce_if_active">coalesce_if_active</SelectItem>
                  <SelectItem value="skip_if_active">skip_if_active</SelectItem>
                  <SelectItem value="always_enqueue">always_enqueue</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Catch-up">
              <Select value={catchUpPolicy} onValueChange={setCatchUpPolicy}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip_missed">skip_missed</SelectItem>
                  <SelectItem value="enqueue_missed_with_cap">enqueue_missed_with_cap</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Triggers</h2>
              <p className="text-xs text-muted-foreground">
                Schedules and webhooks created in each company on deploy.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setTriggers([...triggers, newScheduleTrigger()])}>
              <Plus className="h-3.5 w-3.5" /> Schedule
            </Button>
          </div>
          {triggers.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">
              No triggers &mdash; the routine will be created in paused state on deploy.
            </div>
          ) : (
            <div className="space-y-2">
              {triggers.map((t, idx) => (
                <TriggerRow
                  key={idx}
                  trigger={t}
                  onChange={(next) =>
                    setTriggers(triggers.map((existing, i) => (i === idx ? next : existing)))
                  }
                  onRemove={() => setTriggers(triggers.filter((_, i) => i !== idx))}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <div className="text-sm text-destructive">{(error as Error).message}</div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" asChild>
          <Link to="/instance/settings/templates">Cancel</Link>
        </Button>
        <Button onClick={onSave} disabled={saving || !name.trim() || !routineTitle.trim()}>
          <Save className="h-3.5 w-3.5" /> {saving ? "Saving..." : id ? "Save changes" : "Create template"}
        </Button>
      </div>

      {id && detail && (
        <>
          <DeploymentsList type="routine" deployments={detail.deployments} />
          <TemplateDeployDialog
            type="routine"
            templateId={detail.id}
            templateName={detail.name}
            existingDeployments={detail.deployments}
            open={deployOpen}
            onOpenChange={setDeployOpen}
          />
        </>
      )}
    </div>
  );
}

type RoutineTriggerDraft = {
  kind: "schedule";
  label: string;
  enabled: boolean;
  cronExpression: string;
  timezone: string;
};

function newScheduleTrigger(): RoutineTriggerDraft {
  return { kind: "schedule", label: "", enabled: true, cronExpression: "0 9 * * *", timezone: "UTC" };
}

function triggerToDraft(t: RoutineTemplateDetail["triggers"][number]): RoutineTriggerDraft {
  return {
    kind: "schedule",
    label: t.label ?? "",
    enabled: t.enabled,
    cronExpression: t.cronExpression ?? "0 9 * * *",
    timezone: t.timezone ?? "UTC",
  };
}

function draftToTrigger(d: RoutineTriggerDraft) {
  return {
    kind: "schedule" as const,
    label: d.label || null,
    enabled: d.enabled,
    cronExpression: d.cronExpression,
    timezone: d.timezone || "UTC",
  };
}

function TriggerRow({
  trigger,
  onChange,
  onRemove,
}: {
  trigger: RoutineTriggerDraft;
  onChange: (t: RoutineTriggerDraft) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{trigger.kind}</Badge>
          <Input
            className="h-7 w-48"
            placeholder="Label (optional)"
            value={trigger.label}
            onChange={(e) => onChange({ ...trigger, label: e.target.value })}
          />
        </div>
        <div className="flex items-center gap-2">
          <ToggleSwitch
            checked={trigger.enabled}
            onCheckedChange={(v) => onChange({ ...trigger, enabled: v })}
          />
          <Button size="sm" variant="ghost" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {trigger.kind === "schedule" && (
        <div className="grid grid-cols-2 gap-2">
          <Input
            placeholder="cron expression"
            value={trigger.cronExpression}
            onChange={(e) => onChange({ ...trigger, cronExpression: e.target.value })}
          />
          <Input
            placeholder="timezone (e.g. America/New_York)"
            value={trigger.timezone}
            onChange={(e) => onChange({ ...trigger, timezone: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}

function SkillEditor({ id }: { id: string | null }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deployOpen, setDeployOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: queryKeys.templates.detail("skill", id ?? "new"),
    queryFn: () => templatesApi.getSkill(id!),
    enabled: Boolean(id),
  });
  const detail = detailQuery.data;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [skillKey, setSkillKey] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [markdown, setMarkdown] = useState("");

  useEffect(() => {
    if (!detail) return;
    setName(detail.name);
    setDescription(detail.description ?? "");
    setSkillKey(detail.skillKey);
    setSkillName(detail.skillName);
    setSkillDescription(detail.skillDescription ?? "");
    setMarkdown(detail.markdown);
  }, [detail?.id]);

  const buildBody = (): CreateSkillTemplate => ({
    name: name.trim(),
    description: description.trim() || null,
    skillKey: skillKey.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    skillName: skillName.trim(),
    skillDescription: skillDescription.trim() || null,
    markdown,
  });

  const createMutation = useMutation({
    mutationFn: () => templatesApi.createSkill(buildBody()),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.templates.list("skill") });
      navigate(`/instance/settings/templates/skill/${created.id}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => templatesApi.updateSkill(id!, buildBody()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.templates.list("skill") });
      await queryClient.invalidateQueries({ queryKey: queryKeys.templates.detail("skill", id!) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => templatesApi.remove("skill", id!),
    onSuccess: () => {
      navigate("/instance/settings/templates");
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates.list("skill") });
    },
  });

  const saving = createMutation.isPending || updateMutation.isPending;
  const error = createMutation.error || updateMutation.error;

  const valid = name.trim() && skillKey.trim() && skillName.trim() && markdown.trim();

  return (
    <div className="space-y-6 max-w-4xl">
      <BackLink />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          {id ? `Skill template: ${detail?.name ?? "Loading"}` : "New skill template"}
        </h1>
        {id && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setDeployOpen(true)}>
              <Rocket className="h-3.5 w-3.5" /> Deploy
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirm("Delete this template? Deployed skills stay in place.")) {
                  deleteMutation.mutate();
                }
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <Field label="Template name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Template description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Skill key (slug)">
              <Input
                value={skillKey}
                onChange={(e) => setSkillKey(e.target.value)}
                placeholder="e.g. daily-support-report"
              />
            </Field>
            <Field label="Skill display name">
              <Input value={skillName} onChange={(e) => setSkillName(e.target.value)} />
            </Field>
          </div>
          <Field label="Skill description">
            <Input value={skillDescription} onChange={(e) => setSkillDescription(e.target.value)} />
          </Field>
          <Field label="SKILL.md content">
            <Textarea
              className="font-mono text-xs"
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              rows={20}
              placeholder="---&#10;name: my-skill&#10;description: ...&#10;---&#10;&#10;# My Skill&#10;..."
            />
          </Field>
        </CardContent>
      </Card>

      {error && (
        <div className="text-sm text-destructive">{(error as Error).message}</div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" asChild>
          <Link to="/instance/settings/templates">Cancel</Link>
        </Button>
        <Button onClick={() => (id ? updateMutation.mutate() : createMutation.mutate())} disabled={saving || !valid}>
          <Save className="h-3.5 w-3.5" /> {saving ? "Saving..." : id ? "Save changes" : "Create template"}
        </Button>
      </div>

      {id && detail && (
        <>
          <DeploymentsList type="skill" deployments={detail.deployments} />
          <TemplateDeployDialog
            type="skill"
            templateId={detail.id}
            templateName={detail.name}
            existingDeployments={detail.deployments}
            open={deployOpen}
            onOpenChange={setDeployOpen}
          />
        </>
      )}
    </div>
  );
}

function AgentEditor({ id }: { id: string | null }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deployOpen, setDeployOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: queryKeys.templates.detail("agent", id ?? "new"),
    queryFn: () => templatesApi.getAgent(id!),
    enabled: Boolean(id),
  });
  const detail = detailQuery.data;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agentName, setAgentName] = useState("");
  const [role, setRole] = useState("general");
  const [title, setTitle] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [adapterType, setAdapterType] = useState("process");
  const [budgetMonthlyCents, setBudgetMonthlyCents] = useState(0);

  useEffect(() => {
    if (!detail) return;
    setName(detail.name);
    setDescription(detail.description ?? "");
    setAgentName(detail.agentName);
    setRole(detail.role);
    setTitle(detail.title ?? "");
    setCapabilities(detail.capabilities ?? "");
    setAdapterType(detail.adapterType);
    setBudgetMonthlyCents(detail.budgetMonthlyCents);
  }, [detail?.id]);

  const buildBody = (): CreateAgentTemplate => ({
    name: name.trim(),
    description: description.trim() || null,
    agentName: agentName.trim(),
    role: role.trim(),
    title: title.trim() || null,
    icon: null,
    capabilities: capabilities.trim() || null,
    adapterType: adapterType.trim(),
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    forbiddenWritePaths: [],
    budgetMonthlyCents: Number(budgetMonthlyCents) || 0,
  });

  const createMutation = useMutation({
    mutationFn: () => templatesApi.createAgent(buildBody()),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.templates.list("agent") });
      navigate(`/instance/settings/templates/agent/${created.id}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => templatesApi.updateAgent(id!, buildBody()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.templates.list("agent") });
      await queryClient.invalidateQueries({ queryKey: queryKeys.templates.detail("agent", id!) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => templatesApi.remove("agent", id!),
    onSuccess: () => {
      navigate("/instance/settings/templates");
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates.list("agent") });
    },
  });

  const saving = createMutation.isPending || updateMutation.isPending;
  const error = createMutation.error || updateMutation.error;
  const valid = name.trim() && agentName.trim();

  return (
    <div className="space-y-6 max-w-4xl">
      <BackLink />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          {id ? `Agent template: ${detail?.name ?? "Loading"}` : "New agent template"}
        </h1>
        {id && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setDeployOpen(true)}>
              <Rocket className="h-3.5 w-3.5" /> Deploy
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirm("Delete this template? Deployed agents stay in place.")) {
                  deleteMutation.mutate();
                }
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <Field label="Template name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Template description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Agent name">
              <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="e.g. Steward" />
            </Field>
            <Field label="Role">
              <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. ceo, coo, support_lead" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Title (optional)">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Adapter type">
              <Input value={adapterType} onChange={(e) => setAdapterType(e.target.value)} placeholder="e.g. claude_local" />
            </Field>
          </div>
          <Field label="Capabilities (free text)">
            <Textarea value={capabilities} onChange={(e) => setCapabilities(e.target.value)} rows={3} />
          </Field>
          <Field label="Monthly budget (cents)">
            <Input
              type="number"
              value={budgetMonthlyCents}
              onChange={(e) => setBudgetMonthlyCents(Number(e.target.value))}
            />
          </Field>
        </CardContent>
      </Card>

      {error && (
        <div className="text-sm text-destructive">{(error as Error).message}</div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" asChild>
          <Link to="/instance/settings/templates">Cancel</Link>
        </Button>
        <Button onClick={() => (id ? updateMutation.mutate() : createMutation.mutate())} disabled={saving || !valid}>
          <Save className="h-3.5 w-3.5" /> {saving ? "Saving..." : id ? "Save changes" : "Create template"}
        </Button>
      </div>

      {id && detail && (
        <>
          <DeploymentsList type="agent" deployments={detail.deployments} />
          <TemplateDeployDialog
            type="agent"
            templateId={detail.id}
            templateName={detail.name}
            existingDeployments={detail.deployments}
            open={deployOpen}
            onOpenChange={setDeployOpen}
          />
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function DeploymentsList({
  type,
  deployments,
}: {
  type: TemplateType;
  deployments: AgentTemplateDetail["deployments"];
}) {
  const sorted = useMemo(
    () =>
      [...deployments].sort((a, b) =>
        new Date(b.deployedAt).getTime() - new Date(a.deployedAt).getTime(),
      ),
    [deployments],
  );

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div>
          <h2 className="text-sm font-semibold">Deployments</h2>
          <p className="text-xs text-muted-foreground">
            Companies that received this {TYPE_LABEL[type].toLowerCase()} template.
          </p>
        </div>
        {sorted.length === 0 ? (
          <div className="text-xs italic text-muted-foreground">Not deployed yet.</div>
        ) : (
          <ul className="text-sm divide-y rounded-md border">
            {sorted.map((d) => (
              <li key={d.id} className="px-3 py-2 flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">{d.companyName ?? d.companyId}</div>
                  <div className="text-xs text-muted-foreground">
                    Deployed {new Date(d.deployedAt).toLocaleString()}
                    {d.lastSyncedAt && (
                      <> &middot; synced {new Date(d.lastSyncedAt).toLocaleString()}</>
                    )}
                  </div>
                </div>
                {d.deployedEntityId && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {d.deployedEntityId.slice(0, 8)}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
