import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
  tone?: "default" | "warning" | "danger" | "success";
  emphasis?: boolean;
}

const toneAccentBar: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  default: "bg-foreground/15 group-hover:bg-foreground/40",
  warning: "bg-amber-500/40 group-hover:bg-amber-500/70",
  danger: "bg-red-500/40 group-hover:bg-red-500/80",
  success: "bg-emerald-500/40 group-hover:bg-emerald-500/70",
};

const toneIconColor: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  default: "text-muted-foreground/60",
  warning: "text-amber-500",
  danger: "text-red-500",
  success: "text-emerald-500",
};

export function MetricCard({
  icon: Icon,
  value,
  label,
  description,
  to,
  onClick,
  tone = "default",
  emphasis = false,
}: MetricCardProps) {
  const isClickable = !!(to || onClick);

  const inner = (
    <div
      className={cn(
        "group relative h-full overflow-hidden border border-border bg-card pl-5 pr-4 py-4 sm:py-5 transition-all",
        isClickable && "cursor-pointer hover:border-foreground/30 hover:bg-accent/30",
        emphasis && tone === "default" && "bg-accent/20",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-0 h-full w-[3px] transition-colors",
          toneAccentBar[tone],
        )}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {label}
          </p>
          <p className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums leading-none">
            {value}
          </p>
          {description && (
            <div className="mt-2 text-xs text-muted-foreground/80 line-clamp-2">
              {description}
            </div>
          )}
        </div>
        <span
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-md bg-muted/50 transition-colors group-hover:bg-muted",
            tone !== "default" && "bg-transparent group-hover:bg-transparent",
          )}
        >
          <Icon className={cn("h-4 w-4 shrink-0", toneIconColor[tone])} />
        </span>
      </div>
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit h-full block" onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div className="h-full" onClick={onClick}>
        {inner}
      </div>
    );
  }

  return inner;
}
