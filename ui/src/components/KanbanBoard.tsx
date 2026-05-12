import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
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

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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

/* ── Draggable Card ── */

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
  } = useSortable({ id: issue.id, data: { issue } });

  const style = {
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
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
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

    const issueId = active.id as string;
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    let targetStatus: string | null = null;

    if (boardStatuses.includes(over.id as string)) {
      targetStatus = over.id as string;
    } else {
      const targetIssue = issues.find((i) => i.id === over.id);
      if (targetIssue) {
        targetStatus = targetIssue.status;
      }
    }

    if (targetStatus && targetStatus !== issue.status) {
      onUpdateIssue(issueId, { status: targetStatus });
    }
  }

  function handleDragOver(_event: DragOverEvent) {
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
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
