import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "../lib/utils";

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterPopoverProps {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}

export function FilterPopover({ label, options, selected, onChange }: FilterPopoverProps) {
  function toggle(value: string) {
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
    );
  }
  const activeLabel =
    selected.length > 0 && selected.length < options.length
      ? `${label}: ${selected.length}`
      : label;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-7 text-xs gap-1",
            selected.length > 0 && selected.length < options.length && "border-primary/50 text-primary",
          )}
        >
          {activeLabel}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => toggle(opt.value)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
          >
            <Checkbox
              checked={selected.includes(opt.value)}
              onCheckedChange={() => toggle(opt.value)}
              className="h-3.5 w-3.5"
            />
            <span className="flex-1 text-left">{opt.label}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
