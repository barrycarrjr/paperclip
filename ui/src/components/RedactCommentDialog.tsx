import { useEffect, useMemo, useState } from "react";
import { applyCommentRedactions, COMMENT_REDACTION_TARGET_PATTERN } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/**
 * Board only: hide text (for example a full account number) in one comment.
 * The server also cleans the copies Paperclip keeps of the comment's text.
 */
export function RedactCommentDialog({
  open,
  body,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  body: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (targets: string[], keepLast4: boolean) => void;
}) {
  const [raw, setRaw] = useState("");
  const [keepLast4, setKeepLast4] = useState(true);
  useEffect(() => {
    if (open) {
      setRaw("");
      setKeepLast4(true);
    }
  }, [open]);

  const targets = useMemo(() => [...new Set(raw.split("\n").map((t) => t.trim()).filter(Boolean))], [raw]);
  const problems = targets.filter((t) => t.length < 4 || t.length > 200 || !COMMENT_REDACTION_TARGET_PATTERN.test(t));
  const notInComment = targets.filter((t) => !problems.includes(t) && !body.includes(t));
  const preview = useMemo(() => applyCommentRedactions(body, targets, keepLast4), [body, targets, keepLast4]);
  const canConfirm = targets.length > 0 && problems.length === 0 && preview.replaced > 0 && !pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Redact text in this comment</DialogTitle>
          <DialogDescription>
            Paste the exact text to hide, one per line (for example a full account number). It is also removed from the
            activity log, agent run records, run logs and board chat in this company. Database backups made before now are
            not changed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Textarea
            aria-label="Text to hide, one per line"
            placeholder="Text to hide, one per line"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={3}
            className="font-mono text-sm"
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={keepLast4} onCheckedChange={(v) => setKeepLast4(v === true)} aria-label="Keep the last 4" />
            Keep the last 4 characters, e.g. [redacted …1234]
          </label>
          {problems.length > 0 ? (
            <p className="text-sm text-red-700 dark:text-red-300">
              Each text must be 4 to 200 characters of letters, digits, spaces or . # / _ -
            </p>
          ) : null}
          {notInComment.length > 0 ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {notInComment.length === 1 ? "One line does" : `${notInComment.length} lines do`} not appear in this comment
              exactly as written.
            </p>
          ) : null}
          <div>
            <div className="mb-1 text-xs text-muted-foreground">
              Preview ({preview.replaced} {preview.replaced === 1 ? "place" : "places"} hidden)
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">{preview.text}</pre>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!canConfirm} onClick={() => onConfirm(targets, keepLast4)}>
            {pending ? "Redacting…" : "Redact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
