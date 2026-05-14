import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { LucideIcon } from "lucide-react";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { usePortfolioNavOrder } from "../hooks/usePortfolioNavOrder";
import { SidebarNavItem } from "./SidebarNavItem";

export interface PortfolioNavEntry {
  id: string;
  to: string;
  label: string;
  icon: LucideIcon;
  info?: string;
}

function SortableNavItem({ entry }: { entry: PortfolioNavEntry }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  // Whole-row drag matches the CompanyRail pattern. Spread sortable listeners
  // on a wrapper that doesn't intercept the NavLink's click — dnd-kit's
  // distance-based activation (4px) means a click without movement still
  // navigates.
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <SidebarNavItem
        to={entry.to}
        label={entry.label}
        icon={entry.icon}
        info={entry.info}
      />
    </div>
  );
}

interface PortfolioNavListProps {
  entries: PortfolioNavEntry[];
}

export function PortfolioNavList({ entries }: PortfolioNavListProps) {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id ?? session?.session?.userId ?? null;

  const allIds = useMemo(() => entries.map((e) => e.id), [entries]);
  const entriesById = useMemo(() => {
    const map = new Map<string, PortfolioNavEntry>();
    for (const e of entries) map.set(e.id, e);
    return map;
  }, [entries]);

  const { orderedIds, persistOrder } = usePortfolioNavOrder({ allIds, userId });

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIdx = orderedIds.indexOf(String(active.id));
    const toIdx = orderedIds.indexOf(String(over.id));
    if (fromIdx === -1 || toIdx === -1) return;
    persistOrder(arrayMove(orderedIds, fromIdx, toIdx));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
        {orderedIds.map((id) => {
          const entry = entriesById.get(id);
          if (!entry) return null;
          return <SortableNavItem key={id} entry={entry} />;
        })}
      </SortableContext>
    </DndContext>
  );
}
