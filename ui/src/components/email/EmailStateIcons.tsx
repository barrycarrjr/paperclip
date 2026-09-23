import { Forward, Reply } from "lucide-react";
import { cn } from "../../lib/utils";

interface EmailStateIconsProps {
  /** Replied to (the mailbox's \Answered flag). */
  answered?: boolean;
  /** Forwarded (the $Forwarded keyword). */
  forwarded?: boolean;
  /**
   * Words beside the icons. For an open message, where there is room and the
   * reader is deciding what to do next; list rows stay icon-only.
   */
  showLabels?: boolean;
  className?: string;
}

/**
 * The replied and forwarded marks on one email, the same ones Outlook shows.
 *
 * Both are read from the mailbox, where whichever program replied or forwarded
 * set them, so a reply sent from Outlook or webmail shows here and one sent
 * from Paperclip shows in Outlook. Every list row and every open message draws
 * them through this one component, so the portfolio and company views cannot
 * drift apart. Renders nothing for a message that has had neither.
 */
export function EmailStateIcons({ answered, forwarded, showLabels = false, className }: EmailStateIconsProps) {
  if (!answered && !forwarded) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-muted-foreground", className)}>
      {answered && <Mark icon={Reply} label="Replied" showLabel={showLabels} />}
      {forwarded && <Mark icon={Forward} label="Forwarded" showLabel={showLabels} />}
    </span>
  );
}

function Mark({
  icon: Icon,
  label,
  showLabel,
}: {
  icon: typeof Reply;
  label: string;
  showLabel: boolean;
}) {
  // A native title rather than a Tooltip: these sit inside rows that are
  // themselves tooltip triggers (the hover preview), and nested triggers fight.
  return (
    <span className="inline-flex items-center gap-1" title={label}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span className={showLabel ? "text-xs" : "sr-only"}>{label}</span>
    </span>
  );
}
