import { useEffect, useMemo, useState } from "react";
import {
  Mail,
  Inbox,
  Loader2,
  Reply,
  Check,
  Archive,
  Trash2,
  AlertCircle,
  StickyNote,
  Send,
  Sparkles,
  Pencil,
  X,
  Clock,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  makeHelpScoutBridgeApi,
  type HSConversationSummary,
  type HSConversationFull,
  type HSStatusFilter,
  type HSThread,
} from "../api/helpScoutBridge";
import { emailDraftsApi } from "../api/emailDrafts";
import type { AvailableModel } from "../api/chat";
import { DraftModelSelect } from "./DraftModelSelect";
import { DraftInstructionsField } from "./DraftInstructionsField";
import { pickDraftSource } from "../lib/helpscout-draft-source";
import { isComposeReady } from "../lib/helpscout-compose";
import {
  COMPOSER_HEIGHT_STORAGE_KEY,
  DEFAULT_COMPOSER_HEIGHT,
  DEFAULT_LIST_WIDTH,
  LIST_WIDTH_STORAGE_KEY,
  clampComposerHeight,
  clampListWidth,
  loadPaneSize,
  savePaneSize,
} from "../lib/helpscout-pane-layout";
import type { HelpScoutMailboxRef } from "../lib/mailboxKind";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

const KEEP_ALWAYS_LABEL = "keep-always";
const AUTO_NOISE_LABEL = "auto-noise";

const STATUS_OPTIONS: Array<{ value: HSStatusFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "active", label: "Active" },
  { value: "pending", label: "Pending" },
  { value: "closed", label: "Closed" },
  { value: "spam", label: "Spam" },
];

const STATUS_FILTER_STORAGE_KEY = "helpscout-status-filter";

function loadPersistedStatus(): HSStatusFilter {
  try {
    const saved = localStorage.getItem(STATUS_FILTER_STORAGE_KEY);
    if (saved && STATUS_OPTIONS.some((o) => o.value === saved)) {
      return saved as HSStatusFilter;
    }
  } catch {}
  return "open";
}

interface HelpScoutEmailViewProps {
  mailbox: HelpScoutMailboxRef;
  initialConversationId: string | null;
  initialAction: "reply" | "handoff" | null;
  leftPaneSlot: React.ReactNode;
  /** The mailbox column's resize handle, owned by the Email page so both mail
   *  surfaces drag the same width. */
  leftPaneHandleSlot: React.ReactNode;
  /** AI Draft model, "" = server auto-picks. Shared with the IMAP composer. */
  draftModel: string;
  onDraftModelChange: (model: string) => void;
  draftModels: AvailableModel[];
}

export function HelpScoutEmailView({
  mailbox,
  initialConversationId,
  initialAction,
  leftPaneSlot,
  leftPaneHandleSlot,
  draftModel,
  onDraftModelChange,
  draftModels,
}: HelpScoutEmailViewProps) {
  const queryClient = useQueryClient();
  const { pluginId, primaryCompanyId, accountKey, mailboxId } = mailbox;

  const api = useMemo(
    () => makeHelpScoutBridgeApi(pluginId, primaryCompanyId),
    [pluginId, primaryCompanyId],
  );

  const [status, setStatus] = useState<HSStatusFilter>(() => loadPersistedStatus());
  const [selectedConvId, setSelectedConvId] = useState<string | null>(initialConversationId);

  useEffect(() => {
    try {
      localStorage.setItem(STATUS_FILTER_STORAGE_KEY, status);
    } catch {}
  }, [status]);
  const [pendingReplyOnOpen, setPendingReplyOnOpen] = useState<boolean>(
    initialAction === "reply",
  );
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [draftInstructions, setDraftInstructions] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteBody, setNoteBody] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  // Compose a brand new conversation. Plain controlled state rather than the
  // Email page's DraftInput isolation — this component is small enough that a
  // re-render per keystroke costs nothing.
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeInstructions, setComposeInstructions] = useState("");

  function showToast(t: string) {
    setToast(t);
    setTimeout(() => setToast(null), 3000);
  }

  // ── Resizable panes ───────────────────────────────────────────────────────
  // Conversation list width (everything right of it is the message preview)
  // and composer height. Both persist so the operator's layout survives a
  // refresh, same treatment the mailbox column's width already gets.

  const [listWidth, setListWidth] = useState(() =>
    loadPaneSize(LIST_WIDTH_STORAGE_KEY, DEFAULT_LIST_WIDTH, clampListWidth),
  );
  const [composerHeight, setComposerHeight] = useState(() =>
    loadPaneSize(COMPOSER_HEIGHT_STORAGE_KEY, DEFAULT_COMPOSER_HEIGHT, clampComposerHeight),
  );

  function startListDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = listWidth;
    let last = startWidth;
    const onMove = (ev: MouseEvent) => {
      last = clampListWidth(startWidth + (ev.clientX - startX));
      setListWidth(last);
    };
    const onUp = () => {
      savePaneSize(LIST_WIDTH_STORAGE_KEY, last);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Dragging the composer's top edge upward makes it taller, so the delta is
  // inverted relative to the cursor's Y movement.
  function startComposerDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = composerHeight;
    let last = startHeight;
    const onMove = (ev: MouseEvent) => {
      last = clampComposerHeight(startHeight - (ev.clientY - startY));
      setComposerHeight(last);
    };
    const onUp = () => {
      savePaneSize(COMPOSER_HEIGHT_STORAGE_KEY, last);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── Conversation list ─────────────────────────────────────────────────────

  const listKey = [
    "helpscout",
    pluginId,
    primaryCompanyId,
    accountKey,
    mailboxId,
    status,
  ];

  const { data: listData, isLoading: listLoading, error: listError } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      api.listConversations({
        accountKey,
        mailboxId,
        status,
        limit: 50,
      }),
    refetchInterval: 30_000,
  });

  // Optimistic list removal so close/auto-noise/spam clicks update the row
  // instantly rather than waiting for the API round-trip + refetch + Help
  // Scout's own eventual consistency on status changes.
  const [optimisticallyRemovedIds, setOptimisticallyRemovedIds] = useState<Set<string>>(
    new Set(),
  );

  // A conversation we removed from "active" should re-appear if the operator
  // pivots to "closed" — reset the set whenever the listKey identity changes.
  useEffect(() => {
    setOptimisticallyRemovedIds(new Set());
  }, [status, accountKey, mailboxId]);

  function optimisticallyRemoveConv(id: string) {
    setOptimisticallyRemovedIds((prev) => new Set([...prev, id]));
  }
  function unremoveConv(id: string) {
    setOptimisticallyRemovedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  const conversations = (listData?.conversations ?? []).filter(
    (c) => !optimisticallyRemovedIds.has(c.id),
  );

  function invalidateList() {
    queryClient.invalidateQueries({ queryKey: listKey });
  }

  // ── Full conversation (threads) ───────────────────────────────────────────

  const fullKey = ["helpscout", pluginId, primaryCompanyId, accountKey, "conv", selectedConvId];
  const { data: full, isLoading: fullLoading } = useQuery({
    queryKey: fullKey,
    queryFn: () => api.getConversation(accountKey, selectedConvId!),
    enabled: !!selectedConvId,
  });

  function invalidateFull() {
    queryClient.invalidateQueries({ queryKey: fullKey });
  }

  useEffect(() => {
    if (pendingReplyOnOpen && full && full.id !== undefined) {
      setReplyOpen(true);
      setReplyBody("");
      setDraftInstructions("");
      setPendingReplyOnOpen(false);
    }
  }, [full, pendingReplyOnOpen]);

  // Draft instructions belong to one conversation — "tell them Q3 for guest
  // checkout" must never carry over to the next customer.
  useEffect(() => {
    setDraftInstructions("");
  }, [selectedConvId]);

  // ── Mutations ─────────────────────────────────────────────────────────────

  const replyMutation = useMutation({
    mutationFn: (body: string) => api.sendReply(accountKey, selectedConvId!, body),
    onSuccess: () => {
      setReplyOpen(false);
      setReplyBody("");
      setDraftInstructions("");
      showToast("Reply sent.");
      invalidateFull();
      invalidateList();
    },
    onError: (err) => showToast(`Reply failed: ${(err as Error).message}`),
  });

  // The instructions field steers the draft; the reply box holds the reply
  // itself. When the box already has text we send it along so the model revises
  // it in place, which is what makes a second click a refinement rather than a
  // fresh start. Same contract as the IMAP composer.
  const draftMutation = useMutation({
    mutationFn: (input: {
      source: NonNullable<ReturnType<typeof pickDraftSource>>;
      instructions: string;
      currentDraft: string;
    }) =>
      emailDraftsApi.draftReply({
        subject: input.source.subject,
        from: input.source.from,
        bodyText: input.source.bodyText,
        instructions: input.instructions.trim() || undefined,
        currentDraft: input.currentDraft.trim() || undefined,
        model: draftModel || undefined,
      }),
    onSuccess: (result) => setReplyBody(result.draft),
    onError: (err) => showToast(`Draft failed: ${(err as Error).message}`),
  });

  function runDraft() {
    if (!draftSource || draftMutation.isPending) return;
    draftMutation.mutate({
      source: draftSource,
      instructions: draftInstructions,
      currentDraft: replyBody,
    });
  }

  const composeMutation = useMutation({
    mutationFn: (input: { to: string; subject: string; body: string }) =>
      api.createConversation(accountKey, { ...input, mailboxId }),
    onSuccess: (result) => {
      setComposeOpen(false);
      setComposeTo("");
      setComposeSubject("");
      setComposeBody("");
      setComposeInstructions("");
      showToast("Message sent.");
      invalidateList();
      // Help Scout files a new conversation as "active"; jump straight to it so
      // the operator sees it even when the current filter would hide it.
      if (result.id) setSelectedConvId(result.id);
    },
    onError: (err) => showToast(`Send failed: ${(err as Error).message}`),
  });

  // AI draft for a brand new message. Nothing to reply to here, so the
  // instructions carry the whole message — "chase them for artwork files".
  const composeDraftMutation = useMutation({
    mutationFn: () =>
      emailDraftsApi.draftReply({
        mode: "new",
        to: composeTo.trim() || undefined,
        subject: composeSubject.trim() || undefined,
        bodyText: "",
        instructions: composeInstructions.trim() || undefined,
        currentDraft: composeBody.trim() || undefined,
        model: draftModel || undefined,
      }),
    onSuccess: (result) => setComposeBody(result.draft),
    onError: (err) => showToast(`Draft failed: ${(err as Error).message}`),
  });

  function runComposeDraft() {
    if (composeDraftMutation.isPending) return;
    if (!composeInstructions.trim() && !composeSubject.trim() && !composeBody.trim()) {
      showToast("Tell the AI what the message should say first.");
      return;
    }
    composeDraftMutation.mutate();
  }

  function openCompose() {
    setComposeTo("");
    setComposeSubject("");
    setComposeBody("");
    setComposeInstructions("");
    setComposeOpen(true);
  }

  const composeReady = isComposeReady({
    to: composeTo,
    subject: composeSubject,
    body: composeBody,
  });

  const noteMutation = useMutation({
    mutationFn: (body: string) => api.addNote(accountKey, selectedConvId!, body),
    onSuccess: () => {
      setNoteOpen(false);
      setNoteBody("");
      showToast("Note added.");
      invalidateFull();
    },
    onError: (err) => showToast(`Note failed: ${(err as Error).message}`),
  });

  const keepActiveMutation = useMutation({
    mutationFn: () => api.addLabel(accountKey, selectedConvId!, [KEEP_ALWAYS_LABEL]),
    onSuccess: () => {
      showToast("Tagged keep-always.");
      invalidateFull();
      invalidateList();
    },
  });

  const autoNoiseMutation = useMutation({
    mutationFn: async () => {
      const id = selectedConvId!;
      optimisticallyRemoveConv(id);
      try {
        await api.addLabel(accountKey, id, [AUTO_NOISE_LABEL]);
        await api.changeStatus(accountKey, id, "closed");
      } catch (e) {
        unremoveConv(id);
        throw e;
      }
    },
    onSuccess: () => {
      showToast("Auto-noise: tagged and closed.");
      invalidateList();
      setSelectedConvId(null);
    },
    onError: (err) => showToast(`Auto-noise failed: ${(err as Error).message}`),
  });

  const closeMutation = useMutation({
    mutationFn: async () => {
      const id = selectedConvId!;
      optimisticallyRemoveConv(id);
      try {
        return await api.changeStatus(accountKey, id, "closed");
      } catch (e) {
        unremoveConv(id);
        throw e;
      }
    },
    onSuccess: () => {
      showToast("Closed.");
      invalidateList();
      setSelectedConvId(null);
    },
    onError: (err) => showToast(`Close failed: ${(err as Error).message}`),
  });

  // "Pending" = HS's "I see this, parking it." Only optimistically take the
  // row off the list when the current filter excludes pending — under "open"
  // or "pending" the row should stay visible (just with a different dot).
  const pendingStillMatchesFilter = status === "open" || status === "pending";
  const pendingMutation = useMutation({
    mutationFn: async () => {
      const id = selectedConvId!;
      if (!pendingStillMatchesFilter) optimisticallyRemoveConv(id);
      try {
        return await api.changeStatus(accountKey, id, "pending");
      } catch (e) {
        if (!pendingStillMatchesFilter) unremoveConv(id);
        throw e;
      }
    },
    onSuccess: () => {
      showToast("Marked pending.");
      invalidateList();
      invalidateFull();
      if (!pendingStillMatchesFilter) setSelectedConvId(null);
    },
    onError: (err) => showToast(`Pending failed: ${(err as Error).message}`),
  });

  const reopenMutation = useMutation({
    mutationFn: () => api.changeStatus(accountKey, selectedConvId!, "active"),
    onSuccess: () => {
      showToast("Reopened.");
      invalidateList();
      invalidateFull();
    },
  });

  const spamMutation = useMutation({
    mutationFn: async () => {
      const id = selectedConvId!;
      optimisticallyRemoveConv(id);
      try {
        return await api.changeStatus(accountKey, id, "spam");
      } catch (e) {
        unremoveConv(id);
        throw e;
      }
    },
    onSuccess: () => {
      showToast("Marked spam.");
      invalidateList();
      setSelectedConvId(null);
    },
    onError: (err) => showToast(`Spam failed: ${(err as Error).message}`),
  });

  // ── Render ────────────────────────────────────────────────────────────────

  const selectedSummary = conversations.find((c) => c.id === selectedConvId) ?? null;
  const fullStatus = (full?.status as string | undefined) ?? selectedSummary?.status ?? null;
  const draftSource = useMemo(() => pickDraftSource(full), [full]);

  return (
    <div className="flex h-full w-full min-h-0">
      {leftPaneSlot}
      {leftPaneHandleSlot}

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
          <span className="text-sm font-medium truncate">{mailbox.name}</span>
          <div className="flex items-center gap-1">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  setStatus(opt.value);
                  setSelectedConvId(null);
                }}
                className={cn(
                  "text-xs px-2 py-1 rounded hover:bg-accent",
                  status === opt.value && "bg-accent font-medium",
                )}
              >
                {opt.label}
              </button>
            ))}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-1"
                  onClick={openCompose}
                  aria-label="Compose new message"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Compose new message</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="shrink-0 flex flex-col" style={{ width: listWidth }}>
            <ScrollArea className="flex-1">
              <ConversationListColumn
                conversations={conversations}
                isLoading={listLoading}
                error={listError as Error | null}
                selectedConvId={selectedConvId}
                onSelect={setSelectedConvId}
              />
            </ScrollArea>
          </div>

          {/* Drag left to give the message preview more room */}
          <div
            className="w-1 shrink-0 cursor-col-resize border-r border-border hover:bg-primary/30 active:bg-primary/50 transition-colors"
            onMouseDown={startListDrag}
            title="Drag to resize the conversation list"
          />

          <div className="flex-1 min-w-0 flex flex-col">
            {selectedConvId == null ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                Select a conversation.
              </div>
            ) : fullLoading || !full ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">
                      {(full.subject as string) || "(no subject)"}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {full.primaryCustomer?.email ??
                        full.customer?.email ??
                        selectedSummary?.customer?.email ??
                        ""}{" "}
                      · status: {fullStatus ?? "?"}
                      {full.tags && full.tags.length > 0 && (
                        <> · tags: {full.tags.map((t) => t.tag).filter(Boolean).join(", ")}</>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => {
                            setReplyOpen(true);
                            setReplyBody("");
                            setDraftInstructions("");
                          }}
                          aria-label="Reply"
                        >
                          <Reply className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Reply</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => {
                            setNoteOpen(true);
                            setNoteBody("");
                          }}
                          aria-label="Add note"
                        >
                          <StickyNote className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Add internal note</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={keepActiveMutation.isPending}
                          onClick={() => keepActiveMutation.mutate()}
                          aria-label="Keep active"
                        >
                          {keepActiveMutation.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Tag keep-always</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={autoNoiseMutation.isPending}
                          onClick={() => autoNoiseMutation.mutate()}
                          aria-label="Auto-noise"
                        >
                          {autoNoiseMutation.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Archive className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Auto-noise tag and close</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={pendingMutation.isPending}
                          onClick={() => pendingMutation.mutate()}
                          aria-label="Mark pending"
                        >
                          {pendingMutation.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Clock className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Mark pending (snooze)</TooltipContent>
                    </Tooltip>
                    {fullStatus === "closed" ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={reopenMutation.isPending}
                            onClick={() => reopenMutation.mutate()}
                            aria-label="Reopen"
                          >
                            {reopenMutation.isPending ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Inbox className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Reopen (active)</TooltipContent>
                      </Tooltip>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={closeMutation.isPending}
                            onClick={() => closeMutation.mutate()}
                            aria-label="Close"
                          >
                            {closeMutation.isPending ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <X className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Close</TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={spamMutation.isPending}
                          onClick={() => spamMutation.mutate()}
                          aria-label="Spam"
                          className="hover:text-destructive"
                        >
                          {spamMutation.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Close as spam</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                <ScrollArea className="flex-1 min-h-0">
                  <ThreadList full={full} />
                </ScrollArea>

                {replyOpen && (
                  <div className="border-t border-border shrink-0">
                    <div
                      className="h-1.5 cursor-row-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
                      onMouseDown={startComposerDrag}
                      title="Drag up to make the reply box taller"
                    />
                    <div className="px-3 pb-3 space-y-2">
                      <Textarea
                        value={replyBody}
                        onChange={(e) => setReplyBody(e.target.value)}
                        placeholder="Reply to the customer"
                        // field-sizing-fixed so the dragged height wins over
                        // the Textarea default's grow-with-content sizing.
                        className="text-sm resize-none field-sizing-fixed"
                        style={{ height: composerHeight }}
                      />
                      <DraftInstructionsField
                        value={draftInstructions}
                        onChange={setDraftInstructions}
                        onSubmit={runDraft}
                        refining={!!replyBody.trim()}
                        disabled={!draftSource || draftMutation.isPending}
                      />
                      <div className="flex items-center justify-end gap-2">
                        <DraftModelSelect
                          value={draftModel}
                          onChange={onDraftModelChange}
                          models={draftModels}
                        />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!draftSource || draftMutation.isPending}
                              onClick={runDraft}
                            >
                              {draftMutation.isPending ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Sparkles className="h-3.5 w-3.5" />
                              )}
                              {replyBody.trim() ? "AI Revise" : "AI Draft"}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {!draftSource
                              ? "No customer message to draft a reply to"
                              : replyBody.trim()
                                ? "Rewrite the reply above, applying your instructions"
                                : "Write a reply with AI, following your instructions"}
                          </TooltipContent>
                        </Tooltip>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setReplyOpen(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          disabled={!replyBody.trim() || replyMutation.isPending}
                          onClick={() => replyMutation.mutate(replyBody)}
                        >
                          {replyMutation.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Send className="h-3.5 w-3.5 mr-1" />
                          )}
                          Send reply
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {noteOpen && (
                  <div className="border-t border-border shrink-0 bg-muted/30">
                    <div
                      className="h-1.5 cursor-row-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
                      onMouseDown={startComposerDrag}
                      title="Drag up to make the note box taller"
                    />
                    <div className="px-3 pb-3 space-y-2">
                      <Textarea
                        value={noteBody}
                        onChange={(e) => setNoteBody(e.target.value)}
                        placeholder="Internal note (customer never sees this)"
                        className="text-sm resize-none field-sizing-fixed"
                        style={{ height: composerHeight }}
                      />
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setNoteOpen(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          disabled={!noteBody.trim() || noteMutation.isPending}
                          onClick={() => noteMutation.mutate(noteBody)}
                        >
                          {noteMutation.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <StickyNote className="h-3.5 w-3.5 mr-1" />
                          )}
                          Add note
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <Dialog open={composeOpen} onOpenChange={setComposeOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New message from {mailbox.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">To</label>
              <Input
                value={composeTo}
                onChange={(e) => setComposeTo(e.target.value)}
                placeholder="customer@example.com"
                className="text-sm"
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Subject
              </label>
              <Input
                value={composeSubject}
                onChange={(e) => setComposeSubject(e.target.value)}
                placeholder="Subject"
                className="text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Message
              </label>
              <Textarea
                value={composeBody}
                onChange={(e) => setComposeBody(e.target.value)}
                placeholder="Write your message…"
                className="min-h-[180px] max-h-[400px] text-sm resize-none overflow-y-auto"
              />
            </div>
            <DraftInstructionsField
              value={composeInstructions}
              onChange={setComposeInstructions}
              onSubmit={runComposeDraft}
              refining={!!composeBody.trim()}
              disabled={composeDraftMutation.isPending}
            />
          </div>
          <div className="flex justify-end gap-2">
            <DraftModelSelect
              value={draftModel}
              onChange={onDraftModelChange}
              models={draftModels}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  disabled={composeDraftMutation.isPending}
                  onClick={runComposeDraft}
                >
                  {composeDraftMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {composeBody.trim() ? "AI Revise" : "AI Draft"}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {composeBody.trim()
                  ? "Rewrite the message above, applying your instructions"
                  : "Write the message with AI, following your instructions"}
              </TooltipContent>
            </Tooltip>
            <div className="flex-1" />
            <Button variant="ghost" onClick={() => setComposeOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!composeReady || composeMutation.isPending}
              onClick={() =>
                composeMutation.mutate({
                  to: composeTo.trim(),
                  subject: composeSubject.trim(),
                  body: composeBody.trim(),
                })
              }
            >
              {composeMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {toast && (
        <div className="fixed bottom-4 right-4 bg-foreground text-background text-xs px-3 py-2 rounded shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

interface ConversationListColumnProps {
  conversations: HSConversationSummary[];
  isLoading: boolean;
  error: Error | null;
  selectedConvId: string | null;
  onSelect: (id: string) => void;
}

function ConversationListColumn({
  conversations,
  isLoading,
  error,
  selectedConvId,
  onSelect,
}: ConversationListColumnProps) {
  if (error) {
    return (
      <div className="p-3 flex flex-col items-center gap-1 text-xs text-muted-foreground">
        <AlertCircle className="h-4 w-4 text-destructive" />
        {error.message}
      </div>
    );
  }
  if (isLoading && conversations.length === 0) {
    return (
      <div className="p-3 flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (conversations.length === 0) {
    return (
      <div className="p-3 text-center text-xs text-muted-foreground">
        No conversations in this view.
      </div>
    );
  }
  return (
    <div className="divide-y divide-border">
      {conversations.map((c) => {
        const customer = c.customer?.name || c.customer?.email || "(unknown)";
        const isSelected = c.id === selectedConvId;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className={cn(
              "w-full text-left px-3 py-2 hover:bg-accent/40 flex items-start gap-2",
              isSelected && "bg-accent",
            )}
          >
            <span
              className={cn(
                "mt-1.5 h-1.5 w-1.5 rounded-full shrink-0",
                c.status === "active"
                  ? "bg-blue-500"
                  : c.status === "pending"
                    ? "border border-blue-500"
                    : "bg-transparent",
              )}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={cn(
                    "text-xs truncate",
                    c.status === "active" && "font-semibold",
                  )}
                >
                  {customer}
                </span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {c.modifiedAt ? timeAgo(new Date(c.modifiedAt)) : ""}
                </span>
              </div>
              <div className="text-xs text-muted-foreground truncate mt-0.5">
                {c.subject ?? "(no subject)"}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ThreadList({ full }: { full: HSConversationFull }) {
  const threads = (full._embedded?.threads ?? []) as HSThread[];
  if (threads.length === 0) {
    return (
      <div className="p-6 text-center text-xs text-muted-foreground">
        <Mail className="mx-auto h-6 w-6 mb-2" />
        No threads in this conversation.
      </div>
    );
  }
  return (
    <div className="p-4 space-y-4">
      {threads.map((t) => (
        <ThreadCard key={t.id} thread={t} />
      ))}
    </div>
  );
}

function ThreadCard({ thread }: { thread: HSThread }) {
  const kind = thread.type;
  const author = formatAuthor(thread);
  const ts = thread.createdAt ? new Date(thread.createdAt) : null;
  const body = thread.body || thread.text || "";
  const isNote = kind === "note";
  const isReply = kind === "reply" || kind === "message";

  return (
    <div
      className={cn(
        "rounded border border-border p-3 text-sm",
        isNote && "bg-yellow-500/10 border-yellow-500/20",
        isReply && "bg-blue-500/5",
      )}
    >
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <span className="text-xs font-medium">
          {author}
          <span className="ml-2 text-muted-foreground font-normal">· {kind}</span>
        </span>
        {ts && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {timeAgo(ts)}
          </span>
        )}
      </div>
      {/* Email HTML is authored for a white background. Render it as a light
          island (white bg, dark text, forced light color-scheme) so the app's
          dark theme doesn't leave the body text washed-out and unreadable. */}
      <div
        className="rounded bg-white text-zinc-900 [color-scheme:light] p-2 text-xs whitespace-pre-wrap break-words overflow-x-auto"
        dangerouslySetInnerHTML={renderThreadBody(body)}
      />
    </div>
  );
}

function formatAuthor(thread: HSThread): string {
  const cb = thread.createdBy;
  if (cb?.first || cb?.last) return `${cb.first ?? ""} ${cb.last ?? ""}`.trim();
  if (cb?.email) return cb.email;
  if (thread.customer?.first || thread.customer?.last) {
    return `${thread.customer.first ?? ""} ${thread.customer.last ?? ""}`.trim();
  }
  if (thread.customer?.email) return thread.customer.email;
  return "(unknown)";
}

/** Help Scout returns HTML in `body`. We strip the obvious script/style and
 *  render — same trust level as the IMAP message body pane, which also renders
 *  HTML directly. If we need full sanitization later, swap for DOMPurify. */
function renderThreadBody(html: string): { __html: string } {
  return { __html: html };
}
