import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
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
  Forward,
  Send,
  Pencil,
  Trash2,
  Users,
  AlignLeft,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useEmailToolsPlugin } from "../hooks/useEmailToolsPlugin";
import { makeEmailToolsApi, type MailHeader, type ParsedEmailMessage } from "../api/emailTools";
import { emailDraftsApi } from "../api/emailDrafts";
import { chatApi } from "../api/chat";
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

// Draft persistence — keep operator's typed text across page refreshes and
// component remounts. Same pattern used by CommentThread / IssueChatThread.
const DRAFT_DEBOUNCE_MS = 800;
const COMPOSE_TO_KEY = "email-draft-compose-to";
const COMPOSE_SUBJECT_KEY = "email-draft-compose-subject";
const COMPOSE_BODY_KEY = "email-draft-compose-body";

function replyDraftKey(mailbox: string, uid: number): string {
  return `email-draft-reply:${mailbox}:${uid}`;
}
function forwardDraftKey(mailbox: string, uid: number): string {
  return `email-draft-forward:${mailbox}:${uid}`;
}

function loadDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(key: string, value: string): void {
  try {
    if (value.trim()) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Ignore localStorage failures.
  }
}

function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore localStorage failures.
  }
}

// Self-contained textarea / input that owns its draft state internally. The
// parent only re-renders when content crosses the empty/non-empty boundary
// (for Send-button disabled state). Without this isolation, every keystroke
// re-renders the entire Email page — including the inline MessageListBody
// and ~50 row entries — which produces visible typing lag.
interface DraftFieldHandle {
  getValue: () => string;
  setValue: (v: string) => void;
  focus: () => void;
}

interface DraftTextareaProps {
  initialValue?: string;
  draftKey?: string | null;
  placeholder?: string;
  className?: string;
  onContentChange?: (hasContent: boolean) => void;
}

const DraftTextarea = forwardRef<DraftFieldHandle, DraftTextareaProps>(
  function DraftTextarea(
    { initialValue = "", draftKey = null, placeholder, className, onContentChange },
    ref,
  ) {
    const [value, setValue] = useState(initialValue);
    const taRef = useRef<HTMLTextAreaElement>(null);
    const hadContentRef = useRef(initialValue.trim().length > 0);
    const onContentChangeRef = useRef(onContentChange);
    onContentChangeRef.current = onContentChange;

    function reportContent(v: string) {
      const has = v.trim().length > 0;
      if (has !== hadContentRef.current) {
        hadContentRef.current = has;
        onContentChangeRef.current?.(has);
      }
    }

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => value,
        setValue: (v: string) => {
          setValue(v);
          reportContent(v);
        },
        focus: () => taRef.current?.focus(),
      }),
      [value],
    );

    useEffect(() => {
      if (!draftKey) return;
      const t = setTimeout(() => saveDraft(draftKey, value), DRAFT_DEBOUNCE_MS);
      return () => clearTimeout(t);
    }, [value, draftKey]);

    return (
      <Textarea
        ref={taRef}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          reportContent(v);
        }}
        placeholder={placeholder}
        className={className}
      />
    );
  },
);

interface DraftInputProps {
  initialValue?: string;
  draftKey?: string | null;
  placeholder?: string;
  className?: string;
  onContentChange?: (hasContent: boolean) => void;
}

const DraftInput = forwardRef<DraftFieldHandle, DraftInputProps>(
  function DraftInput(
    { initialValue = "", draftKey = null, placeholder, className, onContentChange },
    ref,
  ) {
    const [value, setValue] = useState(initialValue);
    const inputRef = useRef<HTMLInputElement>(null);
    const hadContentRef = useRef(initialValue.trim().length > 0);
    const onContentChangeRef = useRef(onContentChange);
    onContentChangeRef.current = onContentChange;

    function reportContent(v: string) {
      const has = v.trim().length > 0;
      if (has !== hadContentRef.current) {
        hadContentRef.current = has;
        onContentChangeRef.current?.(has);
      }
    }

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => value,
        setValue: (v: string) => {
          setValue(v);
          reportContent(v);
        },
        focus: () => inputRef.current?.focus(),
      }),
      [value],
    );

    useEffect(() => {
      if (!draftKey) return;
      const t = setTimeout(() => saveDraft(draftKey, value), DRAFT_DEBOUNCE_MS);
      return () => clearTimeout(t);
    }, [value, draftKey]);

    return (
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          reportContent(v);
        }}
        placeholder={placeholder}
        className={className}
      />
    );
  },
);

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
    action: (() => {
      const a = searchParams.get("action");
      return a === "reply" || a === "forward" || a === "handoff" ? a : null;
    })() as "reply" | "forward" | "handoff" | null,
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
  // Row-click handlers for reply/forward/handoff need fullMessage. They set
  // selectedUid (triggering fetch) and arm a pending action that fires from a
  // useEffect once fullMessage matches. Also fed by ?action= URL param so
  // navigations from Portfolio Email land with the action pre-armed.
  const [pendingRowAction, setPendingRowAction] = useState<
    { uid: number; action: "reply" | "forward" | "handoff" } | null
  >(() => {
    if (initialUrlState.uid !== null && initialUrlState.action) {
      return { uid: initialUrlState.uid, action: initialUrlState.action };
    }
    return null;
  });
  // Per-row move dropdown: tracks which uid's dropdown is open
  const [moveDropdownUid, setMoveDropdownUid] = useState<number | null>(null);
  const [moveDropdownSender, setMoveDropdownSender] = useState<string | null>(null);
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
  // Reply panel state. The textarea content lives inside DraftTextarea so
  // typing doesn't re-render this entire (huge) component on every keystroke.
  // The parent only tracks whether the body has content (for the Send-button
  // disabled state) and reads the live value via the imperative ref.
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyAll, setReplyAll] = useState(false);
  const [replyHasContent, setReplyHasContent] = useState(false);
  const replyComposerRef = useRef<DraftFieldHandle>(null);
  // AI Draft model — empty string = let server auto-pick. Persisted so the
  // operator doesn't have to re-pick on every reply.
  const [draftModel, setDraftModel] = useState<string>(() => {
    try { return localStorage.getItem("email-draftModel") ?? ""; } catch { return ""; }
  });
  const updateDraftModel = (m: string) => {
    setDraftModel(m);
    try { localStorage.setItem("email-draftModel", m); } catch {}
  };
  // Compose dialog state. Same isolation pattern as reply — field contents
  // live inside DraftInput / DraftTextarea; the parent only tracks the
  // has-content flags and the initial values to seed each field on mount.
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInitial, setComposeInitial] = useState<{ to: string; subject: string; body: string }>(
    { to: "", subject: "", body: "" },
  );
  const [composeToHasContent, setComposeToHasContent] = useState(false);
  const [composeSubjectHasContent, setComposeSubjectHasContent] = useState(false);
  const [composeBodyHasContent, setComposeBodyHasContent] = useState(false);
  const composeToRef = useRef<DraftFieldHandle>(null);
  const composeSubjectRef = useRef<DraftFieldHandle>(null);
  const composeBodyRef = useRef<DraftFieldHandle>(null);
  // Drives which localStorage keys back the compose dialog's drafts: "new"
  // uses the singleton compose-* keys, "forward" uses per-message forward-*.
  const [composeMode, setComposeMode] = useState<"new" | "forward">("new");
  const [composeSourceUid, setComposeSourceUid] = useState<number | null>(null);

  // ── Available LLM models (for AI Draft picker) ────────────────────────────

  const draftModelsQuery = useQuery({
    queryKey: ["email", "draftModels"],
    queryFn: () => chatApi.listModels().then((r) => r.models),
    staleTime: 5 * 60_000,
  });
  const draftModels = draftModelsQuery.data ?? [];

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
    setPendingRowAction(null);
  }, [selectedMailbox, selectedFolder]);

  // ── Sender rules (used to highlight per-row action icons) ─────────────────

  const { data: rulesData } = useQuery({
    queryKey: ["email", pluginId, selectedCompanyId, selectedMailbox, "rules"],
    queryFn: () => emailApi!.listRules(selectedMailbox!),
    enabled: !!emailApi && !!selectedMailbox,
    staleTime: 60_000,
  });

  const { autoTriageSet, keepAlwaysSet, muteSet } = useMemo(() => {
    const auto = new Set<string>();
    const keep = new Set<string>();
    const mute = new Set<string>();
    for (const r of rulesData?.rules ?? []) {
      const p = r.senderPattern.toLowerCase();
      if (r.ruleType === "auto-triage") auto.add(p);
      else if (r.ruleType === "keep-always") keep.add(p);
      else if (r.ruleType === "mute") mute.add(p);
    }
    return { autoTriageSet: auto, keepAlwaysSet: keep, muteSet: mute };
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
  // an existing auto-triage or mute rule into keep-always — those are
  // deliberate operator choices we must not silently invert).
  async function maybeAddImplicitKeepAlways(msg: MailHeader): Promise<void> {
    if (!emailApi || !selectedMailbox) return;
    if (
      senderMatchesPattern(msg, autoTriageSet) ||
      senderMatchesPattern(msg, keepAlwaysSet) ||
      senderMatchesPattern(msg, muteSet)
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

  // Open helpers — consolidate the multiple entry points (row click, inline
  // detail-pane buttons, pencil "compose new") so each one consistently loads
  // any persisted draft instead of clobbering it. Each helper just pre-seeds
  // the parent state (initial values + has-content flags); the DraftField
  // children read initialValue on mount and own the value state from there.
  function openReplyFor(uid: number) {
    const saved = selectedMailbox ? loadDraft(replyDraftKey(selectedMailbox, uid)) : "";
    setReplyHasContent(saved.trim().length > 0);
    setReplyOpen(true);
    setTimeout(() => replyComposerRef.current?.focus(), 50);
  }

  function openForwardCompose(msg: ParsedEmailMessage) {
    const subj = msg.subject || "";
    const fwdSubj = /^fwd?:\s/i.test(subj) ? subj : `Fwd: ${subj}`;
    const header = [
      "---------- Forwarded message ----------",
      `From: ${msg.from}`,
      `Date: ${new Date(msg.date).toLocaleString()}`,
      `Subject: ${msg.subject}`,
      msg.to.length > 0 ? `To: ${msg.to.join(", ")}` : null,
    ]
      .filter((l): l is string => l !== null)
      .join("\n");
    const fresh = `\n\n${header}\n\n${msg.text || msg.markdown || ""}`;
    const saved = selectedMailbox ? loadDraft(forwardDraftKey(selectedMailbox, msg.uid)) : "";
    const body = saved || fresh;
    setComposeMode("forward");
    setComposeSourceUid(msg.uid);
    setComposeInitial({ to: "", subject: fwdSubj, body });
    setComposeToHasContent(false);
    setComposeSubjectHasContent(fwdSubj.trim().length > 0);
    setComposeBodyHasContent(body.trim().length > 0);
    setComposeOpen(true);
  }

  function openNewCompose() {
    const to = loadDraft(COMPOSE_TO_KEY);
    const subject = loadDraft(COMPOSE_SUBJECT_KEY);
    const body = loadDraft(COMPOSE_BODY_KEY);
    setComposeMode("new");
    setComposeSourceUid(null);
    setComposeInitial({ to, subject, body });
    setComposeToHasContent(to.trim().length > 0);
    setComposeSubjectHasContent(subject.trim().length > 0);
    setComposeBodyHasContent(body.trim().length > 0);
    setComposeOpen(true);
  }

  // Fires reply/forward/handoff dialogs once fullMessage arrives for a row
  // that armed pendingRowAction. Without this the row click would just select
  // the message — the user would then have to click the action button on the
  // detail pane separately.
  useEffect(() => {
    if (!pendingRowAction || !fullMessage || fullMessage.uid !== pendingRowAction.uid) {
      return;
    }
    const action = pendingRowAction.action;
    if (action === "reply") {
      openReplyFor(fullMessage.uid);
    } else if (action === "forward") {
      openForwardCompose(fullMessage);
    } else if (action === "handoff") {
      setHandoffMessage(fullMessage);
      setHandoffDialogOpen(true);
    }
    setPendingRowAction(null);
  }, [fullMessage, pendingRowAction]);

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
      if (selectedMailbox) clearDraft(replyDraftKey(selectedMailbox, uid));
      setReplyOpen(false);
      setReplyHasContent(false);
      showToast("Reply sent");
    },
  });

  // Whatever's in the reply textarea when AI Draft is clicked is treated as
  // optional instructions for the model ("ask about timeline", "decline
  // politely", etc.), not as the body itself — the returned draft replaces
  // the textarea content.
  const draftMutation = useMutation({
    mutationFn: async ({ msg, instructions }: { msg: ParsedEmailMessage; instructions?: string }) =>
      emailDraftsApi.draftReply({
        from: msg.from,
        subject: msg.subject,
        bodyText: msg.markdown || msg.text || "",
        instructions: instructions?.trim() || undefined,
        model: draftModel || undefined,
      }),
    onSuccess: (result) => {
      replyComposerRef.current?.setValue(result.draft);
      setTimeout(() => replyComposerRef.current?.focus(), 50);
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`Draft failed: ${message}`);
    },
  });

  const composeMutation = useMutation({
    mutationFn: async ({ to, subject, body }: { to: string; subject: string; body: string }) => {
      await emailApi!.sendNew(selectedMailbox!, to, subject, body);
    },
    onSuccess: () => {
      if (composeMode === "forward" && selectedMailbox && composeSourceUid !== null) {
        clearDraft(forwardDraftKey(selectedMailbox, composeSourceUid));
      } else {
        clearDraft(COMPOSE_TO_KEY);
        clearDraft(COMPOSE_SUBJECT_KEY);
        clearDraft(COMPOSE_BODY_KEY);
      }
      setComposeOpen(false);
      setComposeToHasContent(false);
      setComposeSubjectHasContent(false);
      setComposeBodyHasContent(false);
      setComposeMode("new");
      setComposeSourceUid(null);
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
            onClick={() => openNewCompose()}
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
          title="Reply"
          onClick={() => {
            setSelectedUid(msg.uid);
            setPendingRowAction({ uid: msg.uid, action: "reply" });
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <Reply className="h-3.5 w-3.5" />
        </Button>

        <Button
          size="icon-sm"
          variant="ghost"
          title="Forward"
          onClick={() => {
            setSelectedUid(msg.uid);
            setPendingRowAction({ uid: msg.uid, action: "forward" });
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <Forward className="h-3.5 w-3.5" />
        </Button>

        <Button
          size="icon-sm"
          variant="ghost"
          title="Hand off to agent"
          onClick={() => {
            setSelectedUid(msg.uid);
            setPendingRowAction({ uid: msg.uid, action: "handoff" });
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <Bot className="h-3.5 w-3.5" />
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
      </div>
    );
  }

  // ── Message list body (shared between both modes) ─────────────────────────

  function renderRow(msg: MailHeader, compact: boolean) {
    return (
      <div
        key={msg.uid}
        className={cn(
          "group flex items-center gap-2 px-3 hover:bg-accent/50 transition-colors cursor-pointer",
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
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
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
        <div className="space-y-3 p-2">
          {groups.map((g) => {
            const senderHasAutoTriage = autoTriageSet.has(g.sender.toLowerCase()) ||
              (g.sender.includes("@") && autoTriageSet.has(`@${g.sender.split("@")[1]!.toLowerCase()}`));
            const senderHasKeepAlways = keepAlwaysSet.has(g.sender.toLowerCase()) ||
              (g.sender.includes("@") && keepAlwaysSet.has(`@${g.sender.split("@")[1]!.toLowerCase()}`));
            return (
              <div
                key={g.sender}
                className="rounded-lg border border-border bg-card shadow-sm overflow-hidden divide-y divide-border/60"
              >
                <div
                  className="flex items-center gap-2 px-3 py-2.5 bg-muted border-b border-border"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-semibold truncate">{g.sender}</span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {g.msgs.length} {g.msgs.length === 1 ? "message" : "messages"}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => { for (const m of g.msgs) markReadMutation.mutate(m); }}
                          aria-label="Mark all read"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <MailOpen className="h-5 w-5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Mark all read</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            if (g.msgs.length > 0) keepAlwaysMutation.mutate(g.msgs[0]!);
                          }}
                          aria-label="Keep always from this sender"
                          className={cn(
                            senderHasKeepAlways ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Check
                            className="h-5 w-5"
                            strokeWidth={senderHasKeepAlways ? 3.5 : 2}
                          />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {senderHasKeepAlways ? "Keep always (rule already exists)" : "Keep always from this sender"}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            if (g.msgs.length > 0) autoTriageMutation.mutate(g.msgs[0]!);
                          }}
                          aria-label="Auto-triage from this sender"
                          className={cn(
                            senderHasAutoTriage ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Archive
                            className={cn("h-5 w-5", senderHasAutoTriage && "fill-current")}
                            strokeWidth={senderHasAutoTriage ? 2.5 : 2}
                          />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {senderHasAutoTriage ? "Auto-triage (rule already exists)" : "Auto-triage all from this sender"}
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenu
                      open={moveDropdownSender === g.sender}
                      onOpenChange={(open) => setMoveDropdownSender(open ? g.sender : null)}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Move all to folder"
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <MoveRight className="h-5 w-5" />
                            </Button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent>Move all to folder</TooltipContent>
                      </Tooltip>
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
                                  for (const m of g.msgs) moveToFolderMutation.mutate({ msg: m, targetFolder: f });
                                  setMoveDropdownSender(null);
                                }}
                              >
                                <FolderOpen className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                                {f}
                              </DropdownMenuItem>
                            ))
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => { for (const m of g.msgs) deleteMutation.mutate(m); }}
                          aria-label="Delete all from this sender"
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-5 w-5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Delete all from this sender</TooltipContent>
                    </Tooltip>
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
                <div className="shrink-0 flex items-center gap-1 px-4 py-2 border-b border-border flex-wrap">
                  {selectedMsg?.unseen ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon-sm"
                          variant="outline"
                          onClick={() => { if (selectedMsg) markReadMutation.mutate(selectedMsg); }}
                          disabled={markReadMutation.isPending && markReadMutation.variables?.uid === selectedMsg?.uid}
                          aria-label="Mark as read"
                        >
                          {markReadMutation.isPending && markReadMutation.variables?.uid === selectedMsg?.uid ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <MailOpen className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Mark as read</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon-sm"
                          variant="outline"
                          onClick={() => { if (selectedMsg) markUnreadMutation.mutate(selectedMsg); }}
                          disabled={markUnreadMutation.isPending && markUnreadMutation.variables?.uid === selectedMsg?.uid}
                          aria-label="Mark as unread"
                        >
                          {markUnreadMutation.isPending && markUnreadMutation.variables?.uid === selectedMsg?.uid ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Mail className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Mark as unread (brings it back to the unread view)</TooltipContent>
                    </Tooltip>
                  )}

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="outline"
                        onClick={() => { if (selectedMsg) keepAlwaysMutation.mutate(selectedMsg); }}
                        disabled={keepAlwaysMutation.isPending && keepAlwaysMutation.variables?.uid === selectedMsg?.uid}
                        aria-label="Keep always"
                      >
                        {keepAlwaysMutation.isPending && keepAlwaysMutation.variables?.uid === selectedMsg?.uid ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check
                            className="h-3.5 w-3.5"
                            strokeWidth={selectedMsg && senderMatchesPattern(selectedMsg, keepAlwaysSet) ? 3.5 : 2}
                          />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {selectedMsg && senderMatchesPattern(selectedMsg, keepAlwaysSet)
                        ? `Keep always — sender is on the keep-always list`
                        : `Keep always — add sender to keep-always rule`}
                    </TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="outline"
                        onClick={() => { if (selectedMsg) autoTriageMutation.mutate(selectedMsg); }}
                        disabled={autoTriageMutation.isPending && autoTriageMutation.variables?.uid === selectedMsg?.uid}
                        aria-label="Auto-triage"
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
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {selectedMsg && senderMatchesPattern(selectedMsg, autoTriageSet)
                        ? `Auto-triage — rule already active for this sender`
                        : `Auto-triage — move to ${TRIAGE_FOLDER} and add sender rule`}
                    </TooltipContent>
                  </Tooltip>

                  <DropdownMenu
                    open={moveDropdownUid === selectedUid}
                    onOpenChange={(open) => setMoveDropdownUid(open ? selectedUid : null)}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon-sm" variant="outline" aria-label="Move to folder">
                            <MoveRight className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent>Move to folder</TooltipContent>
                    </Tooltip>
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

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="outline"
                        onClick={() => { if (selectedMsg) deleteMutation.mutate(selectedMsg); }}
                        disabled={deleteMutation.isPending && deleteMutation.variables?.uid === selectedMsg?.uid}
                        aria-label="Delete"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        {deleteMutation.isPending && deleteMutation.variables?.uid === selectedMsg?.uid ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete (move to Trash)</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="outline"
                        onClick={() => {
                          setHandoffMessage(fullMessage);
                          setHandoffDialogOpen(true);
                        }}
                        aria-label="Hand off to agent"
                      >
                        <Bot className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Hand off to agent</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="outline"
                        onClick={() => {
                          if (!fullMessage) return;
                          openForwardCompose(fullMessage);
                        }}
                        aria-label="Forward"
                      >
                        <Forward className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Forward</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="outline"
                        onClick={() => {
                          if (replyOpen) {
                            setReplyOpen(false);
                          } else if (fullMessage) {
                            openReplyFor(fullMessage.uid);
                          }
                        }}
                        aria-label="Reply"
                      >
                        <Reply className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Reply</TooltipContent>
                  </Tooltip>
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
                      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
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
                    <DraftTextarea
                      key={`reply:${selectedMailbox}:${selectedUid}`}
                      ref={replyComposerRef}
                      initialValue={
                        selectedMailbox && selectedUid !== null
                          ? loadDraft(replyDraftKey(selectedMailbox, selectedUid))
                          : ""
                      }
                      draftKey={
                        selectedMailbox && selectedUid !== null
                          ? replyDraftKey(selectedMailbox, selectedUid)
                          : null
                      }
                      placeholder="Write your reply…"
                      className="min-h-[100px] text-sm resize-none"
                      onContentChange={setReplyHasContent}
                    />
                    <div className="flex items-center justify-end gap-2">
                      <Select
                        value={draftModel || "__auto__"}
                        onValueChange={(v) => updateDraftModel(v === "__auto__" ? "" : v)}
                      >
                        <SelectTrigger
                          size="sm"
                          className="h-8 w-auto max-w-[180px] gap-1 px-2 text-xs"
                          title="Model used for AI Draft"
                        >
                          <SelectValue placeholder="Auto" />
                        </SelectTrigger>
                        <SelectContent align="end" className="max-h-72">
                          <SelectItem value="__auto__">Auto (server picks)</SelectItem>
                          {draftModels.length === 0 ? (
                            <SelectItem value="__none__" disabled>
                              No models available
                            </SelectItem>
                          ) : (
                            draftModels.map((m) => {
                              const display = formatDraftModelLabel(m.model);
                              return (
                                <SelectItem key={`${m.provider}:${m.model}:${m.source ?? ""}`} value={m.model}>
                                  <span className="font-mono">{display}</span>
                                  {m.source ? (
                                    <span className="ml-2 text-[10px] text-muted-foreground">via {m.source}</span>
                                  ) : null}
                                </SelectItem>
                              );
                            })
                          )}
                        </SelectContent>
                      </Select>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!fullMessage || draftMutation.isPending}
                            onClick={() => {
                              if (fullMessage) {
                                const instructions = replyComposerRef.current?.getValue() ?? "";
                                draftMutation.mutate({ msg: fullMessage, instructions });
                              }
                            }}
                          >
                            {draftMutation.isPending ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Sparkles className="h-3.5 w-3.5" />
                            )}
                            AI Draft
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {replyHasContent
                            ? "Use what you've typed as instructions and draft a reply"
                            : "Draft a reply with AI"}
                        </TooltipContent>
                      </Tooltip>
                      <Button
                        size="sm"
                        disabled={!replyHasContent || replyMutation.isPending}
                        onClick={() => {
                          const body = replyComposerRef.current?.getValue().trim() ?? "";
                          if (selectedUid && body) {
                            replyMutation.mutate({ uid: selectedUid, body, rAll: replyAll });
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
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {composeMode === "forward" ? "Forward message" : "New message"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">To</label>
              <DraftInput
                key={`to:${composeMode}:${composeSourceUid ?? "none"}`}
                ref={composeToRef}
                initialValue={composeInitial.to}
                draftKey={composeMode === "new" ? COMPOSE_TO_KEY : null}
                placeholder="recipient@example.com"
                className="text-sm"
                onContentChange={setComposeToHasContent}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Subject</label>
              <DraftInput
                key={`subject:${composeMode}:${composeSourceUid ?? "none"}`}
                ref={composeSubjectRef}
                initialValue={composeInitial.subject}
                draftKey={composeMode === "new" ? COMPOSE_SUBJECT_KEY : null}
                placeholder="Subject"
                className="text-sm"
                onContentChange={setComposeSubjectHasContent}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Message</label>
              <DraftTextarea
                key={`body:${composeMode}:${composeSourceUid ?? "none"}`}
                ref={composeBodyRef}
                initialValue={composeInitial.body}
                draftKey={
                  composeMode === "forward" && selectedMailbox && composeSourceUid !== null
                    ? forwardDraftKey(selectedMailbox, composeSourceUid)
                    : composeMode === "new"
                      ? COMPOSE_BODY_KEY
                      : null
                }
                placeholder="Write your message…"
                className="min-h-[160px] max-h-[400px] text-sm resize-none overflow-y-auto"
                onContentChange={setComposeBodyHasContent}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setComposeOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !composeToHasContent ||
                !composeSubjectHasContent ||
                !composeBodyHasContent ||
                composeMutation.isPending
              }
              onClick={() => {
                const to = composeToRef.current?.getValue().trim() ?? "";
                const subject = composeSubjectRef.current?.getValue().trim() ?? "";
                const body = composeBodyRef.current?.getValue().trim() ?? "";
                if (to && subject && body) {
                  composeMutation.mutate({ to, subject, body });
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

// Adapter-routed model ids encode as `adapter:<adapterType>:<modelId>`.
// Strip the prefix so the dropdown shows the plain model name; the adapter
// source is rendered separately as a "via X" hint.
function formatDraftModelLabel(modelId: string): string {
  if (!modelId.startsWith("adapter:")) return modelId;
  const rest = modelId.slice("adapter:".length);
  const sep = rest.indexOf(":");
  return sep > 0 ? rest.slice(sep + 1) : modelId;
}
