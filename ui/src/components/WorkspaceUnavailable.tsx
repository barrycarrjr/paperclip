import type { LucideIcon } from "lucide-react";
import { Lock } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "./ui/button";

/**
 * What you see when you open a workspace that cannot work here.
 *
 * The rule this exists to satisfy, from
 * docs/plans/2026-09-02-ux-control-center-scope.md: "Unsupported access shows
 * a clear unavailable/setup/permission state; it never borrows a different
 * company's data." Quietly sending someone to a different page instead is
 * the specific thing that rules out, because the page they land on looks
 * like a normal working page and nothing says their request was ignored.
 *
 * Three things every use of this must answer, in this order: what you tried
 * to open, why it is not available, and what would make it available. The
 * third is a link only when the reader can actually act on it — offering a
 * settings link to someone who cannot change the setting is worse than
 * offering nothing, because it reads as "you did this wrong".
 */
export function WorkspaceUnavailable({
  title,
  reason,
  whatToDo,
  icon: Icon = Lock,
  actionHref,
  actionLabel,
}: {
  /** The workspace by the name the rest of the app calls it. */
  title: string;
  /** Why it is not available, in one plain sentence. */
  reason: string;
  /** What would change that. Omit when there is genuinely nothing to do. */
  whatToDo?: string;
  icon?: LucideIcon;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="flex min-h-[240px] items-center justify-center p-6">
      <div className="max-w-sm space-y-3 text-center">
        <Icon className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">{title} is not available here</p>
        <p className="text-sm text-muted-foreground">{reason}</p>
        {whatToDo && <p className="text-xs text-muted-foreground">{whatToDo}</p>}
        {actionHref && actionLabel && (
          <Button variant="outline" size="sm" asChild>
            <Link to={actionHref}>{actionLabel}</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
