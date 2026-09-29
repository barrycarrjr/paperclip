import { CheckCircle2, XCircle, Clock } from "lucide-react";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Identity } from "./Identity";
import {
  approvalSubject,
  typeIcon,
  defaultTypeIcon,
  ApprovalPayloadRenderer,
  FullRequestToggle,
  outboundDraftPreview,
  outboundToolLabel,
  typeLabel,
} from "./ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import type { Approval, Agent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";

function statusIcon(status: string) {
  if (status === "approved") return <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />;
  if (status === "rejected") return <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
  if (status === "revision_requested") return <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />;
  if (status === "pending") return <Clock className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-400" />;
  return null;
}

export function ApprovalCard({
  approval,
  requesterAgent,
  onApprove,
  onReject,
  onOpen,
  detailLink,
  isPending = false,
  pendingAction = null,
}: {
  approval: Approval;
  requesterAgent: Agent | null;
  onApprove?: () => void;
  onReject?: () => void;
  onOpen?: () => void;
  detailLink?: string;
  isPending?: boolean;
  pendingAction?: "approve" | "reject" | null;
}) {
  const payload = approval.payload as Record<string, unknown> | null;
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const kindLabel = typeLabel[approval.type] ?? approval.type;
  const subject = approvalSubject(payload);
  // An outgoing message shows its recipient and text in the body, so the
  // title names the kind of message instead of repeating the same summary.
  const draftPreview = approval.type === "outbound_tool_draft" ? outboundDraftPreview(payload) : null;
  const title = draftPreview
    ? outboundToolLabel(typeof payload?.toolName === "string" ? payload.toolName : null)
    : subject ?? kindLabel;
  const showResolutionButtons =
    Boolean(onApprove && onReject) &&
    approval.type !== "budget_override_required" &&
    (approval.status === "pending" || approval.status === "revision_requested");
  const detailsClassName = cn(
    buttonVariants({ variant: "ghost", size: "sm" }),
    "h-auto px-2 py-0.5 text-xs text-muted-foreground",
  );

  return (
    // min-w-0: the card sits in grid and flex lists, and without it one long
    // unbroken value inside makes the whole card wider than the page.
    <div className="min-w-0 rounded-md border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/80">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-border/70 bg-background/70 px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
                >
                  {kindLabel}
                </Badge>
                {requesterAgent && (
                  <div className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span>Requested by</span>
                    <Identity name={requesterAgent.name} size="sm" className="inline-flex" />
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold leading-6 text-foreground wrap-anywhere">
                  {title}
                </h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  Approval request created {timeAgo(approval.createdAt)}
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-2.5 py-1 text-xs text-muted-foreground">
            {statusIcon(approval.status)}
            <span className="capitalize">{approval.status.replace(/_/g, " ")}</span>
          </div>
          {detailLink ? (
            <Link to={detailLink} className={detailsClassName}>
              View details
            </Link>
          ) : onOpen ? (
            <Button variant="ghost" size="sm" className={detailsClassName} onClick={onOpen}>
              View details
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 min-w-0 border-t border-border/60 pt-4">
        <ApprovalPayloadRenderer
          type={approval.type}
          payload={approval.payload}
          hidePrimaryTitle={Boolean(subject)}
          compact
        />
        <FullRequestToggle payload={approval.payload} className="mt-3" />
      </div>

      {approval.decisionNote && (
        <div className="mt-4 rounded-md border border-border/60 bg-muted/30 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">Decision note.</span> {approval.decisionNote}
        </div>
      )}

      {showResolutionButtons ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
          <Button
            size="sm"
            className="bg-green-700 hover:bg-green-600 text-white"
            onClick={onApprove}
            disabled={isPending}
          >
            {pendingAction === "approve" ? "Approving..." : "Approve"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onReject}
            disabled={isPending}
          >
            {pendingAction === "reject" ? "Rejecting..." : "Reject"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
