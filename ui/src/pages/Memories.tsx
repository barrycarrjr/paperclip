import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type { Memory, MemoryKind } from "@paperclipai/shared";
import { MEMORY_KINDS } from "@paperclipai/shared";
import { memoriesApi } from "@/api/memories";
import { agentsApi } from "@/api/agents";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";

const memoriesQueryKey = (companyId: string, filter: Record<string, unknown>) =>
  ["memories", companyId, filter] as const;

const KIND_LABELS: Record<MemoryKind, string> = {
  user: "User",
  feedback: "Feedback",
  project: "Project",
  reference: "Reference",
};

const KIND_DESCRIPTIONS: Record<MemoryKind, string> = {
  user: "Facts about the operator and how they work",
  feedback: "Corrections, preferences, and validated approaches",
  project: "Ongoing work, deadlines, and decisions",
  reference: "Pointers to where information lives outside this company",
};

const selectClass =
  "border-input h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

interface CreateForm {
  kind: MemoryKind;
  name: string;
  description: string;
  content: string;
  agentId: string;
}

function emptyForm(): CreateForm {
  return { kind: "user", name: "", description: "", content: "", agentId: "" };
}

function formatDate(value: Date | string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function Memories() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Memories" }]);
  }, [setBreadcrumbs]);

  const [kindFilter, setKindFilter] = useState<MemoryKind | "">("");
  const [agentFilter, setAgentFilter] = useState("");
  const [search, setSearch] = useState("");

  const filter = useMemo(
    () => ({
      kind: kindFilter || undefined,
      agentId: agentFilter || undefined,
      q: search.trim() || undefined,
    }),
    [kindFilter, agentFilter, search],
  );

  const memoriesQuery = useQuery({
    queryKey: memoriesQueryKey(selectedCompanyId ?? "", filter),
    queryFn: () => memoriesApi.list(selectedCompanyId!, filter),
    enabled: !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: ["agents", selectedCompanyId, "for-memory-filter"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyForm);
  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null);

  const createMutation = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      const payload = {
        kind: createForm.kind,
        name: createForm.name.trim(),
        description: createForm.description.trim() || null,
        content: createForm.content,
        agentId: createForm.agentId || null,
      };
      return memoriesApi.create(selectedCompanyId, payload);
    },
    onSuccess: () => {
      pushToast({ tone: "success", title: "Memory saved" });
      setCreateOpen(false);
      setCreateForm(emptyForm());
      queryClient.invalidateQueries({ queryKey: ["memories", selectedCompanyId] });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Could not save memory",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (memory: Memory) => memoriesApi.remove(memory.id),
    onSuccess: () => {
      pushToast({ tone: "success", title: "Memory deleted" });
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["memories", selectedCompanyId] });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Could not delete memory",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to view its memories." />;
  }

  if (memoriesQuery.isLoading) return <PageSkeleton variant="list" />;

  const memories = memoriesQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));

  const canSubmit =
    createForm.name.trim().length > 0 && createForm.content.trim().length > 0 && !createMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-xs">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search name, description or content"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-7"
          />
        </div>
        <select
          className={`${selectClass} max-w-[160px]`}
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as MemoryKind | "")}
        >
          <option value="">All kinds</option>
          {MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <select
          className={`${selectClass} max-w-[200px]`}
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Memory
          </Button>
        </div>
      </div>

      {memoriesQuery.error && (
        <p className="text-sm text-destructive">{memoriesQuery.error.message}</p>
      )}

      {memories.length === 0 ? (
        <EmptyState
          icon={Brain}
          message={
            search || kindFilter || agentFilter
              ? "No memories match these filters."
              : "No memories yet. Agents and operators can save durable notes here so the next run starts warm."
          }
          action="Add Memory"
          onAction={() => setCreateOpen(true)}
        />
      ) : (
        <div className="rounded-md border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Scope</th>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {memories.map((memory) => (
                <tr key={memory.id} className="border-b last:border-b-0 align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{memory.name}</div>
                    {memory.description && (
                      <div className="text-xs text-muted-foreground">{memory.description}</div>
                    )}
                    <div className="mt-1 max-w-xl text-xs text-muted-foreground line-clamp-2 whitespace-pre-wrap">
                      {memory.content}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className="capitalize">
                      {memory.kind}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {memory.agentId ? (
                      <span className="text-muted-foreground">
                        Agent: {agentNameById.get(memory.agentId) ?? memory.agentId.slice(0, 8)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Company-wide</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {formatDate(memory.updatedAt)}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete memory ${memory.name}`}
                      onClick={() => setDeleteTarget(memory)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New memory</DialogTitle>
            <DialogDescription>
              Save a durable note that agents and operators can recall later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="mem-kind">Kind</Label>
              <select
                id="mem-kind"
                className={selectClass}
                value={createForm.kind}
                onChange={(e) =>
                  setCreateForm({ ...createForm, kind: e.target.value as MemoryKind })
                }
              >
                {MEMORY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]} — {KIND_DESCRIPTIONS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="mem-name">Name</Label>
              <Input
                id="mem-name"
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                placeholder="e.g. customer_smith"
              />
            </div>
            <div>
              <Label htmlFor="mem-desc">Description (optional)</Label>
              <Input
                id="mem-desc"
                value={createForm.description}
                onChange={(e) =>
                  setCreateForm({ ...createForm, description: e.target.value })
                }
                placeholder="One-line summary"
              />
            </div>
            <div>
              <Label htmlFor="mem-content">Content</Label>
              <Textarea
                id="mem-content"
                value={createForm.content}
                onChange={(e) => setCreateForm({ ...createForm, content: e.target.value })}
                rows={6}
                placeholder="The full memory body"
              />
            </div>
            <div>
              <Label htmlFor="mem-agent">Scope</Label>
              <select
                id="mem-agent"
                className={selectClass}
                value={createForm.agentId}
                onChange={(e) => setCreateForm({ ...createForm, agentId: e.target.value })}
              >
                <option value="">Company-wide</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    Agent: {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} type="button">
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? "Saving…" : "Save memory"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete memory?</DialogTitle>
            <DialogDescription>
              This permanently removes "{deleteTarget?.name}". Agents will no longer recall it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} type="button">
              Cancel
            </Button>
            <Button
              variant="destructive"
              type="button"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
