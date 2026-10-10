import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, File, Loader2, Mic, Paperclip, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  chatApi,
  type AvailableModel,
  type ChatAttachmentSummary,
  type EffortLevel,
  type PermissionMode,
} from "../api/chat";
import { cn } from "../lib/utils";
import { chatModelEntry, type ModelPickerGroup } from "../lib/model-display";
import {
  DEFAULT_NEW_CHAT_SETTINGS,
  type ClippyFirstSendProgress,
  type ClippyNewChatSettings,
} from "../lib/clippy-new-chat";
import type { ClippyPageContext } from "../lib/clippy-page-context";
import { useSpeechDictation } from "../hooks/useSpeechDictation";
import { ClippyChatOptions, type ClippyChatOptionsPatch } from "./ClippyChatOptions";
import { ClippyContextChip } from "./ClippyEmptyState";
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  formatByteSize as formatBytes,
  tooLargeMessage,
  parseInlineConsentReply,
} from "@paperclipai/shared";

interface PendingUpload {
  /** Stable id to track the chip while the upload is in flight. */
  localId: string;
  name: string;
  size: number;
  mediaType: string;
  /** Object URL for image previews; null until we know it's an image. */
  previewUrl: string | null;
  /**
   * "local" is a file picked for a new chat, held here until the first send
   * creates the chat it can be uploaded to.
   */
  status: "local" | "uploading" | "done" | "error";
  error?: string;
  /**
   * The picked file, kept until it is uploaded, so an upload that failed is
   * tried again on the next send. A file turned down before upload (a video,
   * a shortcut, too big) has none and is never sent.
   */
  file?: File;
  /** Set once the server returns the attachment id. */
  attachment?: ChatAttachmentSummary;
}

/** What the new chat's first send creates it with. */
export interface ClippyFirstSendSettings extends ClippyNewChatSettings {
  pageContext: string | null;
}

export interface ClippyComposerHandle {
  /** Send this text now, as if typed and sent (a suggested question). */
  submitText: (text: string) => void;
  focus: () => void;
}

interface Props {
  /** The chat this composer writes to. Null for a new chat, created by its first send. */
  sessionId: string | null;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  model: string;
  streaming: boolean;
  awaitingPermission?: boolean;
  /**
   * Send a message. `createdSessionId` is passed only on a new chat's first
   * send, once `onCreateSession` has made the chat it goes to.
   */
  onSend: (text: string, attachmentIds: string[], createdSessionId?: string) => void | Promise<void>;
  onStopAndSend?: (text: string, attachmentIds: string[]) => void | Promise<void>;
  onAbort: () => void;
  onPatch: (patch: {
    permissionMode?: PermissionMode;
    effort?: EffortLevel;
    model?: string;
  }) => void;
  /**
   * New chat only: create it with what was chosen, and return its id.
   * `progress` is this new chat's own record of how far its first send got;
   * the same one comes back on a retry, so the chat is never made twice.
   */
  onCreateSession?: (settings: ClippyFirstSendSettings, progress: ClippyFirstSendProgress) => Promise<string>;
  /** New chat only: the page it will be told about, shown as a removable chip. */
  pageContext?: ClippyPageContext | null;
  /** Take focus when shown. Off when Clippy reopened by itself after a reload. */
  autoFocus?: boolean;
  ref?: Ref<ClippyComposerHandle>;
}

const MAX_ATTACHMENTS = 8;

const UPLOAD_FAILED_MESSAGE =
  "A file could not be attached, so nothing was sent. Remove it, or send again to try the upload again.";

interface ModelGroup {
  key: string;
  label: string;
  tagline: string;
  items: AvailableModel[];
}

const PROVIDER_INFO: Record<string, { label: string; tagline: string; order: number }> = {
  anthropic: {
    label: "Anthropic",
    tagline: "Claude API — uses ANTHROPIC_API_KEY.",
    order: 10,
  },
  openai: {
    label: "OpenAI",
    tagline: "GPT API — uses OPENAI_API_KEY.",
    order: 20,
  },
  gemini: {
    label: "Google Gemini",
    tagline: "Gemini API — uses GEMINI_API_KEY.",
    order: 30,
  },
  ollama: {
    label: "Ollama",
    tagline: "Local models — no network, no API keys.",
    order: 40,
  },
  claude_local: {
    label: "Claude (local CLI)",
    tagline: "Routed via your local Claude CLI session — no direct API key.",
    order: 50,
  },
  codex_local: {
    label: "OpenAI Codex (local CLI)",
    tagline: "Routed via your local OpenAI Codex CLI session.",
    order: 60,
  },
  aider_local: {
    label: "Aider (local CLI)",
    tagline: "Aider CLI driving local Ollama models.",
    order: 70,
  },
  gemini_local: {
    label: "Gemini (local CLI)",
    tagline: "Routed via your local Gemini CLI session — no direct API key.",
    order: 80,
  },
  ollama_local: {
    label: "Ollama (local CLI)",
    tagline: "Local Ollama models exposed through the Ollama CLI adapter.",
    order: 90,
  },
  opencode_local: {
    label: "OpenCode (local CLI)",
    tagline: "Routed via the OpenCode CLI — multi-provider gateway running on your machine.",
    order: 100,
  },
  cursor: {
    label: "Cursor",
    tagline: "Models exposed via your Cursor session — covers Anthropic, OpenAI, Gemini, xAI, etc.",
    order: 110,
  },
};

function prettifyAdapterKey(key: string): string {
  // Turn "foo_bar_local" into "Foo Bar (local CLI)" so unknown adapters
  // don't render as raw snake_case ALL CAPS in the dropdown header.
  const stripped = key.endsWith("_local") ? key.slice(0, -"_local".length) : key;
  const titled = stripped
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return key.endsWith("_local") ? `${titled} (local CLI)` : titled;
}

function infoForGroupKey(key: string): { label: string; tagline: string; order: number } {
  return (
    PROVIDER_INFO[key] ?? {
      label: prettifyAdapterKey(key),
      tagline: key.endsWith("_local")
        ? "Routed via a local CLI adapter."
        : "Additional provider.",
      order: 1000,
    }
  );
}

function groupModels(models: AvailableModel[]): ModelGroup[] {
  const buckets = new Map<string, AvailableModel[]>();
  for (const m of models) {
    const key = m.source ?? m.provider;
    const list = buckets.get(key);
    if (list) list.push(m);
    else buckets.set(key, [m]);
  }
  return [...buckets.entries()]
    .map(([key, items]): ModelGroup => {
      const info = infoForGroupKey(key);
      return { key, label: info.label, tagline: info.tagline, items };
    })
    .sort((a, b) => {
      const ao = infoForGroupKey(a.key).order;
      const bo = infoForGroupKey(b.key).order;
      if (ao !== bo) return ao - bo;
      return a.label.localeCompare(b.label);
    });
}

function newLocalId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ClippyComposer({
  sessionId,
  permissionMode,
  effort,
  model,
  streaming,
  awaitingPermission = false,
  onSend,
  onStopAndSend,
  onAbort,
  onPatch,
  onCreateSession,
  pageContext = null,
  autoFocus = true,
  ref: handleRef,
}: Props) {
  const isNewChat = sessionId === null;
  const [text, setText] = useState("");
  const [consentError, setConsentError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [dropping, setDropping] = useState(false);
  // A new chat's choices, applied when its first send creates it. The
  // composer is remounted per chat, so each new chat starts from defaults.
  const [newChatSettings, setNewChatSettings] = useState<ClippyNewChatSettings>(DEFAULT_NEW_CHAT_SETTINGS);
  const [pageContextRemoved, setPageContextRemoved] = useState(false);
  // True while a send is creating the chat or uploading files, until it goes.
  const [sendBusy, setSendBusy] = useState(false);
  // How far this new chat's first send got, handed back on a retry so the
  // chat is not made twice (see ClippyFirstSendProgress).
  const firstSendProgressRef = useRef<ClippyFirstSendProgress>({ session: null });
  const dropDepth = useRef(0);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const dictation = useSpeechDictation((spoken) => {
    setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")} ${spoken}` : spoken));
  });

  const modelsQuery = useQuery({
    queryKey: ["clippy", "models"],
    queryFn: () => chatApi.listModels().then((r) => r.models),
    staleTime: 60_000,
  });
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);
  // One heading per provider, each list in the server's order with its
  // older models folded away.
  const modelGroups = useMemo<ModelPickerGroup[]>(
    () =>
      groupModels(models).map((group) => ({
        key: group.key,
        label: group.label,
        description: group.tagline,
        models: group.items.map(chatModelEntry),
      })),
    [models],
  );

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Revoke any object URLs when uploads list changes / unmounts.
  useEffect(() => {
    return () => {
      uploads.forEach((u) => {
        if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setUpload = (localId: string, patch: Partial<PendingUpload>) => {
    setUploads((prev) => prev.map((u) => (u.localId === localId ? { ...u, ...patch } : u)));
  };

  const ingestFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    const slotsLeft = Math.max(0, MAX_ATTACHMENTS - uploads.length);
    const toUpload = list.slice(0, slotsLeft);
    for (const file of toUpload) {
      const localId = newLocalId();
      const isImage = file.type.startsWith("image/");
      const previewUrl = isImage ? URL.createObjectURL(file) : null;
      const base = {
        localId,
        name: file.name || (isImage ? "image" : "file"),
        size: file.size,
        mediaType: file.type || "application/octet-stream",
        previewUrl,
      };

      // Pre-flight checks the server would otherwise reject — show a clearer
      // message inline instead of a generic "API route not found" / 422.
      const preflightError = preflightRejectionFor(file);
      if (preflightError) {
        setUploads((prev) => [...prev, { ...base, status: "error", error: preflightError }]);
        continue;
      }

      // A new chat has nowhere to upload to yet. Hold the file; the first
      // send creates the chat and uploads it then.
      if (!sessionId) {
        setUploads((prev) => [...prev, { ...base, status: "local", file }]);
        continue;
      }

      // The file stays with its chip until the upload works, so a failed
      // upload is tried again when the message is sent.
      setUploads((prev) => [...prev, { ...base, status: "uploading", file }]);
      try {
        const att = await chatApi.uploadAttachment(sessionId, file);
        setUpload(localId, { status: "done", attachment: att, file: undefined });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setUpload(localId, { status: "error", error: msg });
      }
    }
  };

  const removeUpload = (localId: string) => {
    setUploads((prev) => {
      const u = prev.find((p) => p.localId === localId);
      if (u?.previewUrl) URL.revokeObjectURL(u.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  };

  /**
   * Upload every file still waiting, to `targetId`: a new chat's held files,
   * and any whose earlier upload failed. Returns the attachment ids in the
   * order the files were added, or null when one failed. A failed file keeps
   * its chip and its error, and is tried again on the next send; nothing is
   * sent without it.
   */
  const uploadWaitingFiles = async (targetId: string): Promise<string[] | null> => {
    const attachmentIds: string[] = [];
    let failed = false;
    for (const upload of uploads) {
      if (upload.status === "done" && upload.attachment) {
        attachmentIds.push(upload.attachment.id);
        continue;
      }
      // Turned down before upload (a video, a shortcut, too big): its chip
      // says why, and it is never sent.
      if (!upload.file) continue;
      setUpload(upload.localId, { status: "uploading", error: undefined });
      try {
        const att = await chatApi.uploadAttachment(targetId, upload.file);
        setUpload(upload.localId, { status: "done", attachment: att, file: undefined });
        attachmentIds.push(att.id);
      } catch (err) {
        failed = true;
        setUpload(upload.localId, { status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }
    return failed ? null : attachmentIds;
  };

  /**
   * A new chat's first send: create the chat with everything chosen so far,
   * upload the files held for it, then send. Nothing is cleared until all of
   * that worked, so a failure leaves the message, files and choices in place,
   * and a retry carries on with the chat the failed try made.
   */
  const sendFirstMessage = async (trimmed: string) => {
    if (!onCreateSession || sendBusy) return;
    setSendBusy(true);
    setConsentError(null);
    try {
      const createdId = await onCreateSession(
        {
          ...newChatSettings,
          pageContext: pageContext && !pageContextRemoved ? pageContext.value : null,
        },
        firstSendProgressRef.current,
      );
      const attachmentIds = await uploadWaitingFiles(createdId);
      if (attachmentIds === null) {
        setConsentError(UPLOAD_FAILED_MESSAGE);
        return;
      }
      if (!trimmed && attachmentIds.length === 0) return;
      setText("");
      setUploads([]);
      await onSend(trimmed, attachmentIds, createdId);
    } catch (error) {
      setConsentError(error instanceof Error ? error.message : "Your message could not be sent. Please try again.");
    } finally {
      setSendBusy(false);
    }
  };

  const submit = async (opts: { force?: boolean; text?: string } = {}) => {
    const trimmed = (opts.text ?? text).trim();
    const ready = uploads.filter((u) => u.status === "done" && u.attachment);
    // Held for a new chat, or failed before and to be tried again.
    const waiting = uploads.filter((u) => u.status !== "done" && u.status !== "uploading" && u.file);
    if (!trimmed && ready.length === 0 && waiting.length === 0) return;
    if (uploads.some((u) => u.status === "uploading")) return;
    if (isNewChat) {
      await sendFirstMessage(trimmed);
      return;
    }
    if (
      awaitingPermission &&
      !opts.force &&
      (!parseInlineConsentReply(trimmed) || ready.length > 0 || waiting.length > 0)
    ) {
      setConsentError("Reply yes or no to the action above, or use its buttons. Stop the current action to give different instructions.");
      return;
    }
    setConsentError(null);
    if (!opts.force && streaming && !awaitingPermission) return;
    let ids = ready.map((u) => u.attachment!.id);
    if (waiting.length > 0 && sessionId) {
      if (sendBusy) return;
      setSendBusy(true);
      try {
        const uploaded = await uploadWaitingFiles(sessionId);
        if (uploaded === null) {
          setConsentError(UPLOAD_FAILED_MESSAGE);
          return;
        }
        ids = uploaded;
      } finally {
        setSendBusy(false);
      }
    }
    setText("");
    setUploads([]);
    try {
      if (opts.force && onStopAndSend) await onStopAndSend(trimmed, ids);
      else await onSend(trimmed, ids);
    } catch (error) {
      setConsentError(error instanceof Error ? error.message : "Your message could not be sent. Please try again.");
    }
  };

  useImperativeHandle(handleRef, () => ({
    submitText: (suggestion: string) => {
      void submit({ text: suggestion });
    },
    focus: () => ref.current?.focus(),
  }));

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition: CJK and other multi-keystroke input methods commit a
    // candidate via Enter. Don't treat that Enter as a submit.
    const native = e.nativeEvent as KeyboardEvent;
    if (native.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void ingestFiles(files);
    }
  };

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dropDepth.current += 1;
    setDropping(true);
  };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dropDepth.current = Math.max(0, dropDepth.current - 1);
    if (dropDepth.current === 0) setDropping(false);
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dropDepth.current = 0;
    setDropping(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      void ingestFiles(files);
    }
  };

  const anyUploading = uploads.some((u) => u.status === "uploading");
  // A file waiting to upload (held, or failed and to be tried again) counts.
  const hasContent = !!text.trim() || uploads.some((u) => u.status === "done" || (u.file && u.status !== "uploading"));
  const sendDisabled =
    (streaming && !awaitingPermission) || anyUploading || sendBusy || !hasContent;
  const canStopAndSend = streaming && !awaitingPermission && hasContent && !anyUploading && !!onStopAndSend;

  const options = isNewChat ? newChatSettings : { model, permissionMode, effort };
  const changeOptions = (patch: ClippyChatOptionsPatch) => {
    if (isNewChat) setNewChatSettings((prev) => ({ ...prev, ...patch }));
    else onPatch(patch);
  };
  const showPageContext = isNewChat && pageContext && !pageContextRemoved;
  const notice = consentError ?? dictation.error;

  return (
    <div
      className={cn("relative bg-background px-3 pb-2 pt-1", dropping && "ring-2 ring-inset ring-primary/60")}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {dropping && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/10">
          <div className="rounded-md border border-primary/40 bg-background px-3 py-2 text-xs font-medium">
            Drop to attach
          </div>
        </div>
      )}
      <div className="mx-auto max-w-3xl space-y-1.5">
        {showPageContext ? (
          <ClippyContextChip label={pageContext.label} onRemove={() => setPageContextRemoved(true)} />
        ) : null}
        <div className="rounded-lg border border-border bg-background shadow-xs transition-[box-shadow] focus-within:ring-1 focus-within:ring-ring">
          {uploads.length > 0 && (
            <div className="flex flex-wrap gap-2 px-2.5 pt-2.5">
              {uploads.map((u) => (
                <UploadChip key={u.localId} upload={u} onRemove={() => removeUpload(u.localId)} />
              ))}
            </div>
          )}
          <Textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder="Ask Clippy anything"
            aria-label="Message Clippy"
            rows={2}
            className="max-h-48 min-h-[52px] resize-none border-0 bg-transparent px-3 py-2.5 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            <Button
              size="icon-sm"
              variant="ghost"
              className="size-7 text-muted-foreground"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming || sendBusy || uploads.length >= MAX_ATTACHMENTS}
              title="Attach files (or drop or paste them here)"
              aria-label="Attach files"
              type="button"
            >
              <Paperclip className="size-4" />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void ingestFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <div className="ml-auto flex min-w-0 items-center gap-1">
              <ClippyChatOptions
                model={options.model}
                permissionMode={options.permissionMode}
                effort={options.effort}
                models={models}
                modelGroups={modelGroups}
                modelsLoading={modelsQuery.isLoading}
                allowDefaultModel={isNewChat}
                disabled={streaming || sendBusy}
                onChange={changeOptions}
              />
              {dictation.supported ? (
                // A toggle: one name, with aria-pressed saying whether it is on.
                <Button
                  size="icon-sm"
                  variant="ghost"
                  type="button"
                  className={cn("size-7", dictation.listening ? "text-destructive" : "text-muted-foreground")}
                  aria-label="Dictate"
                  aria-pressed={dictation.listening}
                  title="Dictate"
                  onClick={dictation.listening ? dictation.stop : dictation.start}
                >
                  <Mic className={cn("size-4", dictation.listening && "animate-pulse motion-reduce:animate-none")} />
                </Button>
              ) : null}
              {streaming && (
                <Button size="icon-sm" variant="ghost" className="size-7" onClick={onAbort} aria-label="Stop" title="Stop">
                  <Square className="size-3.5" />
                </Button>
              )}
              {canStopAndSend ? (
                <Button size="xs" className="h-7" onClick={() => submit({ force: true })}>
                  Stop & Send
                </Button>
              ) : (!streaming || awaitingPermission) && (
                <Button
                  size="icon-sm"
                  className="size-7"
                  onClick={() => submit()}
                  disabled={sendDisabled}
                  aria-label="Send"
                  title="Send (Enter). Shift+Enter for a new line"
                >
                  {sendBusy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                </Button>
              )}
            </div>
          </div>
        </div>
        {notice && <p role="alert" className="text-xs text-destructive">{notice}</p>}
        {models.length === 0 && !modelsQuery.isLoading && (
          <div className="text-xs text-muted-foreground">
            No LLM provider configured. Set <code>ANTHROPIC_API_KEY</code>,{" "}
            <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code>, or start a local Ollama (
            <code>OLLAMA_HOST</code>) to enable Clippy.
          </div>
        )}
        <p className="text-center text-xs text-muted-foreground">Uses AI. Verify results.</p>
      </div>
    </div>
  );
}

function UploadChip({ upload, onRemove }: { upload: PendingUpload; onRemove: () => void }) {
  const isImage = upload.mediaType.startsWith("image/");
  const errored = upload.status === "error";
  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 rounded-md border bg-muted/40 p-1.5 pr-2 text-xs",
        errored ? "border-red-300 dark:border-red-900" : "border-border",
      )}
      title={errored ? upload.error : `${upload.name} · ${formatBytes(upload.size)}`}
    >
      {isImage && upload.previewUrl ? (
        <img
          src={upload.previewUrl}
          alt={upload.name}
          className="h-10 w-10 rounded object-cover"
        />
      ) : (
        <div className="flex h-10 w-10 items-center justify-center rounded bg-background">
          <File className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
      <div className="flex min-w-0 max-w-[150px] flex-col">
        <span className="truncate font-medium">{upload.name}</span>
        <span className="text-[10px] text-muted-foreground">
          {upload.status === "uploading" ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> uploading…
            </span>
          ) : errored ? (
            <span className="text-red-600 dark:text-red-400">{upload.error ?? "upload failed"}</span>
          ) : (
            formatBytes(upload.size)
          )}
        </span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 rounded-full bg-background p-0.5 text-muted-foreground shadow ring-1 ring-border hover:text-foreground"
        title="Remove"
        aria-label="Remove attachment"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// Same default the server enforces, imported rather than re-typed so the
// number the user is told can't drift from the number actually applied.
// Tested client-side so they get feedback without a round-trip.
const CLIENT_MAX_BYTES = DEFAULT_MAX_ATTACHMENT_BYTES;

/**
 * Reject the obvious "this won't work" cases before we even hit the server,
 * so the chip's error makes sense. Notably:
 *  - Windows shortcuts (`.lnk`) carry the shortcut metadata, not the target.
 *    Browsers report them as `application/x-ms-shortcut` (or no MIME) and
 *    the server allowlist would reject anyway with a less obvious message.
 *  - Empty / zero-byte drops (folders, broken handoffs).
 *  - Video and audio, which upload fine but which the assistant cannot
 *    actually watch or listen to. Letting those through looks like success
 *    and then quietly does nothing, which is worse than a clear refusal —
 *    so say what it can't do and name the two things that do work.
 */
function preflightRejectionFor(file: File): string | null {
  const name = (file.name ?? "").toLowerCase();
  const mime = (file.type ?? "").toLowerCase();
  if (name.endsWith(".lnk") || mime === "application/x-ms-shortcut") {
    return "Windows shortcuts can't be uploaded — drop the actual file";
  }
  if (name.endsWith(".url") || mime === "application/internet-shortcut") {
    return "Internet shortcuts can't be uploaded — drop the actual file";
  }
  if (mime.startsWith("video/") || mime.startsWith("audio/")) {
    return (
      "I can't watch video or listen to audio. Send a screenshot of the " +
      "moment that matters, or paste the file's path and I'll read it off disk."
    );
  }
  if (file.size === 0) {
    // Folder drops show up as zero-byte entries in some browsers. So do
    // genuinely empty files; either way there's nothing useful to send.
    return "File is empty (folders can't be uploaded — drop a file inside)";
  }
  if (file.size > CLIENT_MAX_BYTES) {
    return tooLargeMessage(file.size, CLIENT_MAX_BYTES);
  }
  return null;
}
