import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  message: string;
  action?: string;
  onAction?: () => void;
}

export function EmptyState({ icon: Icon, message, action, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
      <div className="relative mb-5">
        <div className="absolute inset-0 -m-2 border border-dashed border-border" aria-hidden />
        <div className="relative bg-muted/40 p-5">
          <Icon className="h-9 w-9 text-muted-foreground/60" strokeWidth={1.5} />
        </div>
      </div>
      <p className="text-sm text-muted-foreground max-w-sm mb-5 leading-relaxed">{message}</p>
      {action && onAction && (
        <Button onClick={onAction}>
          <Plus className="h-4 w-4 mr-1.5" />
          {action}
        </Button>
      )}
    </div>
  );
}
