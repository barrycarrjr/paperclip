import { ExternalLink, FileText, Package } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

/**
 * "Made by this run": the work products a single heartbeat run created,
 * accumulating while it runs. The table and API existed; nothing rendered
 * them before this card.
 */
export function RunWorkProductsCard({
  runId,
  isLive,
  className,
}: {
  runId: string;
  isLive?: boolean;
  className?: string;
}) {
  const { data: workProducts } = useQuery({
    queryKey: queryKeys.runWorkProducts(runId),
    queryFn: () => heartbeatsApi.listRunWorkProducts(runId),
    refetchInterval: isLive ? 10_000 : false,
  });
  if (!workProducts || workProducts.length === 0) return null;
  return (
    <div className={cn("rounded-lg border border-border", className)}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-semibold">
        <Package className="h-3.5 w-3.5 text-muted-foreground" />
        Made by this run
        <span className="ml-auto font-normal text-muted-foreground">{workProducts.length}</span>
      </div>
      <div className="divide-y divide-border">
        {workProducts.map((wp) => (
          <WorkProductRow key={wp.id} workProduct={wp} />
        ))}
      </div>
    </div>
  );
}

const REVIEW_STATE_CHIPS: Partial<
  Record<IssueWorkProduct["reviewState"], { label: string; className: string }>
> = {
  approved: {
    label: "approved",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  changes_requested: {
    label: "changes asked",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  needs_board_review: {
    label: "awaiting review",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
};

function WorkProductRow({ workProduct }: { workProduct: IssueWorkProduct }) {
  const chip = REVIEW_STATE_CHIPS[workProduct.reviewState];
  const body = (
    <>
      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium">{workProduct.title}</span>
          {workProduct.url && (
            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{workProduct.type.replace(/_/g, " ")}</span>
          {workProduct.status && <span>· {workProduct.status.replace(/_/g, " ")}</span>}
          {chip && (
            <span
              className={cn(
                "rounded-full border px-1.5 py-px text-[10px] font-medium",
                chip.className,
              )}
            >
              {chip.label}
            </span>
          )}
          {workProduct.healthStatus === "unhealthy" && (
            <span className="rounded-full border border-red-500/30 bg-red-500/10 px-1.5 py-px text-[10px] font-medium text-red-700 dark:text-red-400">
              unhealthy
            </span>
          )}
        </div>
        {workProduct.summary && (
          <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
            {workProduct.summary}
          </div>
        )}
      </div>
    </>
  );
  const rowClass = "flex items-start gap-2 px-3 py-2";
  if (workProduct.url) {
    return (
      <a
        href={workProduct.url}
        target="_blank"
        rel="noreferrer"
        className={cn(rowClass, "no-underline hover:bg-accent/40")}
      >
        {body}
      </a>
    );
  }
  return <div className={rowClass}>{body}</div>;
}
