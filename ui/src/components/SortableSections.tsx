import { useMemo, type ReactNode } from "react";
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
import { GripVertical } from "lucide-react";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { usePageSectionOrder } from "../hooks/usePageSectionOrder";
import { cn } from "../lib/utils";

export interface SortableSection {
  id: string;
  render: () => ReactNode;
}

interface SortableSectionsProps {
  pageKey: string;
  sections: SortableSection[];
  className?: string;
}

function SortableItem({ id, children }: { id: string; children: ReactNode }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  return (
    // pl-6 / -ml-6 extends the hover region 24px into the gutter so the
    // handle stays "inside" the hover area while the content position
    // doesn't shift.
    <div
      ref={setNodeRef}
      style={style}
      className={cn("relative group/sortable pl-6 -ml-6", isDragging && "shadow-lg")}
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        className={cn(
          "absolute left-0 top-1 z-10 hidden h-6 w-5 items-center justify-center text-muted-foreground/60 hover:text-foreground cursor-grab active:cursor-grabbing",
          "group-hover/sortable:flex",
          isDragging && "flex",
        )}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      {children}
    </div>
  );
}

export function SortableSections({ pageKey, sections, className }: SortableSectionsProps) {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id ?? session?.session?.userId ?? null;

  const defaultOrder = useMemo(() => sections.map((s) => s.id), [sections]);
  const sectionsById = useMemo(() => {
    const map = new Map<string, SortableSection>();
    for (const s of sections) map.set(s.id, s);
    return map;
  }, [sections]);

  const { orderedIds, persistOrder } = usePageSectionOrder({
    pageKey,
    defaultOrder,
    userId,
  });

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
        <div className={cn("flex flex-col gap-8", className)}>
          {orderedIds.map((id) => {
            const section = sectionsById.get(id);
            if (!section) return null;
            const content = section.render();
            // Sections may render null when they have no data yet; skip the
            // sortable wrapper too so the page doesn't show an empty drag
            // handle floating in space. The id stays in `orderedIds`, so the
            // saved position is preserved when the section comes back.
            if (content == null || content === false) return null;
            return (
              <SortableItem key={id} id={id}>
                {content}
              </SortableItem>
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}
