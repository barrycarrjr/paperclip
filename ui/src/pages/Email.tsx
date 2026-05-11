import { useEffect, useMemo, useRef, useState } from "react";
import {
  Mail,
  MailOpen,
  ChevronRight,
  Inbox,
  FolderOpen,
  Loader2,
  Bot,
  AlertCircle,
  Eye,
  EyeOff,
  MoveRight,
  Archive,
  UserCheck,
  Check,
  X,
  Reply,
  Send,
  Pencil,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useEmailToolsPlugin } from "../hooks/useEmailToolsPlugin";
import { makeEmailToolsApi, type MailHeader, type ParsedEmailMessage } from "../api/emailTools";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import {
  graduateSender,
  keepAlwaysSender,
} from "../lib/email-triage-rules";
import type { IssueDocument } from "@paperclipai/shared";

const TRIAGE_FOLDER = "_paperclip/triage";
const RULES_HOME_TITLE_PREFIX = "Email triage rules - ";
const RULES_HOME_DOC_KEY = "email-triage-rules";

interface RulesBundle {
  issueId: string;
  title: string;
  body: string;
  latestRevisionId: string | null;
}

export function Email() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Email" }]);
  }, [setBreadcrumbs]);

  const { pluginId, hasMailboxForCompany, isLoading: pluginLoading } =
    useEmailToolsPlugin(selectedCompanyId);

  const emailApi = useMemo(
    () => (pluginId && selectedCompanyId ? makeEmailToolsApi(pluginId, selectedCompanyId) : null),
    [pluginId, selectedCompanyId],
  );

  const [selectedMailbox, setSelectedMailbox] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string>("INBOX");
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [optimisticallyRemovedUids, setOptimisticallyRemovedUids] = useState<Set<number>>(
    new Set(),
  );
  const [handoffDialogOpen, setHandoffDialogOpen] = useState(false);
  const [handoffAgentId, setHandoffAgentId] = useState<string | null>(null);
  const [handoffMessage, setHandoffMessage] = useState<ParsedEmailMessage | null>(null);
  // Per-row move dropdown: tracks which uid's dropdown is open
  const [moveDropdownUid, setMoveDropdownUid] = useState<number | null>(null);
  const [actionToast, setActionToast] = useState<{ text: string; issueId?: string } | null>(null);
  // Reply panel state
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replyAll, setReplyAll] = useState(false);
  // Compose dialog state
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Mailbox list ──────────────────────────────────────────────────────────

  const { data: mailboxData, isLoading: mailboxesLoading } = useQuery({
    queryKey: ["email", pluginId, selectedCompanyId, "mailboxes"],
    queryFn: () => emailApi!.listMailboxes(),
    enabled: !!emailApi,
  });

  const mailboxes = mailboxData?.mailboxes ?? [];

  useEffect(() => {
    if (mailboxes.length > 0 && !selectedMailbox) {
      setSelectedMailbox(mailboxes[0]!.key);
      setSelectedFolder(mailboxes[0]!.pollFolder || "INBOX");
    }
  }, [mailboxes, selectedMailbox]);

  const selectedMailboxInfo = mailboxes.find((m) => m.key === selectedMailbox) ?? null;

  // ── Folder list ───────────────────────────────────────────────────────────

  const { data: folderData } = useQuery({
    queryKey: ["email", pluginId, selectedCompanyId, selectedMailbox, "folders"],
    queryFn: () => emailApi!.listFolders(selectedMailbox!),
    enabled: !!emailApi && !!selectedMailbox,
    staleTime: 5 * 60_000,
  });

  const folders = folderData?.folders ?? [];

  // ── Message list ──────────────────────────────────────────────────────────

  const messageListKey = [
    "email",
    pluginId,
    selectedCompanyId,
    selectedMailbox,
    selectedFolder,
    showAllMessages ? "all" : "unseen",
  ];

  const {
    data: messagesData,
    isLoading: messagesLoading,
    error: messagesError,
  } = useQuery({
    queryKey: messageListKey,
    queryFn: () =>
      emailApi!.listMessages(selectedMailbox!, {
        folder: selectedFolder,
        unseen: !showAllMessages,
        limit: 50,
      }),
    enabled: !!emailApi && !!selectedMailbox,
    refetchInterval: 30_000,
  });

  const allMessages = messagesData?.messages ?? [];
  const messages = allMessages.filter((m) => !optimisticallyRemovedUids.has(m.uid));

  useEffect(() => {
    setSelectedUid(null);
    setOptimisticallyRemovedUids(new Set());
    setReplyOpen(false);
  }, [selectedMailbox, selectedFolder]);

  // ── Sender rules (used to highlight per-row action icons) ─────────────────

  const { data: rulesData } = useQuery({
    queryKey: ["email", pluginId, selectedCompanyId, selectedMailbox, "rules"],
    queryFn: () => emailApi!.listRules(selectedMailbox!),
    enabled: !!emailApi && !!selectedMailbox,
    staleTime: 60_000,
  });

  const { autoTriageSet, keepAlwaysSet } = useMemo(() => {
    const auto = new Set<string>();
    const keep = new Set<string>();
    for (const r of rulesData?.rules ?? []) {
      const p = r.senderPattern.toLowerCase();
      if (r.ruleType === "auto-triage") auto.add(p);
      else if (r.ruleType === "keep-always") keep.add(p);
    }
    return { autoTriageSet: auto, keepAlwaysSet: keep };
  }, [rulesData]);

  function senderMatchesPattern(msg: MailHeader, patterns: Set<string>): boolean {
    if (patterns.size === 0) return false;
    const sender = extractSender(msg).toLowerCase();
    if (patterns.has(sender)) return true;
    const at = sender.indexOf("@");
    if (at >= 0) {
      const domain = `@${sender.slice(at + 1)}`;
      if (patterns.has(domain)) return true;
    }
    return false;
  }

  function invalidateRules() {
    queryClient.invalidateQueries({
      queryKey: ["email", pluginId, selectedCompanyId, selectedMailbox, "rules"],
    });
  }

  // ── Full message body ─────────────────────────────────────────────────────

  const { data: fullMessage, isLoading: messageLoading } = useQuery({
    queryKey: ["email", pluginId, selectedCompanyId, selectedMailbox, selectedFolder, selectedUid],
    queryFn: () => emailApi!.fetchMessage(selectedMailbox!, selectedUid!, selectedFolder),
    enabled: !!emailApi && !!selectedMailbox && selectedUid !== null,
  });

  // ── Rules home issue ──────────────────────────────────────────────────────

  const { data: rulesBundle } = useQuery<RulesBundle | null>({
    queryKey: ["email", "rulesHome", selectedCompanyId, selectedMailbox],
    enabled: !!selectedCompanyId && !!selectedMailbox,
    queryFn: async () => {
      const titlePrefix = `${RULES_HOME_TITLE_PREFIX}${selectedMailbox}`;
      const issues = await issuesApi.list(selectedCompanyId!, { q: titlePrefix, limit: 5 });
      const match = issues.find((i) => i.title.startsWith(RULES_HOME_TITLE_PREFIX));
      if (!match) return null;
      try {
        const doc: IssueDocument = await issuesApi.getDocument(match.id, RULES_HOME_DOC_KEY);
        return {
          issueId: match.id,
          title: match.title,
          body: doc?.body ?? "",
          latestRevisionId: doc?.latestRevisionId ?? null,
        };
      } catch {
        return null;
      }
    },
  });

  // ── Agents list ───────────────────────────────────────────────────────────

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && handoffDialogOpen,
  });

  const activeAgents = (agents ?? []).filter((a) => a.status !== "terminated");

  // ── Helpers ───────────────────────────────────────────────────────────────

  function showToast(text: string, issueId?: string) {
    setActionToast({ text, issueId });
    setTimeout(() => setActionToast(null), 4000);
  }

  function optimisticallyRemove(uid: number) {
    setOptimisticallyRemovedUids((prev) => new Set([...prev, uid]));
    if (selectedUid === uid) setSelectedUid(null);
  }

  async function applyRulesTransform(
    sender: string,
    transform: (body: string, sender: string) => string,
  ) {
    if (!rulesBundle) return;
    const { issueId, title, body, latestRevisionId } = rulesBundle;
    const submit = async (docBody: string, revId: string | null) => {
      await issuesApi.upsertDocument(issueId, RULES_HOME_DOC_KEY, {
        title,
        format: "markdown",
        body: transform(docBody, sender),
        baseRevisionId: revId ?? undefined,
      });
    };
    try {
      await submit(body, latestRevisionId);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) throw err;
      const fresh: IssueDocument = await issuesApi.getDocument(issueId, RULES_HOME_DOC_KEY);
      await submit(fresh.body ?? "", fresh.latestRevisionId ?? null);
    }
    queryClient.invalidateQueries({
      queryKey: ["email", "rulesHome", selectedCompanyId, selectedMailbox],
    });
  }

  function invalidateMessageList() {
    queryClient.invalidateQueries({ queryKey: messageListKey });
  }

  // ── Triage mutations ──────────────────────────────────────────────────────

  const autoTriageMutation = useMutation({
    mutationFn: async (msg: MailHeader) => {
      optimisticallyRemove(msg.uid);
      await emailApi!.moveMessage(selectedMailbox!, msg.uid, selectedFolder, TRIAGE_FOLDER);
      const sender = extractSender(msg);
      // DB is the source of truth; Markdown doc is dual-written for legacy routines.
      await emailApi!.setRule(selectedMailbox!, sender, "auto-triage");
      await applyRulesTransform(sender, graduateSender);
    },
    onSuccess: (_, msg) => {
      invalidateRules();
      showToast(`Auto-triaged: ${extractSender(msg)}`);
    },
    onError: (_err, msg) => {
      setOptimisticallyRemovedUids((prev) => {
        const next = new Set(prev);
        next.delete(msg.uid);
        return next;
      });
      invalidateMessageList();
    },
  });

  const keepAlwaysMutation = useMutation({
    mutationFn: async (msg: MailHeader) => {
      optimisticallyRemove(msg.uid);
      const sender = extractSender(msg);
      // Records the rule; the email itself stays unread in INBOX so it still
      // shows up as needing action (reply / handoff / move) on next refresh.
      await emailApi!.setRule(selectedMailbox!, sender, "keep-always");
      await applyRulesTransform(sender, keepAlwaysSender);
    },
    onSuccess: (_, msg) => {
      invalidateRules();
      showToast(`Keep always: ${extractSender(msg)}`);
    },
    onError: (_err, msg) => {
      setOptimisticallyRemovedUids((prev) => {
        const next = new Set(prev);
        next.delete(msg.uid);
        return next;
      });
    },
  });

  const markReadMutation = useMutation({
    mutationFn: async (msg: MailHeader) => {
      optimisticallyRemove(msg.uid);
      await emailApi!.markRead(selectedMailbox!, msg.uid, selectedFolder);
    },
    onSuccess: (_, msg) => {
      showToast(`Marked read: ${msg.subject || "(no subject)"}`);
    },
    onError: (_err, msg) => {
      setOptimisticallyRemovedUids((prev) => {
        const next = new Set(prev);
        next.delete(msg.uid);
        return next;
      });
    },
  });

  const moveToFolderMutation = useMutation({
    mutationFn: async ({ msg, targetFolder }: { msg: MailHeader; targetFolder: string }) => {
      optimisticallyRemove(msg.uid);
      await emailApi!.moveMessage(selectedMailbox!, msg.uid, selectedFolder, targetFolder);
    },
    onError: (_err, { msg }) => {
      setOptimisticallyRemovedUids((prev) => {
        const next = new Set(prev);
        next.delete(msg.uid);
        return next;
      });
      invalidateMessageList();
    },
  });

  const handoffMutation = useMutation({
    mutationFn: async ({ msg, agentId }: { msg: ParsedEmailMessage; agentId: string }) => {
      const originId = msg.messageId ? `message-id:${msg.messageId}` : null;
      if (originId) {
        const existing = await issuesApi.list(selectedCompanyId!, {
          originKind: "operator:email-handoff",
          originId,
          limit: 1,
        });
        if (existing.length > 0) {
          return { issueId: existing[0]!.id, alreadyExisted: true, uid: msg.uid };
        }
      }
      const body =
        `${msg.markdown || msg.text || "(no body)"}\n\n---\n` +
        `**From:** ${msg.from}\n` +
        `**Subject:** ${msg.subject}\n` +
        `**Date:** ${msg.date}`;
      const issue = await issuesApi.create(selectedCompanyId!, {
        title: `Email from ${msg.from}: ${msg.subject}`.slice(0, 200),
        body,
        assigneeAgentId: agentId,
        ...(originId ? { originKind: "operator:email-handoff", originId } : {}),
      });
      // Issue tracks it now — mark read so it leaves the unread view.
      try { await emailApi!.markRead(selectedMailbox!, msg.uid, selectedFolder); } catch {}
      return { issueId: issue.id, alreadyExisted: false, uid: msg.uid };
    },
    onSuccess: ({ issueId, uid }) => {
      optimisticallyRemove(uid);
      setHandoffDialogOpen(false);
      showToast("Handed off — issue created", issueId);
    },
  });

  const replyMutation = useMutation({
    mutationFn: async ({ uid, body, rAll }: { uid: number; body: string; rAll: boolean }) => {
      await emailApi!.sendReply(selectedMailbox!, uid, selectedFolder, body, { replyAll: rAll });
      // Replied = taken care of. Mark read so it disappears from the unread view
      // (both here and in Outlook).
      try { await emailApi!.markRead(selectedMailbox!, uid, selectedFolder); } catch {}
    },
    onSuccess: (_, { uid }) => {
      optimisticallyRemove(uid);
      setReplyOpen(false);
      setReplyBody("");
      showToast("Reply sent");
    },
  });

  const composeMutation = useMutation({
    mutationFn: async ({ to, subject, body }: { to: string; subject: string; body: string }) => {
      await emailApi!.sendNew(selectedMailbox!, to, subject, body);
    },
    onSuccess: () => {
      setComposeOpen(false);
      setComposeTo("");
      setComposeSubject("");
      setComposeBody("");
      showToast("Message sent");
    },
  });

  // ── Early exits ───────────────────────────────────────────────────────────

  if (!selectedCompanyId) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Select a company to use Email.
      </div>
    );
  }

  if (pluginLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!pluginId || !hasMailboxForCompany) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-2">
          <Mail className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">Email not configured</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Install the email-tools plugin and add a mailbox with this company in its Allowed
            Companies list.
          </p>
        </div>
      </div>
    );
  }

  const selectedMsg = messages.find((m) => m.uid === selectedUid) ?? null;

  // ── Shared: left pane ─────────────────────────────────────────────────────

  const leftPane = (
    <div className="w-44 shrink-0 border-r border-border flex flex-col bg-sidebar">
      <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Mailboxes
      </div>
      <ScrollArea className="flex-1">
        {mailboxesLoading ? (
          <div className="px-3 py-4 flex items-center gap-2 text-muted-foreground text-xs">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-0.5 px-2 pb-2">
            {mailboxes.map((mb) => (
              <button
                key={mb.key}
                type="button"
                onClick={() => {
                  setSelectedMailbox(mb.key);
                  setSelectedFolder(mb.pollFolder || "INBOX");
                  setSelectedUid(null);
                }}
                className={cn(
                  "w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 hover:bg-accent",
                  selectedMailbox === mb.key && "bg-accent font-medium",
                )}
              >
                <Inbox className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{mb.name || mb.key}</span>
              </button>
            ))}
          </div>
        )}

        {selectedMailbox && folders.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Folders
            </div>
            <div className="space-y-0.5 px-2 pb-2">
              {folders.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => {
                    setSelectedFolder(f);
                    setSelectedUid(null);
                  }}
                  className={cn(
                    "w-full text-left px-2 py-1 rounded text-xs flex items-center gap-2 hover:bg-accent",
                    selectedFolder === f && "bg-accent",
                  )}
                >
                  <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{f}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </ScrollArea>
    </div>
  );

  // ── Shared: message list header ───────────────────────────────────────────

  const listHeader = (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
      <span className="text-sm font-medium truncate">
        {selectedMailboxInfo?.name || selectedMailbox || "Select a mailbox"}
      </span>
      <div className="flex items-center gap-1">
        {selectedUid && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSelectedUid(null)}
            title="Back to list"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setShowAllMessages((v) => !v)}
          title={showAllMessages ? "Showing all — click for unread only" : "Showing unread only — click for all"}
        >
          {showAllMessages ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
        </Button>
        {selectedMailbox && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setComposeOpen(true)}
            title="Compose new message"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );

  // ── Shared: inline row actions ────────────────────────────────────────────

  function RowActions({ msg }: { msg: MailHeader }) {
    const isAutoTriagePending =
      autoTriageMutation.isPending && autoTriageMutation.variables?.uid === msg.uid;
    const isKeepPending =
      keepAlwaysMutation.isPending && keepAlwaysMutation.variables?.uid === msg.uid;
    const isMovePending =
      moveToFolderMutation.isPending && moveToFolderMutation.variables?.msg.uid === msg.uid;
    const isMarkReadPending =
      markReadMutation.isPending && markReadMutation.variables?.uid === msg.uid;
    const hasAutoTriageRule = senderMatchesPattern(msg, autoTriageSet);
    const hasKeepAlwaysRule = senderMatchesPattern(msg, keepAlwaysSet);

    return (
      <div
        className="flex items-center gap-0.5 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          size="icon-sm"
          variant="ghost"
          title="Mark as read"
          disabled={isMarkReadPending}
          onClick={() => markReadMutation.mutate(msg)}
          className="text-muted-foreground hover:text-foreground"
        >
          {isMarkReadPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <MailOpen className="h-3.5 w-3.5" />
          )}
        </Button>

        <Button
          size="icon-sm"
          variant="ghost"
          title={hasAutoTriageRule ? "Auto-triage (rule active for this sender)" : "Auto-triage"}
          disabled={isAutoTriagePending}
          onClick={() => autoTriageMutation.mutate(msg)}
          className={cn(
            hasAutoTriageRule
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {isAutoTriagePending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Archive
              className={cn("h-3.5 w-3.5", hasAutoTriageRule && "fill-current")}
              strokeWidth={hasAutoTriageRule ? 2.5 : 2}
            />
          )}
        </Button>

        <Button
          size="icon-sm"
          variant="ghost"
          title={hasKeepAlwaysRule ? "Keep always (rule active for this sender)" : "Keep always"}
          disabled={isKeepPending}
          onClick={() => keepAlwaysMutation.mutate(msg)}
          className={cn(
            hasKeepAlwaysRule
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {isKeepPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check
              className="h-3.5 w-3.5"
              strokeWidth={hasKeepAlwaysRule ? 3.5 : 2}
            />
          )}
        </Button>

        <DropdownMenu
          open={moveDropdownUid === msg.uid}
          onOpenChange={(open) => setMoveDropdownUid(open ? msg.uid : null)}
        >
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Move to folder"
              disabled={isMovePending}
              className="text-muted-foreground hover:text-foreground"
            >
              {isMovePending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MoveRight className="h-3.5 w-3.5" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto">
            {folders.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">Loading folders…</div>
            ) : (
              folders
                .filter((f) => f !== selectedFolder)
                .map((f) => (
                  <DropdownMenuItem
                    key={f}
                    onSelect={() => {
                      moveToFolderMutation.mutate({ msg, targetFolder: f });
                      setMoveDropdownUid(null);
                    }}
                  >
                    <FolderOpen className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                    {f}
                  </DropdownMenuItem>
                ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  // ── Message list body (shared between both modes) ─────────────────────────

  function MessageListBody({ compact }: { compact: boolean }) {
    if (messagesError) {
      return (
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="text-center space-y-1">
            <AlertCircle className="h-5 w-5 text-destructive mx-auto" />
            <p className="text-xs text-muted-foreground">{(messagesError as Error).message}</p>
          </div>
        </div>
      );
    }
    if (messagesLoading) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      );
    }
    if (messages.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground px-4 text-center">
          {showAllMessages ? "No messages in this folder." : "No unread messages. Toggle the eye to see all."}
        </div>
      );
    }

    return (
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border">
          {messages.map((msg) => (
            <div
              key={msg.uid}
              className={cn(
                "flex items-center gap-2 px-3 hover:bg-accent/50 transition-colors cursor-pointer",
                selectedUid === msg.uid && "bg-accent",
                compact ? "py-2.5" : "py-3",
              )}
              onClick={() => setSelectedUid(msg.uid)}
            >
              {/* Unread indicator */}
              <span
                className={cn(
                  "shrink-0 h-1.5 w-1.5 rounded-full",
                  msg.unseen ? "bg-blue-500" : "bg-transparent",
                )}
              />

              {/* Message info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      "text-xs truncate",
                      msg.unseen && "font-semibold",
                    )}
                  >
                    {msg.from}
                  </span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {timeAgo(new Date(msg.date))}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">{msg.subject}</div>
              </div>

              {/* Per-row action buttons — visible on hover in compact mode, always in expanded */}
              <div
                className={cn(
                  compact
                    ? "opacity-0 group-hover:opacity-100 transition-opacity"
                    : "opacity-100",
                )}
              >
                <RowActions msg={msg} />
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">
      {leftPane}

      {selectedUid ? (
        // ── 3-pane view: narrow list + detail ──────────────────────────────
        <>
          {/* Center: narrow list */}
          <div className="w-72 shrink-0 border-r border-border flex flex-col group">
            {listHeader}
            <MessageListBody compact />
          </div>

          {/* Right: message detail */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {messageLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : !fullMessage ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                Message not found.
              </div>
            ) : (
              <>
                {/* Action bar */}
                <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border flex-wrap">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { if (selectedMsg) markReadMutation.mutate(selectedMsg); }}
                    disabled={markReadMutation.isPending && markReadMutation.variables?.uid === selectedMsg?.uid}
                    title="Mark this message as read"
                  >
                    {markReadMutation.isPending && markReadMutation.variables?.uid === selectedMsg?.uid ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <MailOpen className="h-3.5 w-3.5" />
                    )}
                    Mark read
                  </Button>

                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => { if (selectedMsg) autoTriageMutation.mutate(selectedMsg); }}
                    disabled={autoTriageMutation.isPending && autoTriageMutation.variables?.uid === selectedMsg?.uid}
                    title={
                      selectedMsg && senderMatchesPattern(selectedMsg, autoTriageSet)
                        ? `Rule active — already auto-triages this sender`
                        : `Move to ${TRIAGE_FOLDER} and add sender to auto-triage rules`
                    }
                  >
                    {autoTriageMutation.isPending && autoTriageMutation.variables?.uid === selectedMsg?.uid ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Archive
                        className={cn(
                          "h-3.5 w-3.5",
                          selectedMsg && senderMatchesPattern(selectedMsg, autoTriageSet) && "fill-current",
                        )}
                        strokeWidth={selectedMsg && senderMatchesPattern(selectedMsg, autoTriageSet) ? 2.5 : 2}
                      />
                    )}
                    Auto-triage
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { if (selectedMsg) keepAlwaysMutation.mutate(selectedMsg); }}
                    disabled={keepAlwaysMutation.isPending && keepAlwaysMutation.variables?.uid === selectedMsg?.uid}
                    title={
                      selectedMsg && senderMatchesPattern(selectedMsg, keepAlwaysSet)
                        ? `Rule active — sender is on the keep-always list`
                        : "Add sender to Keep-always rule (no IMAP action)"
                    }
                  >
                    {keepAlwaysMutation.isPending && keepAlwaysMutation.variables?.uid === selectedMsg?.uid ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check
                        className="h-3.5 w-3.5"
                        strokeWidth={selectedMsg && senderMatchesPattern(selectedMsg, keepAlwaysSet) ? 3.5 : 2}
                      />
                    )}
                    Keep always
                  </Button>

                  <DropdownMenu
                    open={moveDropdownUid === selectedUid}
                    onOpenChange={(open) => setMoveDropdownUid(open ? selectedUid : null)}
                  >
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline">
                        <MoveRight className="h-3.5 w-3.5" />
                        Move to…
                        <ChevronRight className="h-3 w-3 ml-0.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
                      {folders.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-muted-foreground">Loading folders…</div>
                      ) : (
                        folders
                          .filter((f) => f !== selectedFolder)
                          .map((f) => (
                            <DropdownMenuItem
                              key={f}
                              onSelect={() => {
                                if (selectedMsg) moveToFolderMutation.mutate({ msg: selectedMsg, targetFolder: f });
                                setMoveDropdownUid(null);
                              }}
                            >
                              <FolderOpen className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                              {f}
                            </DropdownMenuItem>
                          ))
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setHandoffMessage(fullMessage);
                      setHandoffDialogOpen(true);
                    }}
                  >
                    <Bot className="h-3.5 w-3.5" />
                    Hand off…
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setReplyOpen((v) => !v);
                      setReplyBody("");
                      setTimeout(() => replyTextareaRef.current?.focus(), 50);
                    }}
                  >
                    <Reply className="h-3.5 w-3.5" />
                    Reply
                  </Button>
                </div>

                {/* Message header */}
                <div className="shrink-0 px-4 py-3 border-b border-border space-y-0.5">
                  <div className="font-medium text-sm">{fullMessage.subject}</div>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{fullMessage.from}</span>
                    {fullMessage.to.length > 0 && <span> → {fullMessage.to.join(", ")}</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(fullMessage.date).toLocaleString()}
                  </div>
                </div>

                {/* Message body */}
                <div className="flex-1 overflow-hidden flex flex-col">
                  {fullMessage.html ? (
                    <iframe
                      key={fullMessage.uid}
                      srcDoc={fullMessage.html}
                      sandbox="allow-same-origin"
                      className="flex-1 w-full border-0 bg-white"
                      title="Email body"
                    />
                  ) : (
                    <ScrollArea className="flex-1 px-4 py-3">
                      <div className="text-sm whitespace-pre-wrap text-foreground leading-relaxed">
                        {fullMessage.text || (
                          <span className="text-muted-foreground italic">(no body)</span>
                        )}
                      </div>
                    </ScrollArea>
                  )}
                  {fullMessage.attachments.length > 0 && (
                    <div className="shrink-0 px-4 py-2 border-t border-border space-y-1">
                      <div className="text-xs font-medium text-muted-foreground">Attachments</div>
                      {fullMessage.attachments.map((a) => (
                        <div
                          key={a.partId}
                          className="text-xs text-muted-foreground flex items-center gap-1.5"
                        >
                          <FolderOpen className="h-3 w-3" />
                          {a.name} ({Math.round(a.size / 1024)}KB)
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Inline reply panel */}
                {replyOpen && (
                  <div className="shrink-0 border-t border-border p-3 space-y-2 bg-background">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">
                        Reply to {fullMessage.from}
                      </span>
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
                          <input
                            type="checkbox"
                            checked={replyAll}
                            onChange={(e) => setReplyAll(e.target.checked)}
                            className="h-3 w-3"
                          />
                          Reply all
                        </label>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => setReplyOpen(false)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      ref={replyTextareaRef}
                      value={replyBody}
                      onChange={(e) => setReplyBody(e.target.value)}
                      placeholder="Write your reply…"
                      className="min-h-[100px] text-sm resize-none"
                    />
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        disabled={!replyBody.trim() || replyMutation.isPending}
                        onClick={() => {
                          if (selectedUid && replyBody.trim()) {
                            replyMutation.mutate({ uid: selectedUid, body: replyBody.trim(), rAll: replyAll });
                          }
                        }}
                      >
                        {replyMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="h-3.5 w-3.5" />
                        )}
                        Send
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      ) : (
        // ── 2-pane view: expanded list with per-row actions ─────────────────
        <div className="flex-1 min-w-0 flex flex-col">
          {listHeader}
          <MessageListBody compact={false} />
        </div>
      )}

      {/* ── Toast ──────────────────────────────────────────────────────────── */}
      {actionToast && (
        <div className="fixed bottom-4 right-4 z-50 bg-foreground text-background text-sm px-4 py-2 rounded shadow-lg flex items-center gap-2">
          <Check className="h-4 w-4" />
          {actionToast.text}
        </div>
      )}

      {/* ── Compose dialog ───────────────────────────────────────────────── */}
      <Dialog open={composeOpen} onOpenChange={setComposeOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New message</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">To</label>
              <Input
                value={composeTo}
                onChange={(e) => setComposeTo(e.target.value)}
                placeholder="recipient@example.com"
                className="text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Subject</label>
              <Input
                value={composeSubject}
                onChange={(e) => setComposeSubject(e.target.value)}
                placeholder="Subject"
                className="text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Message</label>
              <Textarea
                value={composeBody}
                onChange={(e) => setComposeBody(e.target.value)}
                placeholder="Write your message…"
                className="min-h-[160px] text-sm resize-none"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setComposeOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!composeTo.trim() || !composeSubject.trim() || !composeBody.trim() || composeMutation.isPending}
              onClick={() => {
                if (composeTo.trim() && composeSubject.trim() && composeBody.trim()) {
                  composeMutation.mutate({ to: composeTo.trim(), subject: composeSubject.trim(), body: composeBody.trim() });
                }
              }}
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

      {/* ── Hand off to agent dialog ──────────────────────────────────────── */}
      <Dialog open={handoffDialogOpen} onOpenChange={setHandoffDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Hand off to agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              A Paperclip issue will be created with this email as context and assigned to the
              selected agent.
            </p>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {activeAgents.length === 0 ? (
                <div className="text-sm text-muted-foreground px-2">No agents found.</div>
              ) : (
                activeAgents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => setHandoffAgentId(agent.id)}
                    className={cn(
                      "w-full text-left px-3 py-2 rounded text-sm flex items-center gap-2 hover:bg-accent",
                      handoffAgentId === agent.id && "bg-accent font-medium",
                    )}
                  >
                    <UserCheck className="h-4 w-4 text-muted-foreground shrink-0" />
                    {agent.name}
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setHandoffDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!handoffAgentId || handoffMutation.isPending}
              onClick={() => {
                if (handoffMessage && handoffAgentId) {
                  handoffMutation.mutate({ msg: handoffMessage, agentId: handoffAgentId });
                }
              }}
            >
              {handoffMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Bot className="h-4 w-4" />
              )}
              Hand off
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Utility ───────────────────────────────────────────────────────────────────

function extractSender(msg: MailHeader): string {
  const addrMatch = msg.from.match(/<([^>]+)>/);
  return addrMatch ? addrMatch[1]! : msg.from;
}
