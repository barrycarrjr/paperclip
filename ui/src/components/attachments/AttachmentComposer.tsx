import { useCallback, useRef, useState, type ChangeEvent } from "react";
import { AlertTriangle, Check, Loader2, Paperclip, X } from "lucide-react";
import { formatByteSize } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  allAttachmentsReady,
  createPendingAttachment,
  dataUrlToBase64,
  failPendingAttachment,
  removePendingAttachment,
  resolvePendingAttachment,
  type PendingAttachment,
} from "@/lib/attachments";
import { cn } from "@/lib/utils";

export interface ComposeAttachmentsState {
  attachments: PendingAttachment[];
  /** False while any picked file is still being read into base64. */
  allReady: boolean;
  addFiles: (files: ArrayLike<File>) => void;
  /**
   * Attach a file whose bytes live elsewhere (e.g. an attachment on the
   * message being forwarded): the chip appears immediately from the metadata
   * and `load` supplies the base64 content, exactly like a picked file being
   * read. Over-limit files become error chips without `load` ever running.
   */
  addRemote: (
    meta: { name: string; mime: string; size: number },
    load: () => Promise<string>,
  ) => void;
  remove: (id: string) => void;
  clear: () => void;
}

/**
 * State for files attached to an outgoing message. Picked files are read to
 * base64 straight away (a chip shows the progress), so by the time the
 * operator hits send the payload is usually already in hand.
 */
export function useComposeAttachments(maxBytes: number): ComposeAttachmentsState {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  const addFiles = useCallback(
    (files: ArrayLike<File>) => {
      for (const file of Array.from(files)) {
        const item = createPendingAttachment(file, maxBytes);
        setAttachments((prev) => [...prev, item]);
        if (item.status !== "reading") continue;
        readFileAsBase64(file).then(
          (contentBase64) =>
            setAttachments((prev) => resolvePendingAttachment(prev, item.id, contentBase64)),
          (err) =>
            setAttachments((prev) =>
              failPendingAttachment(
                prev,
                item.id,
                err instanceof Error ? err.message : "Could not read file",
              ),
            ),
        );
      }
    },
    [maxBytes],
  );

  const addRemote = useCallback(
    (meta: { name: string; mime: string; size: number }, load: () => Promise<string>) => {
      const item = createPendingAttachment(
        { name: meta.name, type: meta.mime, size: meta.size },
        maxBytes,
      );
      setAttachments((prev) => [...prev, item]);
      if (item.status !== "reading") return;
      load().then(
        (contentBase64) =>
          setAttachments((prev) => resolvePendingAttachment(prev, item.id, contentBase64)),
        (err) =>
          setAttachments((prev) =>
            failPendingAttachment(
              prev,
              item.id,
              err instanceof Error ? err.message : "Could not fetch attachment",
            ),
          ),
      );
    },
    [maxBytes],
  );

  const remove = useCallback((id: string) => {
    setAttachments((prev) => removePendingAttachment(prev, id));
  }, []);

  const clear = useCallback(() => setAttachments([]), []);

  return {
    attachments,
    allReady: allAttachmentsReady(attachments),
    addFiles,
    addRemote,
    remove,
    clear,
  };
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(dataUrlToBase64(String(reader.result)));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

interface AttachmentComposerProps {
  state: ComposeAttachmentsState;
  disabled?: boolean;
  className?: string;
}

/**
 * "Attach files" control for a composer: a picker button plus a chip per
 * picked file, with its read status and a remove button. Over-limit files
 * become error chips carrying the size message; they are never sent.
 */
export function AttachmentComposer({ state, disabled, className }: AttachmentComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handlePickedFiles(evt: ChangeEvent<HTMLInputElement>) {
    if (evt.target.files) state.addFiles(evt.target.files);
    // Reset so picking the same file again re-fires the change event.
    evt.target.value = "";
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      {state.attachments.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-dashed border-border/80 bg-muted/20 p-2">
          {state.attachments.map((attachment) => (
            <div
              key={attachment.id}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-xs",
                attachment.status === "error"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-background/70 text-muted-foreground",
              )}
            >
              {attachment.status === "reading" ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : attachment.status === "ready" ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              )}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-medium",
                  attachment.status === "error" ? "text-destructive" : "text-foreground",
                )}
              >
                {attachment.name}
              </span>
              <span className="shrink-0">
                {attachment.status === "error"
                  ? attachment.error ?? "Failed"
                  : formatByteSize(attachment.size)}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-5 w-5 shrink-0"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => state.remove(attachment.id)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handlePickedFiles}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="text-muted-foreground"
      >
        <Paperclip className="h-3.5 w-3.5" />
        Attach files
      </Button>
    </div>
  );
}
