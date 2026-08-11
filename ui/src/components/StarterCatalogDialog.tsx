import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plug, Sparkles } from "lucide-react";
import {
  starterCatalogApi,
  type StarterActivationResult,
  type StarterCardStatus,
} from "../api/starterCatalog";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * "What do you want done?" — the way into the starter catalog.
 *
 * One panel, two ways in, stacked. A text box on top for the person who
 * already knows what they want and would rather type it; the browsable
 * categories underneath for the person who does not know what is possible,
 * which is the more important of the two. Same panel for the beginner and
 * the expert.
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
  const [result, setResult] = useState<StarterActivationResult | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.starterCatalog.list(companyId),
    queryFn: () => starterCatalogApi.list(companyId),
    enabled: open && !!companyId,
  });

  const activate = useMutation({
    mutationFn: (cardId: string) => starterCatalogApi.activate(companyId, cardId),
    onMutate: (cardId) => {
      setActivatingId(cardId);
      setFailure(null);
      setResult(null);
    },
    onSuccess: (res) => {
      setResult(res);
      queryClient.invalidateQueries({ queryKey: queryKeys.starterCatalog.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(companyId) });
    },
    onError: (err) => {
      setFailure(err instanceof Error ? err.message : String(err));
    },
    onSettled: () => setActivatingId(null),
  });

  // Filtering happens here rather than round-tripping per keystroke; the
  // catalog is small and the server search endpoint exists for callers that
  // need the same ranking without the full list.
  const visible = useMemo(() => {
    const all = data?.cards ?? [];
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
    if (words.length === 0) return all;
    return all.filter((entry) => {
      const tokens = [entry.card.title, ...entry.card.matches].join(" ").toLowerCase();
      return words.some((w) => tokens.includes(w));
    });
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

  const nothingMatched = query.trim().length > 0 && visible.length === 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogTitle className="text-base">What do you want done?</DialogTitle>

        <div className="space-y-1">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type it however you'd say it out loud"
            aria-label="What do you want done?"
          />
          <p className="text-xs text-muted-foreground">
            Or browse what this company can switch on below.
          </p>
        </div>

        {result && <ActivationReceipt result={result} onDismiss={() => setResult(null)} />}

        {failure && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
            {failure}
          </p>
        )}

        {isLoading && (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        )}

        {nothingMatched && (
          // Never a dead end: the design's rule is that nobody is stuck
          // because they used a word the catalog doesn't know.
          <div className="rounded-md border border-border px-3 py-3 text-sm">
            <p className="font-medium">Nothing here matches that yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing in the catalog covers "{query.trim()}". Ask the CEO agent for it
              directly and it can work out who should do it.
            </p>
          </div>
        )}

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
                      disabled={activate.isPending}
                      onActivate={() => activate.mutate(entry.card.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CatalogCard({
  entry,
  busy,
  disabled,
  onActivate,
}: {
  entry: StarterCardStatus;
  busy: boolean;
  disabled: boolean;
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
                ? `${b.pluginKey} isn't installed — install it on the Plugins page first`
                : `${b.pluginKey} is switched off — turning this on will switch it back on`}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto pt-1">
        {alreadyOn ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Check className="h-3.5 w-3.5" /> Already on
          </p>
        ) : (
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
        )}
      </div>
    </div>
  );
}

/**
 * What actually happened, step by step. The point of this feature is that
 * switching something on produces a visible result the same minute, so the
 * panel reports each step rather than closing and leaving the user to guess.
 */
function ActivationReceipt({
  result,
  onDismiss,
}: {
  result: StarterActivationResult;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-accent/40 px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4" />
          {result.ranOnce ? "Set up, and it has already run once" : "Set up"}
        </p>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      <ul className="mt-2 space-y-1">
        {result.steps.map((step, i) => (
          <li
            key={`${step.step}-${i}`}
            className={cn(
              "text-xs",
              step.ok ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400",
            )}
          >
            {step.ok ? "✓" : "!"} {step.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}
