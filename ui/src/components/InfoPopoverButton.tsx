import type { ReactNode } from "react";
import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

interface InfoPopoverButtonProps {
  title: string;
  info: ReactNode;
  className?: string;
  contentClassName?: string;
  side?: Side;
  align?: Align;
}

export function InfoPopoverButton({
  title,
  info,
  className,
  contentClassName,
  side = "right",
  align = "start",
}: InfoPopoverButtonProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`What is ${title}?`}
          className={cn(
            "flex h-4 w-4 items-center justify-center rounded text-muted-foreground/60 transition-opacity hover:bg-accent/50 hover:text-foreground",
            className,
          )}
        >
          <Info className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent side={side} align={align} className={cn("w-80", contentClassName)}>
        <PopoverHeader>
          <PopoverTitle>{title}</PopoverTitle>
          <div className="text-sm text-muted-foreground space-y-2">{info}</div>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}
