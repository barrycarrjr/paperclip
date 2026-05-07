import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, Plus, X } from "lucide-react";
import type { WorkQueue, WorkQueueItem, WorkQueueItemStatus } from "@paperclipai/shared";
import { WORK_QUEUE_ITEM_STATUSES } from "@paperclipai/shared";
import { workQueuesApi } from "@/api/work-queues";
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

const queueListKey = (companyId: string) => ["work-queues", companyId] as const;
const queueItemsKey = (queueId: string, status: WorkQueueItemStatus | "all") =>
  ["work-queue-items", queueId, status] as const;

const STATUS_VARIANT: Record<WorkQueueItemStatus, "default" | "secondary" | "outline" | "destructive"> = {
  pending: "outline",
  claimed: "secondary",
  completed: "default",
  failed: "destructive",
  cancelled: "outline",
};

const selectClass =
  "border-input h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function formatDate(value: Date | string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function tryParseJson(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Payload must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid JSON" };
  }
}

export function WorkQueues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Work queues" }]);
  }, [setBreadcrumbs]);

  const queuesQuery = useQuery({
    queryKey: queueListKey(selectedCompanyId ?? ""),
    queryFn: () => workQueuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null);
  const queues = queuesQuery.data ?? [];

  useEffect(() => {
    if (queues.length === 0) {
      setSelectedQueueId(null);
      return;
    }
    if (!selectedQueueId || !queues.find((q) => q.id === selectedQueueId)) {
      setSelectedQueueId(queues[0]?.id ?? null);
    }
  }, [queues, selectedQueueId]);

  const [statusFilter, setStatusFilter] = useState<WorkQueueItemStatus | "all">("all");

  const itemsQuery = useQuery({
    queryKey: queueItemsKey(selectedQueueId ?? "", statusFilter),
    queryFn: () =>
      workQueuesApi.listItems(selectedQueueId!, {
        status: statusFilter === "all" ? undefined : statusFilter,
        limit: 200,
      }),
    enabled: !!selectedQueueId,
  });

  const [createQueueOpen, setCreateQueueOpen] = useState(false);
  const [queueForm, setQueueForm] = useState({ slug: "", name: "", description: "" });

  const [enqueueOpen, setEnqueueOpen] = useState(false);
  const [enqueueForm, setEnqueueForm] = useState({
    payload: "{}",
    externalSource: "",
    externalId: "",
    priority: "0",
  });
  const [payloadError, setPayloadError] = useState<string | null>(null);

  const createQueueMutation = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return workQueuesApi.create(selectedCompanyId, {
        slug: queueForm.slug.trim(),
        name: queueForm.name.trim(),
        description: queueForm.description.trim() || null,
      });
    },
    onSuccess: (queue) => {
      pushToast({ tone: "success", title: `Queue "${queue.name}" created` });
      setCreateQueueOpen(false);
      setQueueForm({ slug: "", name: "", description: "" });
      setSelectedQueueId(queue.id);
      queryClient.invalidateQueries({ queryKey: queueListKey(selectedCompanyId!) });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Could not create queue",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const enqueueMutation = useMutation({
    mutationFn: () => {
      if (!selectedQueueId) throw new Error("No queue selected");
      const parsed = tryParseJson(enqueueForm.payload);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      return workQueuesApi.enqueue(selectedQueueId, {
        payload: parsed.value,
        externalSource: enqueueForm.externalSource.trim() || null,
        externalId: enqueueForm.externalId.trim() || null,
        priority: Number(enqueueForm.priority) || 0,
      });
    },
    onSuccess: () => {
      pushToast({ tone: "success", title: "Item added to queue" });
      setEnqueueOpen(false);
      setEnqueueForm({ payload: "{}", externalSource: "", externalId: "", priority: "0" });
      setPayloadError(null);
      if (selectedQueueId) {
        queryClient.invalidateQueries({ queryKey: ["work-queue-items", selectedQueueId] });
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      setPayloadError(message);
      pushToast({ tone: "error", title: "Could not enqueue item", body: message });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (itemId: string) => workQueuesApi.cancelItem(itemId),
    onSuccess: () => {
      pushToast({ tone: "success", title: "Item cancelled" });
      if (selectedQueueId) {
        queryClient.invalidateQueries({ queryKey: ["work-queue-items", selectedQueueId] });
      }
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Could not cancel item",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const items = itemsQuery.data ?? [];

  const counts = useMemo(() => {
    const out: Record<WorkQueueItemStatus, number> = {
      pending: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const item of items) out[item.status] += 1;
    return out;
  }, [items]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Inbox} message="Select a company to view its work queues." />;
  }

  if (queuesQuery.isLoading) return <PageSkeleton variant="list" />;

  const selectedQueue: WorkQueue | undefined = queues.find((q) => q.id === selectedQueueId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Work queues</h1>
        <Button size="sm" onClick={() => setCreateQueueOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New queue
        </Button>
      </div>

      {queues.length === 0 ? (
        <EmptyState
          icon={Inbox}
          message="No queues yet. Create one to give agents a steady stream of work — support tickets, lead intake, error monitoring, anything that arrives continuously."
          action="Create your first queue"
          onAction={() => setCreateQueueOpen(true)}
        />
      ) : (
        <div className="grid grid-cols-[200px_1fr] gap-4">
          <aside className="space-y-1">
            {queues.map((queue) => (
              <button
                key={queue.id}
                type="button"
                onClick={() => setSelectedQueueId(queue.id)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${
                  queue.id === selectedQueueId
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted"
                }`}
              >
                <div className="font-medium">{queue.name}</div>
                <div className="text-xs text-muted-foreground">/{queue.slug}</div>
                {!queue.isActive && (
                  <Badge variant="outline" className="mt-1 text-xs">
                    Paused
                  </Badge>
                )}
              </button>
            ))}
          </aside>

          <section className="space-y-3">
            {selectedQueue && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm">
                    <span className="font-medium">{selectedQueue.name}</span>
                    {selectedQueue.description && (
                      <span className="text-muted-foreground">
                        {" "}
                        — {selectedQueue.description}
                      </span>
                    )}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <select
                      className={`${selectClass} max-w-[140px]`}
                      value={statusFilter}
                      onChange={(e) =>
                        setStatusFilter(e.target.value as WorkQueueItemStatus | "all")
                      }
                    >
                      <option value="all">All statuses</option>
                      {WORK_QUEUE_ITEM_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!selectedQueue.isActive}
                      onClick={() => setEnqueueOpen(true)}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1.5" />
                      Add item
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>Pending: {counts.pending}</span>
                  <span>Claimed: {counts.claimed}</span>
                  <span>Completed: {counts.completed}</span>
                  <span>Failed: {counts.failed}</span>
                  <span>Cancelled: {counts.cancelled}</span>
                </div>

                {items.length === 0 ? (
                  <EmptyState
                    icon={Inbox}
                    message="No items match this filter."
                  />
                ) : (
                  <div className="rounded-md border bg-card">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <tr className="border-b">
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2 font-medium">Source</th>
                          <th className="px-3 py-2 font-medium">Priority</th>
                          <th className="px-3 py-2 font-medium">Created</th>
                          <th className="px-3 py-2 font-medium">Updated</th>
                          <th className="px-3 py-2 w-10" />
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((item) => (
                          <ItemRow
                            key={item.id}
                            item={item}
                            onCancel={() => cancelMutation.mutate(item.id)}
                            cancelling={cancelMutation.isPending}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}

      <Dialog open={createQueueOpen} onOpenChange={setCreateQueueOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New work queue</DialogTitle>
            <DialogDescription>
              A queue is a named work stream — support tickets, leads, errors, etc. — that
              agents claim from one item at a time.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="q-slug">Slug</Label>
              <Input
                id="q-slug"
                value={queueForm.slug}
                onChange={(e) => setQueueForm({ ...queueForm, slug: e.target.value })}
                placeholder="support"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Lowercase letters, numbers, hyphens. Used in API paths and webhook URLs.
              </p>
            </div>
            <div>
              <Label htmlFor="q-name">Name</Label>
              <Input
                id="q-name"
                value={queueForm.name}
                onChange={(e) => setQueueForm({ ...queueForm, name: e.target.value })}
                placeholder="Support tickets"
              />
            </div>
            <div>
              <Label htmlFor="q-desc">Description (optional)</Label>
              <Input
                id="q-desc"
                value={queueForm.description}
                onChange={(e) =>
                  setQueueForm({ ...queueForm, description: e.target.value })
                }
                placeholder="Inbound from Help Scout"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => setCreateQueueOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                createQueueMutation.isPending ||
                queueForm.slug.trim().length === 0 ||
                queueForm.name.trim().length === 0
              }
              onClick={() => createQueueMutation.mutate()}
            >
              {createQueueMutation.isPending ? "Creating…" : "Create queue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={enqueueOpen}
        onOpenChange={(open) => {
          setEnqueueOpen(open);
          if (!open) setPayloadError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add item</DialogTitle>
            <DialogDescription>
              Drop a payload into the queue. Agents claim items in priority then arrival
              order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="i-payload">Payload (JSON object)</Label>
              <Textarea
                id="i-payload"
                value={enqueueForm.payload}
                onChange={(e) => {
                  setEnqueueForm({ ...enqueueForm, payload: e.target.value });
                  setPayloadError(null);
                }}
                rows={6}
                className="font-mono text-xs"
              />
              {payloadError && (
                <p className="mt-1 text-xs text-destructive">{payloadError}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="i-source">External source</Label>
                <Input
                  id="i-source"
                  value={enqueueForm.externalSource}
                  onChange={(e) =>
                    setEnqueueForm({ ...enqueueForm, externalSource: e.target.value })
                  }
                  placeholder="help_scout"
                />
              </div>
              <div>
                <Label htmlFor="i-id">External ID</Label>
                <Input
                  id="i-id"
                  value={enqueueForm.externalId}
                  onChange={(e) =>
                    setEnqueueForm({ ...enqueueForm, externalId: e.target.value })
                  }
                  placeholder="ticket-12345"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="i-priority">Priority (-1000 to 1000)</Label>
              <Input
                id="i-priority"
                type="number"
                value={enqueueForm.priority}
                onChange={(e) =>
                  setEnqueueForm({ ...enqueueForm, priority: e.target.value })
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Items with higher priority are claimed first. External source + ID together must
              be unique within the queue (or both blank).
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => setEnqueueOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={enqueueMutation.isPending}
              onClick={() => enqueueMutation.mutate()}
            >
              {enqueueMutation.isPending ? "Adding…" : "Add to queue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ItemRowProps {
  item: WorkQueueItem;
  onCancel: () => void;
  cancelling: boolean;
}

function ItemRow({ item, onCancel, cancelling }: ItemRowProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr className="border-b last:border-b-0 align-top hover:bg-muted/40">
        <td className="px-3 py-2">
          <Badge variant={STATUS_VARIANT[item.status]} className="capitalize">
            {item.status}
          </Badge>
          {item.failureReason && (
            <div className="mt-1 max-w-xs text-xs text-destructive line-clamp-2">
              {item.failureReason}
            </div>
          )}
        </td>
        <td className="px-3 py-2 text-xs">
          {item.externalSource || item.externalId ? (
            <div>
              {item.externalSource && (
                <span className="font-medium">{item.externalSource}</span>
              )}
              {item.externalSource && item.externalId && " / "}
              {item.externalId && (
                <span className="text-muted-foreground">{item.externalId}</span>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
          <button
            type="button"
            className="mt-1 text-xs underline-offset-2 hover:underline"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? "Hide payload" : "Show payload"}
          </button>
        </td>
        <td className="px-3 py-2 text-xs text-muted-foreground">{item.priority}</td>
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {formatDate(item.createdAt)}
        </td>
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {formatDate(item.updatedAt)}
        </td>
        <td className="px-3 py-2">
          {item.status === "pending" && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Cancel item"
              disabled={cancelling}
              onClick={onCancel}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b last:border-b-0 bg-muted/20">
          <td colSpan={6} className="px-3 py-2">
            <pre className="whitespace-pre-wrap break-all font-mono text-xs">
              {JSON.stringify(item.payload, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
