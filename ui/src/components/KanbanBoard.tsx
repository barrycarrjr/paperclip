import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import type { Issue } from "@paperclipai/shared";
import { DEFAULT_KANBAN_CARD_FIELDS, type KanbanCardField } from "../lib/inbox";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { timeAgo } from "../lib/timeAgo";

const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

// Fractional indexing step. Matches the server-side default; only used by the
// UI when one of the neighbors is null (drop at top/bottom of a column).
const SORT_ORDER_STEP = 1000;

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function compareBySortOrder(a: Issue, b: Issue): number {
  const ao = Number.isFinite(a.sortOrder) ? a.sortOrder : 0;
  const bo = Number.isFinite(b.sortOrder) ? b.sortOrder : 0;
  if (ao !== bo) return ao - bo;
  return a.id.localeCompare(b.id);
}

function midpointSortOrder(prev: number | null, next: number | null): number {
  if (prev == null && next == null) return SORT_ORDER_STEP;
  if (prev == null) return (next as number) - SORT_ORDER_STEP;
  if (next == null) return prev + SORT_ORDER_STEP;
  return (prev + next) / 2;
}

interface Agent {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
  color?: string | null;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  projects?: Project[];
  liveIssueIds?: Set<string>;
  visibleFields?: ReadonlySet<KanbanCardField>;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

const DEFAULT_VISIBLE_FIELDS: ReadonlySet<KanbanCardField> = new Set(DEFAULT_KANBAN_CARD_FIELDS);

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  issues,
  agents,
  projects,
  liveIssueIds,
  visibleFields,
}: {
  status: string;
  issues: Issue[];
  agents?: Agent[];
  projects?: Project[];
  liveIssueIds?: Set<string>;
  visibleFields: ReadonlySet<KanbanCardField>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div className="flex flex-col shrink-0 min-w-[260px] w-[260px]">
      <div className="flex items-center gap-2 px-2 py-2 mb-1">
        <StatusIcon status={status} />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {statusLabel(status)}
        </span>
        <span className="text-xs text-muted-foreground/60 ml-auto tabular-nums">
          {issues.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-[120px] rounded-md p-1 space-y-1 transition-colors ${
          isOver ? "bg-accent/40" : "bg-muted/20"
        }`}
      >
        <SortableContext
          items={issues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {issues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              agents={agents}
              projects={projects}
              isLive={liveIssueIds?.has(issue.id)}
              visibleFields={visibleFields}
            />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

/* ── Sortable Card ── */

function KanbanCard({
  issue,
  agents,
  projects,
  isLive,
  isOverlay,
  visibleFields,
}: {
  issue: Issue;
  agents?: Agent[];
  projects?: Project[];
  isLive?: boolean;
  isOverlay?: boolean;
  visibleFields: ReadonlySet<KanbanCardField>;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { issue }, disabled: isOverlay });

  const style = isOverlay
    ? undefined
    : {
        transform: CSS.Transform.toString(transform),
        transition,
      };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  const project = issue.projectId ? projects?.find((p) => p.id === issue.projectId) ?? null : null;
  const showId = visibleFields.has("id");
  const showPriority = visibleFields.has("priority");
  const showAssignee = visibleFields.has("assignee");
  const showProject = visibleFields.has("project") && project;
  const showLabels = visibleFields.has("labels") && (issue.labels?.length ?? 0) > 0;
  const showParent = visibleFields.has("parent") && issue.parentId;
  const showDue = visibleFields.has("due") && issue.dueDate;
  const showUpdated = visibleFields.has("updated");

  const hasFooter = showPriority || showAssignee || showProject;
  const hasMeta = showLabels || showParent || showDue || showUpdated;

  return (
    <div
      ref={isOverlay ? undefined : setNodeRef}
      style={style}
      {...(isOverlay ? {} : attributes)}
      {...(isOverlay ? {} : listeners)}
      className={`rounded-md border bg-card p-2.5 cursor-grab active:cursor-grabbing transition-shadow ${
        isDragging && !isOverlay ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm"}`}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        disableIssueQuicklook
        className="block no-underline text-inherit"
        onClick={(e) => {
          if (isDragging) e.preventDefault();
        }}
      >
        {(showId || isLive) && (
          <div className="flex items-start gap-1.5 mb-1.5">
            {showId && (
              <span className="text-xs text-muted-foreground font-mono shrink-0">
                {issue.identifier ?? issue.id.slice(0, 8)}
              </span>
            )}
            {isLive && (
              <span className="relative flex h-2 w-2 shrink-0 mt-0.5">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
            )}
          </div>
        )}
        <p className="text-sm leading-snug line-clamp-2 mb-2">{issue.title}</p>
        {hasFooter && (
          <div className="flex items-center gap-2">
            {showPriority && <PriorityIcon priority={issue.priority} />}
            {showAssignee && issue.assigneeAgentId && (() => {
              const name = agentName(issue.assigneeAgentId);
              return name ? (
                <Identity name={name} size="xs" />
              ) : (
                <span className="text-xs text-muted-foreground font-mono">
                  {issue.assigneeAgentId.slice(0, 8)}
                </span>
              );
            })()}
            {showProject && project && (
              <span
                className="inline-flex min-w-0 items-center gap-1 text-[11px] font-medium truncate"
                style={{ color: pickTextColorForPillBg(project.color ?? "#64748b", 0.12) }}
                title={project.name}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: project.color ?? "#64748b" }}
                />
                <span className="truncate">{project.name}</span>
              </span>
            )}
          </div>
        )}
        {hasMeta && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {showLabels && (
              <span className="flex items-center gap-1">
                {(issue.labels ?? []).slice(0, 2).map((label) => (
                  <span
                    key={label.id}
                    className="inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-medium"
                    style={{
                      borderColor: label.color,
                      color: pickTextColorForPillBg(label.color, 0.12),
                      backgroundColor: `${label.color}1f`,
                    }}
                  >
                    {label.name}
                  </span>
                ))}
                {(issue.labels?.length ?? 0) > 2 && (
                  <span className="text-[10px]">+{(issue.labels?.length ?? 0) - 2}</span>
                )}
              </span>
            )}
            {showParent && (
              <span className="font-mono">↳ sub-issue</span>
            )}
            {showDue && issue.dueDate && (
              <span>due {new Date(issue.dueDate).toLocaleDateString()}</span>
            )}
            {showUpdated && (
              <span className="ml-auto">
                {timeAgo(issue.lastActivityAt ?? issue.lastExternalCommentAt ?? issue.updatedAt)}
              </span>
            )}
          </div>
        )}
      </Link>
    </div>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  projects,
  liveIssueIds,
  visibleFields,
  onUpdateIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const fields = visibleFields ?? DEFAULT_VISIBLE_FIELDS;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const columnIssues = useMemo(() => {
    const grouped: Record<string, Issue[]> = {};
    for (const status of boardStatuses) {
      grouped[status] = [];
    }
    for (const issue of issues) {
      if (grouped[issue.status]) {
        grouped[issue.status].push(issue);
      }
    }
    for (const status of boardStatuses) {
      grouped[status].sort(compareBySortOrder);
    }
    return grouped;
  }, [issues]);

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const activeIdStr = active.id as string;
    const overIdStr = over.id as string;
    if (activeIdStr === overIdStr) return;

    const issue = issues.find((i) => i.id === activeIdStr);
    if (!issue) return;

    const overIsColumn = boardStatuses.includes(overIdStr);
    const overIssue = overIsColumn ? null : issues.find((i) => i.id === overIdStr) ?? null;
    if (!overIsColumn && !overIssue) return;

    const targetStatus = overIsColumn ? overIdStr : overIssue!.status;
    const targetColumn = columnIssues[targetStatus] ?? [];

    if (targetStatus === issue.status) {
      // Same column reorder. Drop position is determined by the card we're
      // over; if we're over the column background, place at bottom.
      if (!overIssue) return;
      const filtered = targetColumn.filter((i) => i.id !== issue.id);
      const overIdx = filtered.findIndex((i) => i.id === overIssue.id);
      if (overIdx === -1) return;
      const prev = filtered[overIdx - 1] ?? null;
      const next = filtered[overIdx] ?? null;
      onUpdateIssue(issue.id, {
        sortOrder: midpointSortOrder(prev?.sortOrder ?? null, next?.sortOrder ?? null),
      });
      return;
    }

    // Cross-column move. If dropped on a specific card, slot in at that
    // position; otherwise drop at the bottom of the target column.
    const payload: Record<string, unknown> = { status: targetStatus };
    if (overIssue) {
      const overIdx = targetColumn.findIndex((i) => i.id === overIssue.id);
      const prev = targetColumn[overIdx - 1] ?? null;
      const next = targetColumn[overIdx] ?? null;
      payload.sortOrder = midpointSortOrder(prev?.sortOrder ?? null, next?.sortOrder ?? null);
    } else {
      const last = targetColumn[targetColumn.length - 1] ?? null;
      payload.sortOrder = midpointSortOrder(last?.sortOrder ?? null, null);
    }
    onUpdateIssue(issue.id, payload);
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2">
        {boardStatuses.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            issues={columnIssues[status] ?? []}
            agents={agents}
            projects={projects}
            liveIssueIds={liveIssueIds}
            visibleFields={fields}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard
            issue={activeIssue}
            agents={agents}
            projects={projects}
            isOverlay
            visibleFields={fields}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
