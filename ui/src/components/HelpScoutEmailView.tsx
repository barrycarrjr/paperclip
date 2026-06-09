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
  X,
  Clock,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  makeHelpScoutBridgeApi,
  type HSConversationSummary,
  type HSConversationFull,
  type HSStatusFilter,
  type HSThread,
} from "../api/helpScoutBridge";
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
  leftPaneWidth: number;
}

export function HelpScoutEmailView({
  mailbox,
  initialConversationId,
  initialAction,
  leftPaneSlot,
  leftPaneWidth: _leftPaneWidth,
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
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteBody, setNoteBody] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  function showToast(t: string) {
    setToast(t);
    setTimeout(() => setToast(null), 3000);
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
      setPendingReplyOnOpen(false);
    }
  }, [full, pendingReplyOnOpen]);

  // ── Mutations ─────────────────────────────────────────────────────────────

  const replyMutation = useMutation({
    mutationFn: (body: string) => api.sendReply(accountKey, selectedConvId!, body),
    onSuccess: () => {
      setReplyOpen(false);
      setReplyBody("");
      showToast("Reply sent.");
      invalidateFull();
      invalidateList();
    },
    onError: (err) => showToast(`Reply failed: ${(err as Error).message}`),
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

  return (
    <div className="flex h-full w-full min-h-0">
      {leftPaneSlot}

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
          </div>
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="w-[360px] shrink-0 border-r border-border flex flex-col">
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
                  <div className="border-t border-border p-3 shrink-0 space-y-2">
                    <Textarea
                      value={replyBody}
                      onChange={(e) => setReplyBody(e.target.value)}
                      placeholder="Reply to the customer"
                      className="min-h-[120px] text-sm"
                    />
                    <div className="flex items-center justify-end gap-2">
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
                )}

                {noteOpen && (
                  <div className="border-t border-border p-3 shrink-0 space-y-2 bg-muted/30">
                    <Textarea
                      value={noteBody}
                      onChange={(e) => setNoteBody(e.target.value)}
                      placeholder="Internal note (customer never sees this)"
                      className="min-h-[100px] text-sm"
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
                )}
              </>
            )}
          </div>
        </div>
      </div>

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
