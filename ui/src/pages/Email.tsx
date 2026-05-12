import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
  Trash2,
  Users,
  AlignLeft,
  RefreshCw,
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
import { dismissReviewSender } from "../lib/email-triage-rules";
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

  const [searchParams] = useSearchParams();
  const initialUrlState = useRef({
    mailbox: searchParams.get("mailbox"),
    folder: searchParams.get("folder"),
    uid: (() => {
      const u = searchParams.get("uid");
      const n = u ? parseInt(u, 10) : NaN;
      return Number.isFinite(n) ? n : null;
    })(),
    all: searchParams.get("all") === "1",
  }).current;
  const [selectedMailbox, setSelectedMailbox] = useState<string | null>(initialUrlState.mailbox);
  const [selectedFolder, setSelectedFolder] = useState<string>(initialUrlState.folder || "INBOX");
  const [selectedUid, setSelectedUid] = useState<number | null>(initialUrlState.uid);
  const [showAllMessages, setShowAllMessages] = useState(initialUrlState.all || !!initialUrlState.uid);
  const [optimisticallyRemovedUids, setOptimisticallyRemovedUids] = useState<Set<number>>(
    new Set(),
  );
  const [handoffDialogOpen, setHandoffDialogOpen] = useState(false);
  const [handoffAgentId, setHandoffAgentId] = useState<string | null>(null);
  const [handoffMessage, setHandoffMessage] = useState<ParsedEmailMessage | null>(null);
  const [handoffNote, setHandoffNote] = useState("");
  // Per-row move dropdown: tracks which uid's dropdown is open
  const [moveDropdownUid, setMoveDropdownUid] = useState<number | null>(null);
  const [actionToast, setActionToast] = useState<{ text: string; issueId?: string } | null>(null);
  const [groupBySender, setGroupBySender] = useState(() => {
    try { return localStorage.getItem("email-groupBySender") === "true"; } catch { return false; }
  });
  const toggleGroupBySender = (v: boolean) => {
    try { localStorage.setItem("email-groupBySender", String(v)); } catch {}
    setGroupBySender(v);
  };
  const [leftPaneWidth, setLeftPaneWidth] = useState(() => {
    try { return parseInt(localStorage.getItem("email-leftPaneWidth") || "176", 10); } catch { return 176; }
  });
  const leftPaneDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const startLeftPaneDrag = (e: React.MouseEvent) => {
    leftPaneDragRef.current = { startX: e.clientX, startWidth: leftPaneWidth };
    const onMove = (ev: MouseEvent) => {
      if (!leftPaneDragRef.current) return;
      const next = Math.max(120, Math.min(400, leftPaneDragRef.current.startWidth + ev.clientX - leftPaneDragRef.current.startX));
      setLeftPaneWidth(next);
    };
    let lastWidth = leftPaneWidth;
    const onMove2 = (ev: MouseEvent) => {
      if (!leftPaneDragRef.current) return;
      lastWidth = Math.max(120, Math.min(400, leftPaneDragRef.current.startWidth + ev.clientX - leftPaneDragRef.current.startX));
    };
    window.addEventListener("mousemove", onMove2);
    const onUp = () => {
      leftPaneDragRef.current = null;
      try { localStorage.setItem("email-leftPaneWidth", String(lastWidth)); } catch {}
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousemove", onMove2);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
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

  const { data: folderData, refetch: refetchFolders, isFetching: foldersFetching } = useQuery({
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

  const skipNextResetRef = useRef(initialUrlState.uid !== null);
  useEffect(() => {
    if (skipNextResetRef.current) {
      skipNextResetRef.current = false;
      return;
    }
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

  // Mark-read / Reply / Hand-off all imply "this sender matters" — if they
  // didn't, the operator would have auto-triaged. Auto-add a keep-always
  // rule, but only when the sender isn't already classified (don't flip
  // an existing auto-triage rule into keep-always).
  async function maybeAddImplicitKeepAlways(msg: MailHeader): Promise<void> {
    if (!emailApi || !selectedMailbox) return;
    if (
      senderMatchesPattern(msg, autoTriageSet) ||
      senderMatchesPattern(msg, keepAlwaysSet)
    ) {
      return;
    }
    const sender = extractSender(msg);
    try {
      await emailApi.setRule(selectedMailbox, sender, "keep-always");
    } catch {
      // Best-effort — don't block the primary action on rule write.
    }
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
      // DB is the source of truth; setRule also sweeps unread INBOX for any
      // existing mail matching the new rule (plugin v0.13.0+).
      const ruleResult = await emailApi!.setRule(selectedMailbox!, sender, "auto-triage");
      await applyRulesTransform(sender, dismissReviewSender);
      return { sender, sweptCount: ruleResult.sweptCount ?? 0 };
    },
    onSuccess: ({ sender, sweptCount }) => {
      invalidateRules();
      invalidateMessageList();
      const tail = sweptCount > 0 ? ` (+ ${sweptCount} existing)` : "";
      showToast(`Auto-triaged: ${sender}${tail}`);
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
      const sender = extractSender(msg);
      await emailApi!.setRule(selectedMailbox!, sender, "keep-always");
      await applyRulesTransform(sender, dismissReviewSender);
    },
    onSuccess: (_, msg) => {
      invalidateRules();
      showToast(`Keep always: ${extractSender(msg)}`);
    },
  });

  const markReadMutation = useMutation({
    mutationFn: async (msg: MailHeader) => {
      optimisticallyRemove(msg.uid);
      await emailApi!.markRead(selectedMailbox!, msg.uid, selectedFolder);
      await maybeAddImplicitKeepAlways(msg);
    },
    onSuccess: (_, msg) => {
      invalidateRules();
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

  const markUnreadMutation = useMutation({
    mutationFn: async (msg: MailHeader) => {
      await emailApi!.markUnread(selectedMailbox!, msg.uid, selectedFolder);
    },
    onSuccess: (_, msg) => {
      invalidateMessageList();
      showToast(`Marked unread: ${msg.subject || "(no subject)"}`);
    },
    onError: (_err, msg) => {
      setOptimisticallyRemovedUids((prev) => {
        const next = new Set(prev);
        next.delete(msg.uid);
        return next;
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (msg: MailHeader) => {
      optimisticallyRemove(msg.uid);
      const result = await emailApi!.deleteMessage(selectedMailbox!, msg.uid, selectedFolder);
      return result;
    },
    onSuccess: () => {
      showToast("Deleted");
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
    mutationFn: async ({
      msg,
      agentId,
      note,
    }: {
      msg: ParsedEmailMessage;
      agentId: string;
      note: string;
    }) => {
      const trimmedNote = note.trim();
      const noteBlock = trimmedNote
        ? `## Operator note\n\n${trimmedNote}\n\n---\n\n`
        : "";
      const description =
        `${noteBlock}${msg.markdown || msg.text || "(no body)"}\n\n---\n` +
        `**From:** ${msg.from}\n` +
        `**Subject:** ${msg.subject}\n` +
        `**Date:** ${msg.date}`;
      const issue = await issuesApi.create(selectedCompanyId!, {
        title: `Email from ${msg.from}: ${msg.subject}`.slice(0, 200),
        description,
        assigneeAgentId: agentId,
      });
      // Wake the agent so it actually picks the issue up. Creating the issue
      // alone just assigns it — the agent won't run until its next scheduled
      // tick (or never, if it isn't on a routine). source: "assignment" tells
      // the agent it should look at its inbox for new work.
      try {
        await agentsApi.wakeup(
          agentId,
          {
            source: "assignment",
            triggerDetail: "manual",
            reason: "operator_email_handoff",
            payload: { issueId: issue.id },
            idempotencyKey: `email-handoff:${issue.id}`,
          },
          selectedCompanyId!,
        );
      } catch (err) {
        // Issue exists; agent didn't wake. Surface but don't fail the handoff.
        console.error("Failed to wake agent after handoff", err);
      }
      // Issue tracks it now — mark read so it leaves the unread view.
      try { await emailApi!.markRead(selectedMailbox!, msg.uid, selectedFolder); } catch {}
      // Hand off implies the sender matters enough to involve an agent —
      // promote to keep-always so future mail from them isn't auto-triaged.
      const header = messages.find((m) => m.uid === msg.uid);
      if (header) await maybeAddImplicitKeepAlways(header);
      return { issueId: issue.id, uid: msg.uid };
    },
    onSuccess: ({ issueId, uid }) => {
      optimisticallyRemove(uid);
      invalidateRules();
      setHandoffDialogOpen(false);
      setHandoffNote("");
      setHandoffAgentId(null);
      showToast("Handed off — issue created", issueId);
    },
  });

  const replyMutation = useMutation({
    mutationFn: async ({ uid, body, rAll }: { uid: number; body: string; rAll: boolean }) => {
      await emailApi!.sendReply(selectedMailbox!, uid, selectedFolder, body, { replyAll: rAll });
      // Replied = taken care of. Mark read so it disappears from the unread view
      // (both here and in Outlook).
      try { await emailApi!.markRead(selectedMailbox!, uid, selectedFolder); } catch {}
      const msg = messages.find((m) => m.uid === uid);
      if (msg) await maybeAddImplicitKeepAlways(msg);
    },
    onSuccess: (_, { uid }) => {
      optimisticallyRemove(uid);
      invalidateRules();
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

  // ── Mailbox name helpers ──────────────────────────────────────────────────
  // Name format: "Display Name - email@domain.com"
  const mailboxEmail = (mb: { name: string; key: string }) => {
    const m = mb.name?.match(/\S+@\S+/);
    return m ? m[0] : mb.key;
  };
  const mailboxLabel = (mb: { name: string; key: string }) => {
    const m = mb.name?.match(/^(.+?)\s+-\s+\S+@\S+$/);
    return m ? m[1] : mb.name || mb.key;
  };

  // ── Shared: left pane ─────────────────────────────────────────────────────

  const leftPane = (
    <div className="shrink-0 border-r border-border flex flex-col bg-sidebar" style={{ width: leftPaneWidth }}>
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
                <span className="truncate">{mailboxEmail(mb)}</span>
              </button>
            ))}
          </div>
        )}

        {selectedMailbox && folders.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center justify-between">
              Folders
              <button
                type="button"
                onClick={() => refetchFolders()}
                disabled={foldersFetching}
                className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                title="Refresh folder list"
              >
                <RefreshCw className={cn("h-3 w-3", foldersFetching && "animate-spin")} />
              </button>
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
        {selectedMailboxInfo ? mailboxLabel(selectedMailboxInfo) : selectedMailbox || "Select a mailbox"}
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
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => toggleGroupBySender(!groupBySender)}
          title={groupBySender ? "Group by sender — click to flatten" : "Flat list — click to group by sender"}
        >
          {groupBySender ? (
            <Users className="h-3.5 w-3.5" />
          ) : (
            <AlignLeft className="h-3.5 w-3.5" />
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
    const isDeletePending =
      deleteMutation.isPending && deleteMutation.variables?.uid === msg.uid;
    const isMarkReadPending =
      markReadMutation.isPending && markReadMutation.variables?.uid === msg.uid;
    const isMarkUnreadPending =
      markUnreadMutation.isPending && markUnreadMutation.variables?.uid === msg.uid;
    const hasAutoTriageRule = senderMatchesPattern(msg, autoTriageSet);
    const hasKeepAlwaysRule = senderMatchesPattern(msg, keepAlwaysSet);

    return (
      <div
        className="flex items-center gap-0.5 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        {msg.unseen ? (
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
        ) : (
          <Button
            size="icon-sm"
            variant="ghost"
            title="Mark as unread"
            disabled={isMarkUnreadPending}
            onClick={() => markUnreadMutation.mutate(msg)}
            className="text-muted-foreground hover:text-foreground"
          >
            {isMarkUnreadPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Mail className="h-3.5 w-3.5" />
            )}
          </Button>
        )}

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

        <Button
          size="icon-sm"
          variant="ghost"
          title="Delete (move to Trash)"
          disabled={isDeletePending}
          onClick={() => deleteMutation.mutate(msg)}
          className="text-muted-foreground hover:text-destructive"
        >
          {isDeletePending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
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

  function renderRow(msg: MailHeader, compact: boolean) {
    return (
      <div
        key={msg.uid}
        className={cn(
          "flex items-center gap-2 px-3 hover:bg-accent/50 transition-colors cursor-pointer",
          selectedUid === msg.uid && "bg-accent",
          compact ? "py-2.5" : "py-3",
        )}
        onClick={() => setSelectedUid(msg.uid)}
      >
        <span
          className={cn(
            "shrink-0 h-1.5 w-1.5 rounded-full",
            msg.unseen ? "bg-blue-500" : "bg-transparent",
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn("text-xs truncate", msg.unseen && "font-semibold")}>
              {msg.from}
            </span>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {timeAgo(new Date(msg.date))}
            </span>
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">{msg.subject}</div>
        </div>
        <div
          className={cn(
            compact ? "opacity-0 group-hover:opacity-100 transition-opacity" : "opacity-100",
          )}
        >
          <RowActions msg={msg} />
        </div>
      </div>
    );
  }

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

    if (!groupBySender) {
      return (
        <ScrollArea className="flex-1">
          <div className="divide-y divide-border">
            {messages.map((msg) => renderRow(msg, compact))}
          </div>
        </ScrollArea>
      );
    }

    // Group by canonical sender email address. Within each group sort by
    // date desc (newest first), and sort groups by their newest message.
    const groupsMap = new Map<string, MailHeader[]>();
    for (const msg of messages) {
      const sender = extractSender(msg);
      const existing = groupsMap.get(sender);
      if (existing) existing.push(msg);
      else groupsMap.set(sender, [msg]);
    }
    const groups = Array.from(groupsMap.entries())
      .map(([sender, msgs]) => ({
        sender,
        msgs: msgs.slice().sort((a, b) => (b.date < a.date ? -1 : 1)),
        latestDate: msgs.reduce((max, m) => (m.date > max ? m.date : max), msgs[0]!.date),
      }))
      .sort((a, b) => (b.latestDate < a.latestDate ? -1 : 1));

    return (
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border">
          {groups.map((g) => {
            const senderHasAutoTriage = autoTriageSet.has(g.sender.toLowerCase()) ||
              (g.sender.includes("@") && autoTriageSet.has(`@${g.sender.split("@")[1]!.toLowerCase()}`));
            return (
              <div key={g.sender} className="divide-y divide-border/60">
                <div
                  className="flex items-center gap-2 px-3 py-2 bg-muted/40 sticky top-0 z-10"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-semibold truncate">{g.sender}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {g.msgs.length} {g.msgs.length === 1 ? "message" : "messages"}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title={senderHasAutoTriage ? "Auto-triage all (rule already exists)" : "Auto-triage all from this sender"}
                      onClick={() => {
                        // setRule + sweep does all the work in one shot via v0.13.0.
                        // Use the first (newest) message in the group as the "subject"
                        // — autoTriageMutation moves it + writes the rule + sweeps the rest.
                        if (g.msgs.length > 0) autoTriageMutation.mutate(g.msgs[0]!);
                      }}
                      className={cn(
                        senderHasAutoTriage ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Archive
                        className={cn("h-3.5 w-3.5", senderHasAutoTriage && "fill-current")}
                        strokeWidth={senderHasAutoTriage ? 2.5 : 2}
                      />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Delete all from this sender"
                      onClick={() => {
                        for (const m of g.msgs) deleteMutation.mutate(m);
                      }}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {g.msgs.map((msg) => renderRow(msg, compact))}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">
      {leftPane}

      {/* Drag handle for left pane */}
      <div
        className="w-1 shrink-0 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
        onMouseDown={startLeftPaneDrag}
      />

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
                  {selectedMsg?.unseen ? (
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
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { if (selectedMsg) markUnreadMutation.mutate(selectedMsg); }}
                      disabled={markUnreadMutation.isPending && markUnreadMutation.variables?.uid === selectedMsg?.uid}
                      title="Mark this message as unread (brings it back into the unread view)"
                    >
                      {markUnreadMutation.isPending && markUnreadMutation.variables?.uid === selectedMsg?.uid ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Mail className="h-3.5 w-3.5" />
                      )}
                      Mark unread
                    </Button>
                  )}

                  <Button
                    size="sm"
                    variant="outline"
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

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { if (selectedMsg) deleteMutation.mutate(selectedMsg); }}
                    disabled={deleteMutation.isPending && deleteMutation.variables?.uid === selectedMsg?.uid}
                    title="Delete (move to Trash)"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    {deleteMutation.isPending && deleteMutation.variables?.uid === selectedMsg?.uid ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    Delete
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
      <Dialog
        open={handoffDialogOpen}
        onOpenChange={(open) => {
          setHandoffDialogOpen(open);
          if (!open) {
            setHandoffNote("");
            setHandoffAgentId(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Hand off to agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              A Paperclip issue will be created with this email as context and assigned to the
              selected agent.
            </p>
            <div className="space-y-1 max-h-48 overflow-y-auto">
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
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground block">
                Note for agent (optional)
              </label>
              <Textarea
                value={handoffNote}
                onChange={(e) => setHandoffNote(e.target.value)}
                placeholder="Optional context for the agent — who the email is for, what to do, etc."
                className="min-h-[80px] text-sm resize-none"
              />
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
                  handoffMutation.mutate({
                    msg: handoffMessage,
                    agentId: handoffAgentId,
                    note: handoffNote,
                  });
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
