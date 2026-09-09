import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plug, Sparkles } from "lucide-react";
import { searchStarterCards, type StartWorkPlanResponse } from "@paperclipai/shared";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import {
  starterCatalogApi,
  type StarterActivationResult,
  type StarterCardStatus,
} from "../api/starterCatalog";
import { startWorkApi } from "../api/startWork";
import { useDialog } from "../context/DialogContext";
import { canWriteCompany } from "../lib/company-access";
import type {
  IssueThreadInteraction,
  RequestConfirmationInteraction,
  SuggestTasksInteraction,
} from "../lib/issue-thread-interactions";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";

/**
 * The one 409 that really does mean somebody else got there first. The server
 * sends this exact sentence when the card has already been accepted or
 * rejected; any other 409 is a different refusal and must not be dressed up as
 * this one.
 */
const ALREADY_DECIDED_SERVER_MESSAGE = "Interaction has already been resolved";

/**
 * "What do you want done?", the way into the starter catalog, and the way
 * to ask for a plan in your own words.
 *
 * One panel, two ways in, stacked. A text box on top for the person who
 * already knows what they want and would rather type it; the browsable
 * categories underneath for the person who does not know what is possible,
 * which is the more important of the two. Same panel for the beginner and
 * the expert.
 *
 * Typing filters the cards. Pressing Enter or "Draft a plan" asks the server
 * to draft a reviewable plan from the words; nothing is started until the
 * person accepts it on the card that comes back. Typing never switches a
 * starter card on: that stays an explicit button on the card itself.
 *
 * Every card states what it needs connected before you commit, and a card
 * that cannot run says so instead of letting you switch on a no-op.
 */
export function StarterCatalogDialog({
  companyId,
  open,
  onClose,
}: {
  companyId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [receipt, setReceipt] = useState<ReceiptContent | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [plan, setPlan] = useState<StartWorkPlanResponse | null>(null);
  // The card rendered for the plan. Starts as the plan's own row and is
  // replaced by the server's copy when somebody else decided it first.
  const [card, setCard] = useState<IssueThreadInteraction | null>(null);
  const [planError, setPlanError] = useState<{ status: number; message: string } | null>(null);
  const [decisionNotice, setDecisionNotice] = useState<string | null>(null);
  // One key per typed request. Retrying the same words after an error reuses
  // it so the server lands on the same plan; changed words mint a new one.
  const [request, setRequest] = useState<{ key: string; text: string } | null>(null);
  const queryClient = useQueryClient();
  const { openNewIssue } = useDialog();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.starterCatalog.list(companyId),
    queryFn: () => starterCatalogApi.list(companyId),
    enabled: open && !!companyId,
  });

  // Three answers, not two: still checking, could not check, and the answer
  // itself. Treating the first two as "you cannot start work here" told a
  // member with every right to be here that they had none.
  const {
    data: boardAccess,
    isLoading: accessPending,
    isError: accessFailed,
  } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: open,
    retry: false,
  });
  const canWrite = canWriteCompany(companyId, boardAccess);
  // Buttons stay on screen while the check runs, disabled, so the panel does
  // not change shape under the person a moment after they open it.
  const accessUnknown = accessPending && !accessFailed;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open && !!companyId,
  });
  const agentMap = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent] as const)),
    [agents],
  );

  const activate = useMutation({
    mutationFn: (cardId: string) => starterCatalogApi.activate(companyId, cardId),
    onMutate: (cardId) => {
      setActivatingId(cardId);
      setFailure(null);
      setReceipt(null);
    },
    onSuccess: (res) => {
      setReceipt(activationReceipt(res));
      queryClient.invalidateQueries({ queryKey: queryKeys.starterCatalog.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(companyId) });
    },
    onError: (err) => {
      setFailure(err instanceof Error ? err.message : String(err));
    },
    onSettled: () => setActivatingId(null),
  });

  const draft = useMutation({
    mutationFn: (input: { text: string; requestKey: string }) =>
      startWorkApi.plan(companyId, input),
    onMutate: () => {
      setPlanError(null);
      setFailure(null);
      setReceipt(null);
      setDecisionNotice(null);
    },
    onSuccess: (res) => {
      setPlan(res);
      setCard(res.interaction);
      // The server wrote a request issue and a card the Brief can now show.
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    },
    onError: (err) => {
      // 503 (no AI model) and 422 (nobody to do it, or words that could not
      // be planned) get their own boxes because each offers a way forward.
      if (err instanceof ApiError && (err.status === 503 || err.status === 422)) {
        setPlanError({ status: err.status, message: err.message });
        return;
      }
      setFailure(err instanceof Error ? err.message : String(err));
    },
  });

  function submitDraft() {
    const text = query.trim();
    if (!canWrite || draft.isPending || text.length < 3) return;
    const key = request && request.text === text ? request.key : mintRequestKey();
    setRequest({ key, text });
    draft.mutate({ text, requestKey: key });
  }

  function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    submitDraft();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter is handled here rather than left to the browser's implicit form
    // submit so there is exactly one path in, and it is the same one the
    // button uses.
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submitDraft();
  }

  function clearPlan() {
    setPlan(null);
    setCard(null);
    setQuery("");
    setRequest(null);
  }

  function invalidateAfterDecision(issueId: string) {
    const keys = [
      queryKeys.issues.list(companyId),
      queryKeys.issues.listByParent(companyId, issueId),
      queryKeys.issues.detail(issueId),
      queryKeys.issues.interactions(issueId),
      queryKeys.attention(companyId),
      queryKeys.starterCatalog.list(companyId),
    ];
    for (const queryKey of keys) {
      queryClient.invalidateQueries({ queryKey });
    }
  }

  async function handleDecisionError(err: unknown, issueId: string, interactionId: string) {
    if (err instanceof ApiError && err.status === 409) {
      // One 409 means somebody decided it from the issue page or the Brief
      // first, and then the fresh card below shows their decision. Every other
      // 409 is the server refusing this plan for its own reason, such as a task
      // handed to an agent nobody has approved yet, so show what it said
      // instead of blaming a person who was never there.
      setDecisionNotice(
        err.message === ALREADY_DECIDED_SERVER_MESSAGE
          ? "Someone already decided this plan"
          : err.message,
      );
      const rows = await issuesApi.listInteractions(issueId).catch(() => null);
      const fresh = rows?.find((row) => row.id === interactionId);
      if (fresh) setCard(fresh);
      invalidateAfterDecision(issueId);
      return;
    }
    setFailure(err instanceof Error ? err.message : String(err));
  }

  async function acceptPlan(
    interaction: SuggestTasksInteraction | RequestConfirmationInteraction,
    selectedClientKeys?: string[],
  ) {
    if (!plan) return;
    const issueId = plan.issue.id;
    try {
      const accepted = await issuesApi.acceptInteraction(issueId, interaction.id, { selectedClientKeys });
      // The accept has already gone through by this point. The read below only
      // names the owner, so if it fails the receipt says the owner is unknown
      // rather than pretending the whole accept failed.
      const container = await issuesApi.get(issueId).catch(() => null);
      const created = accepted.kind === "suggest_tasks"
        ? accepted.result?.createdTasks?.length ?? 0
        : 0;
      const skipped = accepted.kind === "suggest_tasks"
        ? accepted.result?.skippedClientKeys?.length ?? 0
        : 0;
      const ownerId = container?.assigneeAgentId ?? null;
      // The server queues the wake and does not wait for it, and it can be
      // refused (over budget, paused, or waiting for approval). So the receipt
      // says what is known: who holds it, and when it will be looked at.
      const ownerWarning = ownerId
        ? plan.warnings.find((warning) => warning.agentId === ownerId)
        : undefined;
      const ownerName = ownerId
        ? agentMap.get(ownerId)?.name ?? ownerWarning?.agentName ?? "the lead agent"
        : null;
      const identifier = plan.issue.identifier;
      const link = { to: `/issues/${identifier}`, label: identifier };
      const steps: ReceiptStep[] = [
        {
          step: "tasks",
          ok: true,
          detail: `Created ${created} ${created === 1 ? "task" : "tasks"} under `,
          link,
        },
        ownerName
          ? {
              step: "owner",
              ok: true,
              detail: ownerWarning
                ? `Handed to ${ownerName}. ${ownerName} is paused by budget, so it will not start until the budget is raised.`
                : `Handed to ${ownerName}. It will pick this up on its next run.`,
            }
          : container
            ? {
                step: "owner",
                ok: false,
                detail: "Nobody was handed the request; open ",
                link,
                after: " and assign it",
              }
            : {
                step: "owner",
                ok: false,
                detail: "Nobody could be confirmed; open ",
                link,
                after: " to check who has it",
              },
      ];
      if (skipped > 0) {
        steps.push({ step: "skipped", ok: true, detail: `Left out by you: ${skipped}` });
      }
      setReceipt({ title: "Plan accepted", steps });
      clearPlan();
      invalidateAfterDecision(issueId);
    } catch (err) {
      await handleDecisionError(err, issueId, interaction.id);
    }
  }

  async function rejectPlan(
    interaction: SuggestTasksInteraction | RequestConfirmationInteraction,
    reason?: string,
  ) {
    if (!plan) return;
    const issueId = plan.issue.id;
    try {
      await issuesApi.rejectInteraction(issueId, interaction.id, reason);
      // The server cancelled the request issue. Say so before the panel
      // empties, so a cancelled request found later is not a mystery.
      const identifier = plan.issue.identifier;
      setReceipt({
        title: "Plan rejected",
        steps: [
          {
            step: "cancelled",
            ok: true,
            detail: "Request ",
            link: { to: `/issues/${identifier}`, label: identifier },
            after: " was cancelled. Nothing was started.",
          },
        ],
      });
      clearPlan();
      invalidateAfterDecision(issueId);
    } catch (err) {
      await handleDecisionError(err, issueId, interaction.id);
    }
  }

  function createAsOneIssue() {
    const text = query.trim();
    openNewIssue({ title: firstLineOf(text), description: text, companyId });
    onClose();
  }

  // Filtering happens here rather than round-tripping per keystroke; the
  // catalog is small. The ranking itself is the shared one the server search
  // endpoint uses, so the panel and the API can never disagree about which
  // card a phrase lands on (a local substring match once let "book" surface
  // the rebook card, which the shared ranking deliberately refuses).
  const visible = useMemo(() => {
    const all = data?.cards ?? [];
    if (query.trim().length === 0) return all;
    const byId = new Map(all.map((entry) => [entry.card.id, entry]));
    return searchStarterCards(query)
      .map((card) => byId.get(card.id))
      .filter((entry): entry is StarterCardStatus => entry !== undefined);
  }, [data?.cards, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, StarterCardStatus[]>();
    for (const entry of visible) {
      const list = map.get(entry.card.category) ?? [];
      list.push(entry);
      map.set(entry.card.category, list);
    }
    return map;
  }, [visible]);

  // The starter cards the server says match the drafted request. They keep
  // their ordinary button: it is the only way a routine is ever created.
  const matchedCards = useMemo(() => {
    if (!plan) return [];
    const byId = new Map((data?.cards ?? []).map((entry) => [entry.card.id, entry]));
    return plan.matchedCards
      .map((id) => byId.get(id))
      .filter((entry): entry is StarterCardStatus => entry !== undefined);
  }, [data?.cards, plan]);

  const reviewing = plan !== null && card !== null;
  const showCatalog = !reviewing && !draft.isPending;
  const nothingMatched = showCatalog && query.trim().length > 0 && visible.length === 0;
  const canDraft = canWrite && !draft.isPending && query.trim().length >= 3;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogTitle className="text-base">What do you want done?</DialogTitle>

        <form className="space-y-1" onSubmit={handleFormSubmit}>
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleInputKeyDown}
              disabled={draft.isPending}
              placeholder="Type it however you'd say it out loud"
              aria-label="What do you want done?"
            />
            {canWrite || accessUnknown ? (
              <Button type="submit" size="sm" disabled={!canDraft}>
                {draft.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Drafting
                  </>
                ) : (
                  "Draft a plan"
                )}
              </Button>
            ) : null}
          </div>
          {accessFailed ? null : (
            <p className="text-xs text-muted-foreground">
              {accessUnknown
                ? "Checking your access..."
                : canWrite
                  ? "Press Enter for a plan you can review first. Or browse what this company can switch on below."
                  : "You can browse this company, but only members who can create work can start it."}
            </p>
          )}
        </form>

        {accessFailed && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
            Could not check your access. Close and try again.
          </p>
        )}

        {draft.isPending && (
          <p className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Drafting your plan. This can take up to a minute.
          </p>
        )}

        {receipt && <Receipt content={receipt} onDismiss={() => setReceipt(null)} />}

        {failure && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
            {failure}
          </p>
        )}

        {planError && (
          // Both refusals leave nothing behind on the server, and the normal
          // New issue form works without an AI model or a plan, so it is a
          // real way forward rather than a dead end.
          <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm">
            <p>{planError.message}</p>
            {canWrite ? (
              <Button size="sm" variant="outline" onClick={createAsOneIssue}>
                Create it as one issue instead
              </Button>
            ) : null}
          </div>
        )}

        {isLoading && showCatalog && (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        )}

        {nothingMatched && (
          // Never a dead end: the design's rule is that nobody is stuck
          // because they used a word the catalog doesn't know.
          <div className="rounded-md border border-border px-3 py-3 text-sm">
            <p className="font-medium">Nothing here matches that yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {canWrite
                ? `Nothing in the catalog covers "${query.trim()}". Press Enter and an AI will draft a plan for you to review.`
                : `Nothing in the catalog covers "${query.trim()}".`}
            </p>
          </div>
        )}

        {reviewing && plan && card && (
          <div className="space-y-4">
            {matchedCards.length > 0 && (
              <section className="space-y-2">
                <div>
                  <h3 className="text-sm font-medium">Ready-made starters that match</h3>
                  <p className="text-xs text-muted-foreground">
                    Turning one on is separate from the plan below and repeats on a schedule.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {matchedCards.map((entry) => (
                    <CatalogCard
                      key={entry.card.id}
                      entry={entry}
                      busy={activatingId === entry.card.id}
                      disabled={activate.isPending || accessUnknown}
                      canActivate={canWrite || accessUnknown}
                      onActivate={() => activate.mutate(entry.card.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            <PlanHeader plan={plan} />

            {decisionNotice && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                {decisionNotice}
              </p>
            )}

            <IssueThreadInteractionCard
              interaction={card}
              agentMap={agentMap}
              currentUserId={boardAccess?.userId ?? null}
              onAcceptInteraction={canWrite ? acceptPlan : undefined}
              onRejectInteraction={canWrite ? rejectPlan : undefined}
            />

            {canWrite ? (
              <p className="text-xs text-muted-foreground">
                You can also decide this later from your Overview or from{" "}
                <Link to={`/issues/${plan.issue.identifier}`} className="underline">
                  {plan.issue.identifier}
                </Link>
                .
              </p>
            ) : boardAccess ? (
              // The card leaves its Accept and Reject buttons on screen and
              // switched off, so say why they cannot be pressed rather than
              // leaving the person to work it out. Only said when the access
              // answer is in: while it is checking or after it failed, the
              // sentences above the box already say so.
              <p className="text-xs text-muted-foreground">
                Your role in this company can read this plan but not accept or reject it. Ask
                an admin for a role that can create work.
              </p>
            ) : null}
          </div>
        )}

        {showCatalog && (
          <div className="space-y-5">
            {(data?.categories ?? []).map((category) => {
              const entries = grouped.get(category.id) ?? [];
              if (entries.length === 0) return null;
              return (
                <section key={category.id} className="space-y-2">
                  <div>
                    <h3 className="text-sm font-medium">{category.title}</h3>
                    <p className="text-xs text-muted-foreground">{category.blurb}</p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {entries.map((entry) => (
                      <CatalogCard
                        key={entry.card.id}
                        entry={entry}
                        busy={activatingId === entry.card.id}
                        disabled={activate.isPending || accessUnknown}
                        canActivate={canWrite || accessUnknown}
                        onActivate={() => activate.mutate(entry.card.id)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The plain-words facts above the plan. Every line is something the server
 * said, never something the browser worked out, so a reviewer reads who
 * leads, what it costs and what will wait for them before deciding.
 */
function PlanHeader({ plan }: { plan: StartWorkPlanResponse }) {
  const taskCount = plan.interaction.payload.tasks.length;
  const identifier = plan.issue.identifier;
  const issueLink = (
    <Link to={`/issues/${identifier}`} className="underline">
      {identifier}
    </Link>
  );

  return (
    <div className="space-y-2 rounded-md border border-border bg-accent/40 px-3 py-3 text-sm">
      <p className="font-medium">{plan.interaction.title ?? "Your plan"}</p>
      <ul className="space-y-1 text-xs text-muted-foreground">
        <li>
          {plan.lead
            ? `Lead: ${plan.lead.name}. The lead tracks the whole request; each task goes to the agent named on it.`
            : <>No agent is free to lead this right now. After you accept, open {issueLink} and assign it.</>}
        </li>
        <li>Starts the moment you accept, and runs once.</li>
        <li>
          Creates {taskCount} {taskCount === 1 ? "task" : "tasks"} in {plan.notes.companyName} under {issueLink}.
        </li>
        {plan.planner.modelUsed ? (
          <li>
            Drafted by {plan.planner.modelUsed}. Drafting used one AI call; it is not charged to any agent budget.
          </li>
        ) : null}
        <li>
          {plan.guardrails.outboundHold
            ? "Emails, messages, calls and public posts the agents draft will wait for your approval first."
            : "The approval hold is switched off, so emails, messages, calls and public posts the agents make will go out without asking you. Change this under Instance settings."}
        </li>
        {plan.warnings.map((warning) => (
          <li key={warning.agentId} className="text-amber-700 dark:text-amber-400">
            {warning.agentName} is paused by budget. Its task will be created but will not start until the budget is raised.
          </li>
        ))}
        {plan.notes.soundsRecurring ? (
          <li>
            {plan.notes.recurringNote ? `${plan.notes.recurringNote} ` : ""}
            This sounds like something to repeat. This step creates one-off tasks only. To make it repeat, set it up on the{" "}
            <Link to="/routines" className="underline">Automations page</Link> afterwards.
          </li>
        ) : null}
        {plan.notes.isPortfolioRoot ? (
          <li>
            This plan is for {plan.notes.companyName} only. To send this to every company, use{" "}
            <Link to="/portfolio-directives" className="underline">Portfolio directives</Link>.
          </li>
        ) : null}
      </ul>

      {plan.leftOut.length > 0 && (
        // These never reach the card, so they cannot be ticked: the company
        // cannot run them until the named plugin is installed and on.
        <div className="border-t border-border/60 pt-2">
          <p className="text-xs font-medium">Left out, and why</p>
          <ul className="mt-1 space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
            {plan.leftOut.map((entry) => (
              <li key={entry.title}>
                {entry.title}: {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CatalogCard({
  entry,
  busy,
  disabled,
  canActivate,
  onActivate,
}: {
  entry: StarterCardStatus;
  busy: boolean;
  disabled: boolean;
  /** False for a viewer: the button is left out rather than shown and refused. */
  canActivate: boolean;
  onActivate: () => void;
}) {
  const { card, ready, blockers, existingRoutineId } = entry;
  const alreadyOn = existingRoutineId !== null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div>
        <p className="text-sm font-medium leading-snug">{card.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{card.what}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{card.when}</p>
      </div>

      {/* The line the old Routines page never had: what this costs you before
          you commit, rather than after it silently fails. */}
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Plug className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          {card.requiresPlugins.length === 0
            ? "Works with what you already have"
            : `Needs ${card.requiresPlugins.join(", ")}`}
        </span>
      </p>

      {blockers.length > 0 && (
        <ul className="space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
          {blockers.map((b) => (
            <li key={b.pluginKey}>
              {b.kind === "missing"
                ? `${b.pluginKey} isn't installed. Install it on the Plugins page first`
                : `${b.pluginKey} is switched off. Turning this on will switch it back on`}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto pt-1">
        {alreadyOn ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Check className="h-3.5 w-3.5" /> Already on
          </p>
        ) : canActivate ? (
          <Button
            size="sm"
            variant={ready ? "default" : "outline"}
            disabled={disabled || busy || blockers.some((b) => b.kind === "missing")}
            onClick={onActivate}
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Setting up…
              </>
            ) : (
              "Turn this on"
            )}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface ReceiptStep {
  step: string;
  ok: boolean;
  detail: string;
  /** Rendered right after the detail, for the identifier of what was made. */
  link?: { to: string; label: string };
  /** Words that follow the link, when the sentence carries on past it. */
  after?: string;
}

interface ReceiptContent {
  title: string;
  steps: ReceiptStep[];
}

function activationReceipt(result: StarterActivationResult): ReceiptContent {
  return {
    title: result.ranOnce ? "Set up, and it has already run once" : "Set up",
    steps: result.steps,
  };
}

function firstLineOf(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? text.trim();
}

function mintRequestKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * What actually happened, step by step. The point of this panel is that
 * switching something on, or accepting a plan, produces a visible result the
 * same minute, so it reports each step rather than closing and leaving the
 * user to guess.
 */
function Receipt({
  content,
  onDismiss,
}: {
  content: ReceiptContent;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-accent/40 px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4" />
          {content.title}
        </p>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      <ul className="mt-2 space-y-1">
        {content.steps.map((step, i) => (
          <li
            key={`${step.step}-${i}`}
            className={cn(
              "text-xs",
              step.ok ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400",
            )}
          >
            {step.ok ? "✓" : "!"} {step.detail}
            {step.link ? (
              <Link to={step.link.to} className="underline">
                {step.link.label}
              </Link>
            ) : null}
            {step.after ?? null}
          </li>
        ))}
      </ul>
    </div>
  );
}
