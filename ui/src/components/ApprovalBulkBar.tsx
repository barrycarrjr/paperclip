import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { usePageBottomBarRef } from "../hooks/usePageBottomBar";
import { PAGE_BOTTOM_BAR_CENTER_CLASS, PAGE_BOTTOM_BAR_FLOATING_CLASS } from "../lib/narrow-layout";
import { PageFloating } from "./PageFloatingLayer";
import { Z_PAGE_FLOATING } from "../lib/z-layers";
import type { BulkApprovalAction } from "../lib/approval-bulk";

/**
 * The floating bar that decides every selected approval at once. Shared by
 * the company Approvals page and Portfolio Approvals so the two behave the
 * same way.
 */
export function ApprovalBulkBar({
  count,
  onApprove,
  onReject,
  onClear,
  runningAction,
}: {
  count: number;
  onApprove: () => void;
  onReject: () => void;
  onClear: () => void;
  runningAction: BulkApprovalAction | null;
}) {
  // A page bottom bar: the Clippy launcher and the toasts sit above it.
  const barRef = usePageBottomBarRef<HTMLDivElement>();
  const busy = runningAction !== null;
  return (
    // Page content, so the page-floating layer: on z-50 (the dialog layer) it
    // drew over the Clippy window. See lib/z-layers. Drawn beside the page
    // area, not inside it (see PageFloating).
    <PageFloating>
      <div
        ref={barRef}
        role="toolbar"
        aria-label="Selected approvals"
        className={cn(
          "fixed flex items-center gap-2 rounded-lg border border-border bg-background shadow-lg px-4 py-2.5",
          PAGE_BOTTOM_BAR_FLOATING_CLASS,
          PAGE_BOTTOM_BAR_CENTER_CLASS,
          Z_PAGE_FLOATING,
        )}
      >
        <span className="text-sm font-medium text-muted-foreground mr-1">{count} selected</span>
        <Button
          size="sm"
          className="h-7 text-xs bg-green-700 hover:bg-green-600 text-white"
          onClick={onApprove}
          disabled={busy}
        >
          {runningAction === "approve" ? "Approving..." : `Approve ${count}`}
        </Button>
        <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={onReject} disabled={busy}>
          {runningAction === "reject" ? "Rejecting..." : `Reject ${count}`}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={onClear} disabled={busy}>
          Clear selection
        </Button>
      </div>
    </PageFloating>
  );
}
