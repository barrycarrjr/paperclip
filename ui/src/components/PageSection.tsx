import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageSectionProps {
  /** Section name shown in the header band. Omit for an unlabelled block. */
  title?: ReactNode;
  /** Controls or counts pinned to the right of the header band. */
  actions?: ReactNode;
  children: ReactNode;
  /** Drop the inner padding when the child brings its own (tab strips, tables). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
}

/**
 * One titled, bounded area of a long detail page.
 *
 * A tall page built from bare headings and vertical spacing reads as a single
 * run-on column: the gap between two sections looks the same as the gap inside
 * one, so nothing tells the eye where an area ends. Giving each area a border
 * and a header band makes the boundaries survive scrolling, which is when they
 * matter most.
 */
export function PageSection({
  title,
  actions,
  children,
  flush = false,
  className,
  bodyClassName,
}: PageSectionProps) {
  const hasHeader = Boolean(title) || Boolean(actions);

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-border/70 bg-card/40",
        className,
      )}
    >
      {hasHeader && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-muted/30 px-4 py-2">
          {title ? (
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {title}
            </h3>
          ) : (
            <span />
          )}
          {actions ? (
            // Wraps rather than overflowing: a narrow viewport can put more
            // buttons in this band than fit on one line.
            <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </div>
      )}
      <div className={cn(!flush && "p-4", bodyClassName)}>{children}</div>
    </section>
  );
}
