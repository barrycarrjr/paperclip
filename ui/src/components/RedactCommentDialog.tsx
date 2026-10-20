import { useEffect, useMemo, useState, useRef } from "react";
import { applyCommentRedactions, COMMENT_REDACTION_BODY_SIZE_ERROR, redactIssueCommentSchema, type CommentRedactionImpact } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/** Reuses the original manual dialog. Nothing is scanned or hidden until confirmation. */
export function RedactCommentDialog({ open, body, pending, agents = [], onOpenChange, onConfirm, onPreview }: {
  open: boolean;
  body: string;
  pending: boolean;
  agents?: Array<{ id: string; name: string }>;
  onOpenChange: (open: boolean) => void;
  onPreview: (targets: string[], keepLast4: boolean) => Promise<CommentRedactionImpact>;
  onConfirm: (targets: string[], keepLast4: boolean, agentId?: string, impactToken?: string) => void;
}) {
  const previewVersion = useRef(0);
  const [impact, setImpact] = useState<CommentRedactionImpact | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [raw, setRaw] = useState("");
  const [keepLast4, setKeepLast4] = useState(true);
  const [agentId, setAgentId] = useState("");
  useEffect(() => {
    // Closing also removes the sensitive selection from component state.
    setImpact(null);
    setPreviewError("");
    setRaw("");
    setKeepLast4(true);
    setAgentId("");
  }, [open, body]);
  useEffect(() => { previewVersion.current++; setImpact(null); setPreviewError(""); }, [open, body, raw, keepLast4]);
  const targets = useMemo(() => raw ? [raw] : [], [raw]);
  const validation = useMemo(() => redactIssueCommentSchema.safeParse({ targets, keepLast4, expectedBody: body }), [targets, keepLast4, body]);
  const valid = validation.success;
  const bodySizeError = !validation.success && validation.error.issues.some((issue) => issue.path[0] === "expectedBody" && issue.message === COMMENT_REDACTION_BODY_SIZE_ERROR);
  const preview = useMemo(() => applyCommentRedactions(body, targets, keepLast4), [body, targets, keepLast4]);
  const previewStart = preview.text.length > 16_000 ? Math.max(0, body.indexOf(raw) - 4000) : 0;
  const previewText = preview.text.length > 16_000 ? preview.text.slice(previewStart, previewStart + 16_000) : preview.text;
  const canConfirm = valid && body.includes(raw) && preview.replaced > 0 && !pending && !previewPending;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Redact text in this comment</DialogTitle>
          <DialogDescription>
            Paste the exact text to hide. Spaces, punctuation and line breaks are kept exactly.
            After confirmation, exact matches in supported text fields are replaced in this comment and stored activity, run,
            wake, review and board chat copies in this company. Other comments are counted but not changed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Textarea aria-label="Exact text to hide" placeholder="Paste the exact text to hide"
            value={raw} onChange={(e) => setRaw(e.target.value)} rows={3} className="font-mono text-sm" disabled={pending} />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={keepLast4} onCheckedChange={(v) => setKeepLast4(v === true)} aria-label="Keep the last 4" disabled={pending} />
            Keep the last 4 letters or digits, e.g. [redacted …1234]
          </label>
          <p className="text-sm text-muted-foreground">
            Selections with eight or fewer letters or digits are fully hidden. Longer selections can retain the last four.
            The preview shows exactly what remains, including when you add surrounding text.
          </p>
          {bodySizeError ? <p className="text-sm text-destructive">{COMMENT_REDACTION_BODY_SIZE_ERROR}</p> : raw && !valid ? <p className="text-sm text-destructive">Select 4 to 2000 non-padding characters. Include surrounding text for shorter secrets.</p> : null}
          {valid && !body.includes(raw) ? <p className="text-sm text-destructive">The selected text does not appear in this comment exactly as written.</p> : null}
          <label className="block text-sm">
            Who will apply this confirmed redaction?
            <select aria-label="Who applies the redaction" className="mt-1 block w-full rounded-md border bg-background p-2"
              value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={pending}>
              <option value="">Apply it now as the board</option>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>Authorize {agent.name} once</option>)}
            </select>
          </label>
          {agentId ? <p className="text-sm text-muted-foreground">
            Confirmation posts a board instruction in this issue for this agent only. It expires in 30 minutes,
            can be used once and fails if the comment changes. There is no revoke action; wait for expiry to withdraw it. Start or mention the named agent in this issue before expiry. It does not start a run.
          </p> : null}
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Preview ({preview.replaced} {preview.replaced === 1 ? "place" : "places"} hidden)</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">{previewText}</pre>
            {previewText.length < preview.text.length ? <p className="text-xs text-muted-foreground">Showing up to 16,000 characters around the first match. Every exact match will be replaced.</p> : null}
          </div>
          <Button variant="outline" disabled={!canConfirm} onClick={async () => {
            const version = previewVersion.current;
            setPreviewPending(true); setPreviewError(""); setImpact(null);
            try { const result = await onPreview(targets, keepLast4); if (previewVersion.current === version) setImpact(result); }
            catch (error) { if (previewVersion.current === version) setPreviewError(error instanceof Error ? error.message : "Unable to preview stored copies."); }
            finally { setPreviewPending(false); }
          }}>Preview stored copies</Button>
          {previewError ? <p role="alert" className="text-sm text-destructive">{previewError}</p> : null}
          {impact ? <div className="text-sm">
            Estimated matching records visible to the requesting board user (files are checked during cleanup):
            <ul className="list-disc pl-5">{Object.entries(impact.counts).filter(([key]) => key !== "runLogFiles").map(([key, count]) =>
              <li key={key}>{key.replace(/([A-Z])/g, " $1").toLowerCase()}: {count}</li>)}</ul>
            Private chats belonging to others are cleaned on a best-effort basis without disclosing counts or outcomes.
            Overall cleanup always reports incomplete because their remaining copies cannot be disclosed.
            Counts can change as agents work. Changed covered records require a fresh preview at confirmation.
            Agent execution later uses the confirmed selection; its counts may differ.
            {impact.cutoffCheckComplete === false ? " The cut-off copy check did not finish; additional partial copies may remain." : ""}
            {impact.residualMatches ? ` ${impact.residualMatches} matches or possible cut-off pieces will remain; separate cleanup is needed.` : ""}
            {impact.skippedFields ? ` ${impact.skippedFields} deeply nested fields will be skipped; separate cleanup is needed.` : ""}
            {impact.oversizedFields ? ` ${impact.oversizedFields} oversized fields will be skipped; cleanup will be incomplete.` : ""}
          </div> : null}
          <p className="text-sm text-muted-foreground">
            This permanently changes stored text. Earlier database backups and recovery history, agent tools' own
            sessions, provider copies and plugin storage cannot be cleaned here. Other comments, documents,
            attachments, exports, server diagnostic logs and browser caches are not cleaned. Active agents or chats
            may still hold this text and write it again. Some run log files may require separate cleanup even after
            the database text is replaced; the result reports this. Unidentified cut-off copies may retain part of the selected text. This is a one-time action, with no automatic scanner.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button variant="destructive" disabled={!canConfirm || !impact} onClick={() => onConfirm(targets, keepLast4, agentId || undefined, impact!.impactToken)}>
            {pending ? "Saving..." : agentId ? "Authorize agent" : "Redact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
