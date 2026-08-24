import { useState } from "react";
import { AlertTriangle, Download, FileText, Loader2 } from "lucide-react";
import { formatByteSize } from "@paperclipai/shared";
import { base64ToBlob } from "@/lib/attachments";
import { cn } from "@/lib/utils";

/** One received attachment the operator can click to download. */
export interface ReceivedAttachment {
  /** Stable key the bridge fetch understands: IMAP partId or Help Scout attachment id. */
  key: string;
  name: string;
  mime?: string;
  size?: number;
}

export interface FetchedAttachmentContent {
  name: string;
  mime: string;
  contentBase64: string;
}

interface AttachmentChipListProps {
  attachments: ReceivedAttachment[];
  /** Bridge call that fetches the file bytes for one attachment. */
  fetchContent: (attachment: ReceivedAttachment) => Promise<FetchedAttachmentContent>;
  /** Surface a failure the way the host screen surfaces errors (usually a toast).
   *  The chip also shows the error inline either way. */
  onError?: (message: string) => void;
  className?: string;
}

type ChipState = { kind: "loading" } | { kind: "error"; message: string };

/**
 * Received-attachment chips: click one to download the file. The bytes are
 * only fetched on click (attachment metadata is cheap, the content is not),
 * then handed to the browser as a normal file download.
 */
export function AttachmentChipList({
  attachments,
  fetchContent,
  onError,
  className,
}: AttachmentChipListProps) {
  const [chipStates, setChipStates] = useState<Record<string, ChipState>>({});

  async function download(attachment: ReceivedAttachment) {
    setChipStates((prev) => ({ ...prev, [attachment.key]: { kind: "loading" } }));
    try {
      const fetched = await fetchContent(attachment);
      const blob = base64ToBlob(fetched.contentBase64, fetched.mime);
      triggerBlobDownload(blob, fetched.name || attachment.name);
      setChipStates((prev) => {
        const next = { ...prev };
        delete next[attachment.key];
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Download failed";
      setChipStates((prev) => ({ ...prev, [attachment.key]: { kind: "error", message } }));
      onError?.(`Download failed: ${message}`);
    }
  }

  if (attachments.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {attachments.map((attachment) => {
        const state = chipStates[attachment.key];
        const loading = state?.kind === "loading";
        const errorMessage = state?.kind === "error" ? state.message : null;
        const detail = [
          attachment.mime,
          attachment.size !== undefined ? formatByteSize(attachment.size) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <button
            key={attachment.key}
            type="button"
            disabled={loading}
            onClick={() => download(attachment)}
            title={errorMessage ?? `Download ${attachment.name}`}
            className={cn(
              "flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs",
              "disabled:pointer-events-none disabled:opacity-50",
              errorMessage
                ? "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15"
                : "border-border bg-background text-foreground hover:bg-accent",
            )}
          >
            {errorMessage ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0" />
            )}
            <div className="min-w-0 max-w-[220px] text-left">
              <div className="truncate font-medium">{attachment.name}</div>
              <div className="truncate text-[10px] opacity-70">
                {errorMessage ?? (detail || " ")}
              </div>
            </div>
            {loading ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-60" />
            ) : (
              <Download className="h-3 w-3 shrink-0 opacity-60" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function triggerBlobDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Delayed so the click's navigation has started before the URL dies.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
