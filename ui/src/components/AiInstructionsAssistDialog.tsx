import { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ApiError } from "../api/client";
import { agentsApi } from "../api/agents";

interface AiInstructionsAssistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  companyId?: string;
  filePath: string;
  /** Full markdown content of the file. */
  content: string;
  /** Substring of `content` selected by the user, or null for whole-file edits. */
  selection: string | null;
  /** Called with the rewritten content (full file). Caller marks the editor dirty. */
  onApply: (nextContent: string) => void;
}

export function AiInstructionsAssistDialog({
  open,
  onOpenChange,
  agentId,
  companyId,
  filePath,
  content,
  selection,
  onApply,
}: AiInstructionsAssistDialogProps) {
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ rewritten: string; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setPrompt("");
      setResult(null);
      setError(null);
      setGenerating(false);
    }
  }, [open]);

  const previewBeforeAfter = useMemo(() => {
    if (!result) return null;
    if (selection) {
      // Reconstruct the full document with the rewritten selection spliced in.
      const idx = content.indexOf(selection);
      const nextFull =
        idx === -1
          ? content // selection no longer present — fall back to whole-file replace
          : content.slice(0, idx) + result.rewritten + content.slice(idx + selection.length);
      return { before: content, after: nextFull, selectionFallback: idx === -1 };
    }
    return { before: content, after: result.rewritten, selectionFallback: false };
  }, [content, result, selection]);

  async function handleGenerate() {
    const trimmed = prompt.trim();
    if (!trimmed || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await agentsApi.aiRewriteInstructions(
        agentId,
        {
          path: filePath,
          content,
          prompt: trimmed,
          selection,
        },
        companyId,
      );
      setResult(res);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? typeof err.body === "object" && err.body && "error" in err.body
            ? String((err.body as { error?: unknown }).error ?? err.message)
            : err.message
          : err instanceof Error
            ? err.message
            : "Failed to generate rewrite";
      setError(message);
    } finally {
      setGenerating(false);
    }
  }

  function handleApply() {
    if (!previewBeforeAfter) return;
    onApply(previewBeforeAfter.after);
    onOpenChange(false);
  }

  const selectionLength = selection?.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            AI edit
          </DialogTitle>
          <DialogDescription>
            {selection
              ? `Editing your selection (${selectionLength.toLocaleString()} chars) in ${filePath}.`
              : `Editing the whole ${filePath} file.`}{" "}
            The AI will draft a rewrite — you review, then choose Apply or Discard. Nothing is saved
            until you hit Save in the editor.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="ai-instructions-prompt">
              What should the AI do?
            </label>
            <textarea
              id="ai-instructions-prompt"
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleGenerate();
                }
              }}
              placeholder={
                selection
                  ? "e.g. Make this paragraph more concise. Or: Convert to a bulleted list."
                  : "e.g. Add a section about how to handle voicemails. Or: Rewrite in a friendlier tone."
              }
              className="min-h-[100px] w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={generating}
            />
            <p className="text-xs text-muted-foreground">
              Tip: Cmd/Ctrl+Enter to generate.
            </p>
          </div>
        )}

        {result && previewBeforeAfter && (
          <div className="space-y-2">
            {previewBeforeAfter.selectionFallback && (
              <p className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-300">
                Couldn't locate the original selection in the current content — falling back to a whole-file replacement.
              </p>
            )}
            <div className="grid gap-2 md:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Current</p>
                <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 text-xs font-mono">
                  {previewBeforeAfter.before || <span className="text-muted-foreground italic">(empty)</span>}
                </pre>
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  AI rewrite <span className="text-muted-foreground/70">· {result.model}</span>
                </p>
                <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-primary/40 bg-primary/5 p-3 text-xs font-mono">
                  {previewBeforeAfter.after || <span className="text-muted-foreground italic">(empty)</span>}
                </pre>
              </div>
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          {!result ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={generating}>
                Cancel
              </Button>
              <Button onClick={handleGenerate} disabled={generating || prompt.trim().length === 0}>
                {generating ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Generating…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5" />
                    Generate
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setResult(null)}>
                Try a different prompt
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Discard
              </Button>
              <Button onClick={handleApply}>Apply to editor</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
