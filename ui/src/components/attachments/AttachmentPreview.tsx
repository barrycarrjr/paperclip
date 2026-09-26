import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  X,
} from "lucide-react";
import { formatByteSize, type IssueAttachment } from "@paperclipai/shared";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn, relativeTime } from "@/lib/utils";

/*
 * Attachment previews for the issue page: a hover card that shows what a file
 * is without opening it, and a full-screen viewer that steps through every
 * attachment on the issue. Only types the server serves inline can be shown
 * (images, PDF, plain text, markdown, CSV, JSON); Word, Excel and zip files
 * would need a server-side converter, so they get details only.
 */

export type AttachmentPreviewKind = "image" | "pdf" | "text" | "none";

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

/** Card preview reads at most this much of a text file. */
export const TEXT_PREVIEW_MAX_BYTES = 4096;
/** Card preview shows at most this many lines. */
export const TEXT_PREVIEW_MAX_LINES = 40;
/** The full-screen viewer reads further, but still not an unbounded file. */
const FULL_TEXT_MAX_BYTES = 512 * 1024;

type PreviewAttachment = Pick<
  IssueAttachment,
  | "id"
  | "contentType"
  | "byteSize"
  | "originalFilename"
  | "contentPath"
  | "createdAt"
  | "createdByAgentId"
  | "createdByUserId"
>;

export function attachmentPreviewKind(contentType: string | null | undefined): AttachmentPreviewKind {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (TEXT_TYPES.has(type)) return "text";
  return "none";
}

export function attachmentDisplayName(attachment: Pick<IssueAttachment, "id" | "originalFilename">): string {
  return attachment.originalFilename ?? attachment.id;
}

export function AttachmentFileIcon({
  contentType,
  filename,
  className,
}: {
  contentType: string;
  filename?: string | null;
  className?: string;
}) {
  const type = contentType.toLowerCase();
  const ext = (filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  let Icon = File;
  if (type.startsWith("image/")) Icon = FileImage;
  else if (type === "text/csv" || type.includes("spreadsheet") || type.includes("excel") || ["csv", "xls", "xlsx"].includes(ext)) {
    Icon = FileSpreadsheet;
  } else if (type.includes("zip") || type.includes("compressed") || type.includes("tar") || ["zip", "gz", "tgz", "7z", "rar"].includes(ext)) {
    Icon = FileArchive;
  } else if (type === "application/pdf" || type.startsWith("text/") || type === "application/json" || type.includes("word")) {
    Icon = FileText;
  }
  return <Icon aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", className)} />;
}

/**
 * Who uploaded an attachment, as a readable label. Falls back to "an agent"
 * or "a person" when the directory has not loaded or the uploader was removed.
 */
export function describeAttachmentUploader(
  attachment: Pick<IssueAttachment, "createdByAgentId" | "createdByUserId">,
  agentNames: ReadonlyMap<string, { name: string }>,
  userLabels: ReadonlyMap<string, { label: string }> | null | undefined,
): string {
  if (attachment.createdByAgentId) {
    return agentNames.get(attachment.createdByAgentId)?.name ?? "an agent";
  }
  if (attachment.createdByUserId) {
    return userLabels?.get(attachment.createdByUserId)?.label ?? "a person";
  }
  return "unknown";
}

export interface TextPreview {
  text: string;
  truncated: boolean;
}

/**
 * Read the start of a text attachment: stops after `maxBytes` (cancelling the
 * rest of the download) and after `maxLines` lines.
 */
export async function readTextPreview(
  url: string,
  options: { maxBytes?: number; maxLines?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<TextPreview> {
  const maxBytes = options.maxBytes ?? TEXT_PREVIEW_MAX_BYTES;
  const maxLines = options.maxLines ?? TEXT_PREVIEW_MAX_LINES;
  const doFetch = options.fetchImpl ?? fetch;
  const res = await doFetch(url, { credentials: "same-origin", signal: options.signal });
  if (!res.ok) throw new Error(`Could not load the file (${res.status})`);

  let bytes: Uint8Array;
  let truncated = false;
  const reader = res.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    // Read one byte past the limit so a file of exactly `maxBytes` is not
    // reported as cut short, then stop the rest of the download.
    while (total <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    if (total > maxBytes) void reader.cancel().catch(() => undefined);
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (bytes.byteLength > maxBytes) {
    bytes = bytes.subarray(0, maxBytes);
    truncated = true;
  }

  // `stream: true` keeps a multi-byte character cut at the limit from
  // turning into a replacement character at the end.
  let text = new TextDecoder("utf-8").decode(bytes, { stream: truncated });
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  return { text, truncated };
}

function TextPreviewBody({ url, full }: { url: string; full: boolean }) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; preview: TextPreview } | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    readTextPreview(url, {
      signal: controller.signal,
      ...(full ? { maxBytes: FULL_TEXT_MAX_BYTES, maxLines: Number.POSITIVE_INFINITY } : {}),
    })
      .then((preview) => setState({ status: "ready", preview }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: err instanceof Error ? err.message : "Could not load the file" });
      });
    return () => controller.abort();
  }, [url, full]);

  if (state.status === "loading") {
    return <p className="p-3 text-xs text-muted-foreground">Loading preview...</p>;
  }
  if (state.status === "error") {
    return <p className="p-3 text-xs text-destructive">{state.message}</p>;
  }
  return (
    <div className={cn("min-h-0", full && "h-full overflow-auto")}>
      <pre
        data-testid="attachment-text-preview"
        className={cn(
          "whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed",
          full ? "p-4 text-xs" : "max-h-72 overflow-hidden p-3",
        )}
      >
        {state.preview.text}
      </pre>
      {state.preview.truncated && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {full ? "Showing the start of the file. Download it to see the rest." : "Showing the start of the file."}
        </p>
      )}
    </div>
  );
}

/** The body of a preview, chosen by file type. */
export function AttachmentPreviewBody({
  attachment,
  full = false,
}: {
  attachment: PreviewAttachment;
  full?: boolean;
}) {
  const kind = attachmentPreviewKind(attachment.contentType);
  const name = attachmentDisplayName(attachment);
  if (kind === "image") {
    return (
      <img
        src={attachment.contentPath}
        alt={name}
        className={cn("select-none object-contain", full ? "max-h-full max-w-full rounded-lg" : "max-h-72 w-full")}
        draggable={false}
      />
    );
  }
  if (kind === "pdf") {
    return (
      <iframe
        data-testid="attachment-pdf-preview"
        title={`Preview of ${name}`}
        src={full ? attachment.contentPath : `${attachment.contentPath}#page=1&toolbar=0&navpanes=0&view=FitH`}
        loading="lazy"
        className={cn("block w-full border-0 bg-white", full ? "h-full rounded-lg" : "h-72")}
      />
    );
  }
  if (kind === "text") {
    return <TextPreviewBody url={attachment.contentPath} full={full} />;
  }
  return (
    <p data-testid="attachment-no-preview" className={cn("p-3 text-xs text-muted-foreground", full && "text-sm text-white/70")}>
      No preview for this file type. Download it to open it.
    </p>
  );
}

function AttachmentDetails({ attachment, uploadedBy }: { attachment: PreviewAttachment; uploadedBy: string }) {
  return (
    <div className="space-y-0.5 border-b border-border px-3 py-2">
      <p className="truncate text-xs font-medium" title={attachmentDisplayName(attachment)}>
        {attachmentDisplayName(attachment)}
      </p>
      <p className="text-[11px] text-muted-foreground">
        {attachment.contentType} · {formatByteSize(attachment.byteSize)}
      </p>
      <p className="text-[11px] text-muted-foreground">
        Uploaded by {uploadedBy} · {relativeTime(attachment.createdAt)}
      </p>
    </div>
  );
}

/**
 * Wraps a trigger (the attachment's row link) in a hover card showing what
 * the file is. Opens after a short hover or on keyboard focus. The preview is
 * only mounted while the card is open, so a list of files loads nothing until
 * someone points at one.
 */
export function AttachmentPreviewCard({
  attachment,
  uploadedBy,
  children,
  openDelay = 350,
}: {
  attachment: PreviewAttachment;
  uploadedBy: string;
  children: ReactNode;
  openDelay?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={openDelay} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        collisionPadding={12}
        className="w-80 overflow-hidden p-0"
        data-testid="attachment-preview-card"
      >
        <AttachmentDetails attachment={attachment} uploadedBy={uploadedBy} />
        {open && (
          <div className="bg-muted/30">
            <AttachmentPreviewBody attachment={attachment} />
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * Full-screen viewer for every attachment on an issue. Left and right arrows
 * (or the side buttons) step through all of them, Escape closes, and the
 * Download button saves the current file. Nothing here navigates away.
 */
export function AttachmentViewerModal<T extends PreviewAttachment>({
  attachments,
  initialIndex,
  open,
  onOpenChange,
  uploaderLabel,
}: {
  attachments: T[];
  initialIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  uploaderLabel?: (attachment: T) => string;
}) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const count = attachments.length;

  useEffect(() => {
    if (open) setCurrentIndex(initialIndex);
  }, [open, initialIndex]);

  const goNext = useCallback(() => {
    if (count > 0) setCurrentIndex((i) => (i + 1) % count);
  }, [count]);
  const goPrev = useCallback(() => {
    if (count > 0) setCurrentIndex((i) => (i - 1 + count) % count);
  }, [count]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") goNext();
      else if (e.key === "ArrowLeft") goPrev();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, goNext, goPrev]);

  if (count === 0) return null;
  const current = attachments[Math.min(currentIndex, count - 1)];
  if (!current) return null;
  const name = attachmentDisplayName(current);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/90 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-testid="attachment-viewer"
          className="fixed inset-0 z-50 flex flex-col outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200"
        >
          <div className="flex shrink-0 items-center justify-between gap-4 px-5 py-3 text-sm text-white/80">
            <div className="flex min-w-0 items-center gap-2">
              <AttachmentFileIcon contentType={current.contentType} filename={current.originalFilename} className="text-white/60" />
              <DialogPrimitive.Title className="truncate font-medium" title={name}>
                {name}
              </DialogPrimitive.Title>
              <span className="hidden shrink-0 text-xs text-white/40 sm:inline">
                {formatByteSize(current.byteSize)}
                {uploaderLabel ? ` · ${uploaderLabel(current)}` : ""}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-4">
              <span className="text-xs tabular-nums text-white/40" data-testid="attachment-viewer-position">
                {currentIndex + 1} / {count}
              </span>
              <a
                href={current.contentPath}
                download={current.originalFilename ?? "attachment"}
                className="text-white/50 transition-colors hover:text-white"
                title="Download"
                aria-label={`Download ${name}`}
              >
                <Download className="h-4.5 w-4.5" />
              </a>
              <DialogPrimitive.Close
                className="text-white/50 transition-colors hover:text-white"
                title="Close"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </DialogPrimitive.Close>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 items-center">
            <div className="flex h-full w-16 shrink-0 items-center justify-center md:w-24">
              {count > 1 && (
                <button
                  type="button"
                  onClick={goPrev}
                  className="rounded-full bg-white/10 p-3 text-white/60 transition-colors hover:bg-white/20 hover:text-white"
                  title="Previous"
                  aria-label="Previous attachment"
                >
                  <ChevronLeft className="h-7 w-7" />
                </button>
              )}
            </div>
            <div
              key={current.id}
              className={cn(
                "flex h-full min-h-0 min-w-0 flex-1 items-center justify-center px-2",
                attachmentPreviewKind(current.contentType) === "text" && "items-stretch",
              )}
            >
              {attachmentPreviewKind(current.contentType) === "text" ? (
                <div className="h-full w-full max-w-4xl overflow-hidden rounded-lg bg-background text-foreground">
                  <AttachmentPreviewBody attachment={current} full />
                </div>
              ) : (
                <AttachmentPreviewBody attachment={current} full />
              )}
            </div>
            <div className="flex h-full w-16 shrink-0 items-center justify-center md:w-24">
              {count > 1 && (
                <button
                  type="button"
                  onClick={goNext}
                  className="rounded-full bg-white/10 p-3 text-white/60 transition-colors hover:bg-white/20 hover:text-white"
                  title="Next"
                  aria-label="Next attachment"
                >
                  <ChevronRight className="h-7 w-7" />
                </button>
              )}
            </div>
          </div>
          <div className="h-6 shrink-0" />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
