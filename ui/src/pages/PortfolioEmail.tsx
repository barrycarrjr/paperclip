import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Mail,
  MailOpen,
  Loader2,
  Check,
  Archive,
  Trash2,
  AlertCircle,
  Eye,
  EyeOff,
  Users,
  AlignLeft,
  ExternalLink,
  Reply,
  Forward,
  Bot,
} from "lucide-react";
import type { Company, IssueDocument } from "@paperclipai/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { pluginsApi } from "../api/plugins";
import {
  EMAIL_TOOLS_PLUGIN_KEY,
  makeEmailToolsApi,
  type MailHeader,
} from "../api/emailTools";
import { HELP_SCOUT_PLUGIN_KEY } from "../api/helpScoutBridge";
import type { HelpScoutMailboxRef } from "../lib/mailboxKind";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { dismissReviewSender } from "../lib/email-triage-rules";
import { cn } from "../lib/utils";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  HelpScoutMailboxPanel,
  helpScoutMailboxQueryKey,
} from "../components/HelpScoutMailboxPanel";

const TRIAGE_FOLDER = "_paperclip/triage";
const RULES_HOME_TITLE_PREFIX = "Email triage rules - ";
const RULES_HOME_DOC_KEY = "email-triage-rules";

interface ConfigMailbox {
  name?: string;
  key?: string;
  pollFolder?: string;
  allowedCompanies?: string[];
}

interface ResolvedMailbox {
  key: string;
  name: string;
  pollFolder: string;
  allowedCompanies: string[];
  primaryCompanyId: string;
  primaryCompany: Company | null;
}

interface RulesBundle {
  issueId: string;
  title: string;
  body: string;
  latestRevisionId: string | null;
}

function mailboxEmail(name: string | undefined, key: string): string {
  if (!name) return key;
  const m = name.match(/\S+@\S+/);
  return m ? m[0] : key;
}

function mailboxLabel(name: string | undefined, key: string): string {
  if (!name) return key;
  const m = name.match(/^(.+?)\s+-\s+\S+@\S+$/);
  return m ? m[1]! : name;
}

function extractSender(msg: MailHeader): string {
  const addrMatch = msg.from.match(/<([^>]+)>/);
  return addrMatch ? addrMatch[1]! : msg.from;
}

export function PortfolioEmail() {
  const { selectedCompanyId, selectedCompany, companies, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  useEffect(() => {
    setBreadcrumbs([{ label: "Portfolio Email" }]);
  }, [setBreadcrumbs]);

  const isPortfolioRoot = selectedCompany?.isPortfolioRoot ?? false;

  const { data: plugins, isLoading: pluginsLoading } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list("ready"),
    staleTime: 60_000,
  });
  const pluginId = plugins?.find((p) => p.pluginKey === EMAIL_TOOLS_PLUGIN_KEY)?.id ?? null;
  const helpScoutPluginId =
    plugins?.find((p) => p.pluginKey === HELP_SCOUT_PLUGIN_KEY)?.id ?? null;

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: queryKeys.plugins.config(pluginId ?? ""),
    queryFn: () => pluginsApi.getConfig(pluginId!),
    enabled: !!pluginId,
    staleTime: 60_000,
  });

  const { data: helpScoutConfig, isLoading: helpScoutConfigLoading } = useQuery({
    queryKey: queryKeys.plugins.config(helpScoutPluginId ?? ""),
    queryFn: () => pluginsApi.getConfig(helpScoutPluginId!),
    enabled: !!helpScoutPluginId,
    staleTime: 60_000,
  });

  const companyById = useMemo(() => {
    const map = new Map<string, Company>();
    for (const c of companies) map.set(c.id, c);
    return map;
  }, [companies]);

  // Resolve mailboxes — for each configured mailbox with at least one
  // allowedCompany the operator can see, pick a representative companyId
  // to use for API auth. Wildcard "*" maps to the HQ company.
  const resolvedMailboxes: ResolvedMailbox[] = useMemo(() => {
    const list = ((config?.configJson?.mailboxes ?? []) as ConfigMailbox[]) ?? [];
    const out: ResolvedMailbox[] = [];
    for (const mb of list) {
      const key = mb.key;
      const allowed = mb.allowedCompanies ?? [];
      if (!key || allowed.length === 0) continue;
      let primaryId: string | null = null;
      if (allowed.includes("*")) {
        primaryId = selectedCompanyId;
      } else {
        primaryId = allowed.find((c) => companyById.has(c)) ?? null;
      }
      if (!primaryId) continue;
      out.push({
        key,
        name: mb.name ?? key,
        pollFolder: mb.pollFolder || "INBOX",
        allowedCompanies: allowed,
        primaryCompanyId: primaryId,
        primaryCompany: companyById.get(primaryId) ?? null,
      });
    }
    return out;
  }, [config, companyById, selectedCompanyId]);

  // Resolve help-scout mailboxes — one panel per (account, mailboxId).
  // Discovery follows two passes: the plugin config lists accounts with
  // allowedCompanies + allowedMailboxes; we pick a representative company per
  // account (same rule as IMAP), then fan out the allowedMailboxes list. We
  // can't ask Help Scout for the canonical name/email per ID here without an
  // extra API call — the bridge `helpscout.list-mailboxes` does that, but
  // we'd need to call it per company. For the Portfolio header label we use
  // accountKey + mailboxId as a placeholder; the panel itself fetches its
  // own metadata as part of listing conversations.
  const resolvedHelpScoutMailboxes: Array<{
    ref: HelpScoutMailboxRef;
    primaryCompany: Company | null;
  }> = useMemo(() => {
    if (!helpScoutPluginId) return [];
    const accounts =
      ((helpScoutConfig?.configJson?.accounts ?? []) as Array<{
        key?: string;
        displayName?: string;
        allowedMailboxes?: string[];
        defaultMailbox?: string;
        allowedCompanies?: string[];
      }>) ?? [];
    const out: Array<{ ref: HelpScoutMailboxRef; primaryCompany: Company | null }> = [];
    for (const account of accounts) {
      const accountKey = account.key;
      const allowed = account.allowedCompanies ?? [];
      if (!accountKey || allowed.length === 0) continue;
      let primaryId: string | null = null;
      if (allowed.includes("*")) {
        primaryId = selectedCompanyId;
      } else {
        primaryId = allowed.find((c) => companyById.has(c)) ?? null;
      }
      if (!primaryId) continue;
      // Materialize a panel per allowedMailbox. Fall back to defaultMailbox
      // when allowedMailboxes is empty/missing (= unrestricted within the
      // account — but for the UI roll-up we still need a concrete mailbox
      // id, so default is the only sensible single choice).
      const mailboxIds =
        account.allowedMailboxes && account.allowedMailboxes.length > 0
          ? account.allowedMailboxes
          : account.defaultMailbox
            ? [account.defaultMailbox]
            : [];
      for (const mailboxId of mailboxIds) {
        out.push({
          ref: {
            kind: "helpscout",
            pluginId: helpScoutPluginId,
            primaryCompanyId: primaryId,
            accountKey,
            mailboxId,
            name: account.displayName || accountKey,
            email: "",
            allowedCompanies: allowed,
          },
          primaryCompany: companyById.get(primaryId) ?? null,
        });
      }
    }
    return out;
  }, [helpScoutPluginId, helpScoutConfig, companyById, selectedCompanyId]);

  const [showAll, setShowAll] = useState(() => {
    try {
      return localStorage.getItem("portfolio-email-showAll") === "true";
    } catch {
      return false;
    }
  });
  function toggleShowAll(v: boolean) {
    try {
      localStorage.setItem("portfolio-email-showAll", String(v));
    } catch {}
    setShowAll(v);
  }
  const [groupBySender, setGroupBySender] = useState(() => {
    try {
      return localStorage.getItem("portfolio-email-groupBySender") === "true";
    } catch {
      return false;
    }
  });
  function toggleGroupBySender(v: boolean) {
    try {
      localStorage.setItem("portfolio-email-groupBySender", String(v));
    } catch {}
    setGroupBySender(v);
  }

  function openInCompany(
    mailboxKey: string,
    uid: number | null,
    companyId: string,
    action?: "reply" | "forward" | "handoff",
  ) {
    const targetCompany = companyById.get(companyId);
    if (!targetCompany) return;
    if (companyId !== selectedCompanyId) {
      setSelectedCompanyId(companyId, { source: "manual" });
    }
    const params = new URLSearchParams();
    params.set("mailbox", mailboxKey);
    if (uid != null) params.set("uid", String(uid));
    params.set("all", "1");
    if (action) params.set("action", action);
    // Use the target company's prefix directly. If we hand a bare "/email" to
    // navigate(), the router resolves the prefix from the current URL (HQ),
    // and Layout's URL → selectedCompanyId sync then yanks the company back
    // to HQ — landing on a mailbox that may not exist there.
    navigate(`/${targetCompany.issuePrefix}/email?${params.toString()}`);
  }

  function openHelpScoutInCompany(
    ref: HelpScoutMailboxRef,
    conversationId: string | null,
    action?: "reply" | "handoff",
  ) {
    const targetCompany = companyById.get(ref.primaryCompanyId);
    if (!targetCompany) return;
    if (ref.primaryCompanyId !== selectedCompanyId) {
      setSelectedCompanyId(ref.primaryCompanyId, { source: "manual" });
    }
    const params = new URLSearchParams();
    params.set("mailbox", helpScoutMailboxQueryKey(ref));
    if (conversationId) params.set("conv", conversationId);
    if (action) params.set("action", action);
    navigate(`/${targetCompany.issuePrefix}/email?${params.toString()}`);
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Mail} message="Select a company to view Portfolio Email." />;
  }
  if (!isPortfolioRoot) {
    return (
      <EmptyState
        icon={Mail}
        message="Portfolio Email is only available on the HQ (portfolio root) company. For a single-company view, use Email."
      />
    );
  }
  if (
    pluginsLoading ||
    (pluginId && configLoading) ||
    (helpScoutPluginId && helpScoutConfigLoading)
  ) {
    return <PageSkeleton variant="list" />;
  }
  if (!pluginId && !helpScoutPluginId) {
    return (
      <EmptyState
        icon={Mail}
        message="Install the email-tools or help-scout plugin to use Portfolio Email."
      />
    );
  }
  if (resolvedMailboxes.length === 0 && resolvedHelpScoutMailboxes.length === 0) {
    return (
      <EmptyState
        icon={Mail}
        message="No mailboxes are configured. Add a mailbox in the email-tools or help-scout plugin settings."
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-base font-semibold">Portfolio Email</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Triage every enabled mailbox without switching companies.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => toggleShowAll(!showAll)}
                aria-label={showAll ? "Show unread only" : "Show all messages"}
              >
                {showAll ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {showAll
                ? "Showing all — click for unread only"
                : "Showing unread only — click for all"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => toggleGroupBySender(!groupBySender)}
                aria-label={groupBySender ? "Flatten" : "Group by sender"}
              >
                {groupBySender ? (
                  <Users className="h-3.5 w-3.5" />
                ) : (
                  <AlignLeft className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {groupBySender
                ? "Group by sender — click to flatten"
                : "Flat list — click to group by sender"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-6 py-4 space-y-4">
          {pluginId &&
            resolvedMailboxes.map((mb) => (
              <MailboxPanel
                key={`${mb.primaryCompanyId}:${mb.key}`}
                mailbox={mb}
                pluginId={pluginId}
                showAll={showAll}
                groupBySender={groupBySender}
                onOpenMessage={(uid, action) =>
                  openInCompany(mb.key, uid, mb.primaryCompanyId, action)
                }
                onOpenMailbox={() => openInCompany(mb.key, null, mb.primaryCompanyId)}
              />
            ))}
          {resolvedHelpScoutMailboxes.map(({ ref, primaryCompany }) => (
            <HelpScoutMailboxPanel
              key={`${ref.primaryCompanyId}:${ref.accountKey}:${ref.mailboxId}`}
              mailbox={ref}
              primaryCompany={primaryCompany}
              onOpenMailbox={() => openHelpScoutInCompany(ref, null)}
              onOpenConversation={(conversationId, action) =>
                openHelpScoutInCompany(ref, conversationId, action)
              }
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

interface MailboxPanelProps {
  mailbox: ResolvedMailbox;
  pluginId: string;
  showAll: boolean;
  groupBySender: boolean;
  onOpenMessage: (uid: number, action?: "reply" | "forward" | "handoff") => void;
  onOpenMailbox: () => void;
}

function MailboxPanel({
  mailbox,
  pluginId,
  showAll,
  groupBySender,
  onOpenMessage,
  onOpenMailbox,
}: MailboxPanelProps) {
  const queryClient = useQueryClient();
  const { primaryCompanyId, primaryCompany, key, name, pollFolder } = mailbox;

  const emailApi = useMemo(
    () => makeEmailToolsApi(pluginId, primaryCompanyId),
    [pluginId, primaryCompanyId],
  );

  const [optimisticallyRemovedUids, setOptimisticallyRemovedUids] = useState<Set<number>>(
    new Set(),
  );

  const messageListKey = [
    "email",
    pluginId,
    primaryCompanyId,
    key,
    pollFolder,
    showAll ? "all" : "unseen",
  ];

  const {
    data: messagesData,
    isLoading: messagesLoading,
    error: messagesError,
  } = useQuery({
    queryKey: messageListKey,
    queryFn: () =>
      emailApi.listMessages(key, {
        folder: pollFolder,
        unseen: !showAll,
        limit: 50,
      }),
    refetchInterval: 30_000,
  });

  const { data: rulesData } = useQuery({
    queryKey: ["email", pluginId, primaryCompanyId, key, "rules"],
    queryFn: () => emailApi.listRules(key),
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

  const { data: rulesBundle } = useQuery<RulesBundle | null>({
    queryKey: ["email", "rulesHome", primaryCompanyId, key],
    queryFn: async () => {
      const titlePrefix = `${RULES_HOME_TITLE_PREFIX}${key}`;
      const issues = await issuesApi.list(primaryCompanyId, { q: titlePrefix, limit: 5 });
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

  function invalidateRules() {
    queryClient.invalidateQueries({
      queryKey: ["email", pluginId, primaryCompanyId, key, "rules"],
    });
  }
  function invalidateMessageList() {
    queryClient.invalidateQueries({ queryKey: messageListKey });
  }

  function optimisticallyRemove(uid: number) {
    setOptimisticallyRemovedUids((prev) => new Set([...prev, uid]));
  }
  function unremove(uid: number) {
    setOptimisticallyRemovedUids((prev) => {
      const next = new Set(prev);
      next.delete(uid);
      return next;
    });
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
      queryKey: ["email", "rulesHome", primaryCompanyId, key],
    });
  }

  // Mark-read implies "this sender matters" — auto-add keep-always when not
  // already classified. Mirrors the per-company Email page. Muted senders
  // are also a deliberate operator choice — don't silently invert mute into
  // keep-always.
  async function maybeAddImplicitKeepAlways(msg: MailHeader): Promise<void> {
    if (
      senderMatchesPattern(msg, autoTriageSet) ||
      senderMatchesPattern(msg, keepAlwaysSet) ||
      senderMatchesPattern(msg, muteSet)
    ) {
      return;
    }
    const sender = extractSender(msg);
    try {
      await emailApi.setRule(key, sender, "keep-always");
    } catch {
      // Best-effort
    }
  }

  const markReadMutation = useMutation({
    mutationFn: async (msg: MailHeader) => {
      optimisticallyRemove(msg.uid);
      await emailApi.markRead(key, msg.uid, pollFolder);
      await maybeAddImplicitKeepAlways(msg);
    },
    onSuccess: () => {
      invalidateRules();
    },
    onError: (_err, msg) => {
      unremove(msg.uid);
    },
  });

  const markUnreadMutation = useMutation({
    mutationFn: (msg: MailHeader) => emailApi.markUnread(key, msg.uid, pollFolder),
    onSuccess: () => invalidateMessageList(),
  });

  const keepAlwaysMutation = useMutation({
    mutationFn: async (msg: MailHeader) => {
      const sender = extractSender(msg);
      await emailApi.setRule(key, sender, "keep-always");
      await applyRulesTransform(sender, dismissReviewSender);
    },
    onSuccess: () => invalidateRules(),
  });

  const autoTriageMutation = useMutation({
    mutationFn: async (msg: MailHeader) => {
      optimisticallyRemove(msg.uid);
      await emailApi.moveMessage(key, msg.uid, pollFolder, TRIAGE_FOLDER);
      const sender = extractSender(msg);
      await emailApi.setRule(key, sender, "auto-triage");
      await applyRulesTransform(sender, dismissReviewSender);
    },
    onSuccess: () => {
      invalidateRules();
      invalidateMessageList();
    },
    onError: (_err, msg) => {
      unremove(msg.uid);
      invalidateMessageList();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (msg: MailHeader) => {
      optimisticallyRemove(msg.uid);
      await emailApi.deleteMessage(key, msg.uid, pollFolder);
    },
    onError: (_err, msg) => {
      unremove(msg.uid);
      invalidateMessageList();
    },
  });

  const allMessages = messagesData?.messages ?? [];
  const messages = allMessages.filter((m) => !optimisticallyRemovedUids.has(m.uid));

  const displayLabel = mailboxLabel(name, key);
  const displayEmail = mailboxEmail(name, key);

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/40">
        {primaryCompany ? (
          <CompanyPatternIcon
            companyName={primaryCompany.name}
            logoUrl={primaryCompany.logoUrl}
            brandColor={primaryCompany.brandColor}
            className="h-6 w-6 shrink-0 rounded-[3px]"
          />
        ) : (
          <Mail className="h-6 w-6 shrink-0 text-muted-foreground" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {key}
            {primaryCompany ? (
              <span className="ml-2 normal-case font-normal text-muted-foreground/70">
                · {primaryCompany.name}
                {mailbox.allowedCompanies.includes("*") && " · shared"}
                {mailbox.allowedCompanies.length > 1 &&
                  !mailbox.allowedCompanies.includes("*") &&
                  ` · +${mailbox.allowedCompanies.length - 1} more`}
              </span>
            ) : null}
          </div>
          <div className="text-sm font-semibold truncate">{displayLabel}</div>
          {displayEmail !== key && (
            <div className="text-xs text-muted-foreground truncate">{displayEmail}</div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {messagesLoading && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
          <span className="text-xs text-muted-foreground">
            {messages.length} {showAll ? "" : "unread "}
            {messages.length === 1 ? "message" : "messages"}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onOpenMailbox}
                aria-label="Open in company view"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Open this mailbox in {primaryCompany?.name ?? "company"} view
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <MessageListBody
        messages={messages}
        messagesLoading={messagesLoading}
        messagesError={messagesError as Error | null}
        showAll={showAll}
        groupBySender={groupBySender}
        autoTriageSet={autoTriageSet}
        keepAlwaysSet={keepAlwaysSet}
        senderMatchesPattern={senderMatchesPattern}
        markRead={(m) => markReadMutation.mutate(m)}
        markReadPendingUid={
          markReadMutation.isPending ? markReadMutation.variables?.uid ?? null : null
        }
        markUnread={(m) => markUnreadMutation.mutate(m)}
        markUnreadPendingUid={
          markUnreadMutation.isPending ? markUnreadMutation.variables?.uid ?? null : null
        }
        keepAlways={(m) => keepAlwaysMutation.mutate(m)}
        keepAlwaysPendingUid={
          keepAlwaysMutation.isPending ? keepAlwaysMutation.variables?.uid ?? null : null
        }
        autoTriage={(m) => autoTriageMutation.mutate(m)}
        autoTriagePendingUid={
          autoTriageMutation.isPending ? autoTriageMutation.variables?.uid ?? null : null
        }
        deleteMsg={(m) => deleteMutation.mutate(m)}
        deletePendingUid={
          deleteMutation.isPending ? deleteMutation.variables?.uid ?? null : null
        }
        onOpenMessage={onOpenMessage}
      />
    </div>
  );
}

interface MessageListBodyProps {
  messages: MailHeader[];
  messagesLoading: boolean;
  messagesError: Error | null;
  showAll: boolean;
  groupBySender: boolean;
  autoTriageSet: Set<string>;
  keepAlwaysSet: Set<string>;
  senderMatchesPattern: (msg: MailHeader, patterns: Set<string>) => boolean;
  markRead: (msg: MailHeader) => void;
  markReadPendingUid: number | null;
  markUnread: (msg: MailHeader) => void;
  markUnreadPendingUid: number | null;
  keepAlways: (msg: MailHeader) => void;
  keepAlwaysPendingUid: number | null;
  autoTriage: (msg: MailHeader) => void;
  autoTriagePendingUid: number | null;
  deleteMsg: (msg: MailHeader) => void;
  deletePendingUid: number | null;
  onOpenMessage: (uid: number, action?: "reply" | "forward" | "handoff") => void;
}

function MessageListBody(props: MessageListBodyProps) {
  const { messages, messagesLoading, messagesError, showAll, groupBySender } = props;

  if (messagesError) {
    return (
      <div className="flex items-center justify-center py-6 px-4">
        <div className="text-center space-y-1">
          <AlertCircle className="h-4 w-4 text-destructive mx-auto" />
          <p className="text-xs text-muted-foreground">{messagesError.message}</p>
        </div>
      </div>
    );
  }
  if (messagesLoading && messages.length === 0) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (messages.length === 0) {
    return (
      <div className="py-6 px-4 text-center text-xs text-muted-foreground">
        {showAll ? "No messages in this folder." : "No unread messages."}
      </div>
    );
  }

  if (!groupBySender) {
    return (
      <div className="divide-y divide-border">
        {messages.map((msg) => (
          <MessageRow key={msg.uid} msg={msg} {...props} />
        ))}
      </div>
    );
  }

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
    <div className="divide-y divide-border">
      {groups.map((g) => (
        <SenderGroup key={g.sender} sender={g.sender} msgs={g.msgs} {...props} />
      ))}
    </div>
  );
}

function SenderGroup({
  sender,
  msgs,
  autoTriageSet,
  keepAlwaysSet,
  markRead,
  keepAlways,
  autoTriage,
  deleteMsg,
  ...rest
}: { sender: string; msgs: MailHeader[] } & MessageListBodyProps) {
  const senderLower = sender.toLowerCase();
  const senderDomain = sender.includes("@") ? `@${sender.split("@")[1]!.toLowerCase()}` : null;
  const senderHasAutoTriage =
    autoTriageSet.has(senderLower) || (senderDomain ? autoTriageSet.has(senderDomain) : false);
  const senderHasKeepAlways =
    keepAlwaysSet.has(senderLower) || (senderDomain ? keepAlwaysSet.has(senderDomain) : false);

  return (
    <div>
      <div className="flex items-center gap-2 px-4 py-2 bg-muted/20">
        <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-semibold truncate">{sender}</span>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {msgs.length} {msgs.length === 1 ? "message" : "messages"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  for (const m of msgs) markRead(m);
                }}
                aria-label="Mark all read"
              >
                <MailOpen className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Mark all read</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  if (msgs[0]) keepAlways(msgs[0]);
                }}
                aria-label="Keep always"
                className={cn(
                  senderHasKeepAlways ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Check
                  className="h-3.5 w-3.5"
                  strokeWidth={senderHasKeepAlways ? 3.5 : 2}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {senderHasKeepAlways ? "Keep always (rule active)" : "Keep always from this sender"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  if (msgs[0]) autoTriage(msgs[0]);
                }}
                aria-label="Auto-triage"
                className={cn(
                  senderHasAutoTriage ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Archive
                  className={cn("h-3.5 w-3.5", senderHasAutoTriage && "fill-current")}
                  strokeWidth={senderHasAutoTriage ? 2.5 : 2}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {senderHasAutoTriage
                ? "Auto-triage (rule active)"
                : "Auto-triage all from this sender"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  for (const m of msgs) deleteMsg(m);
                }}
                aria-label="Delete all"
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete all from this sender</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="divide-y divide-border/60">
        {msgs.map((msg) => (
          <MessageRow
            key={msg.uid}
            msg={msg}
            autoTriageSet={autoTriageSet}
            keepAlwaysSet={keepAlwaysSet}
            markRead={markRead}
            keepAlways={keepAlways}
            autoTriage={autoTriage}
            deleteMsg={deleteMsg}
            {...rest}
          />
        ))}
      </div>
    </div>
  );
}

function MessageRow({
  msg,
  senderMatchesPattern,
  autoTriageSet,
  keepAlwaysSet,
  markRead,
  markReadPendingUid,
  markUnread,
  markUnreadPendingUid,
  keepAlways,
  keepAlwaysPendingUid,
  autoTriage,
  autoTriagePendingUid,
  deleteMsg,
  deletePendingUid,
  onOpenMessage,
}: { msg: MailHeader } & MessageListBodyProps) {
  const isMarkReadPending = markReadPendingUid === msg.uid;
  const isMarkUnreadPending = markUnreadPendingUid === msg.uid;
  const isKeepPending = keepAlwaysPendingUid === msg.uid;
  const isAutoTriagePending = autoTriagePendingUid === msg.uid;
  const isDeletePending = deletePendingUid === msg.uid;
  const hasAutoTriageRule = senderMatchesPattern(msg, autoTriageSet);
  const hasKeepAlwaysRule = senderMatchesPattern(msg, keepAlwaysSet);

  return (
    <div
      className="group flex items-center gap-2 px-4 py-2.5 hover:bg-accent/40 transition-colors cursor-pointer"
      onClick={() => onOpenMessage(msg.uid)}
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
        className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        {msg.unseen ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={isMarkReadPending}
            onClick={() => markRead(msg)}
            title="Mark as read"
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
            variant="ghost"
            size="icon-sm"
            disabled={isMarkUnreadPending}
            onClick={() => markUnread(msg)}
            title="Mark as unread"
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
          variant="ghost"
          size="icon-sm"
          onClick={() => onOpenMessage(msg.uid, "reply")}
          title="Reply"
          className="text-muted-foreground hover:text-foreground"
        >
          <Reply className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onOpenMessage(msg.uid, "forward")}
          title="Forward"
          className="text-muted-foreground hover:text-foreground"
        >
          <Forward className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onOpenMessage(msg.uid, "handoff")}
          title="Hand off to agent"
          className="text-muted-foreground hover:text-foreground"
        >
          <Bot className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={isKeepPending}
          onClick={() => keepAlways(msg)}
          title={hasKeepAlwaysRule ? "Keep always (rule active)" : "Keep always"}
          className={cn(
            hasKeepAlwaysRule
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {isKeepPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" strokeWidth={hasKeepAlwaysRule ? 3.5 : 2} />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={isAutoTriagePending}
          onClick={() => autoTriage(msg)}
          title={hasAutoTriageRule ? "Auto-triage (rule active)" : "Auto-triage"}
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
          variant="ghost"
          size="icon-sm"
          disabled={isDeletePending}
          onClick={() => deleteMsg(msg)}
          title="Delete (move to Trash)"
          className="text-muted-foreground hover:text-destructive"
        >
          {isDeletePending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}
