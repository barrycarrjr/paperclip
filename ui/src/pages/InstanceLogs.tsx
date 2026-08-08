import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Pause, Play, ScrollText, Search, X } from "lucide-react";
import type { ServerLogEntry, ServerLogLevel } from "@paperclipai/shared";
import { instanceLogsApi } from "@/api/instanceLogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import {
  formatLogDay,
  formatLogTime,
  levelBadgeClass,
  levelToneClass,
  logDayKey,
} from "../lib/server-log-view";

/** How often the page asks for new lines while it is live. */
const POLL_MS = 2000;
/** Typing in the search box should not put a request on every keystroke. */
const SEARCH_DEBOUNCE_MS = 300;
/** Treated as "the operator is watching the bottom" for auto-scroll. */
const STICK_TO_BOTTOM_SLACK_PX = 120;

const LEVEL_CHOICES: { label: string; value: ServerLogLevel | "all"; hint: string }[] = [
  { label: "Everything", value: "all", hint: "Every line, including debug" },
  { label: "Info", value: "info", hint: "Info and above" },
  { label: "Warnings", value: "warn", hint: "Warnings and errors only" },
  { label: "Errors", value: "error", hint: "Errors only" },
];

function LogRow({ entry }: { entry: ServerLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const detailKeys = Object.keys(entry.detail);
  const hasDetail = detailKeys.length > 0;

  return (
    <div className="border-b border-border/40 last:border-b-0">
      <div
        className={`flex items-start gap-3 px-3 py-1.5 font-mono text-xs leading-relaxed ${
          hasDetail ? "cursor-pointer hover:bg-muted/40" : ""
        }`}
        onClick={hasDetail ? () => setExpanded((open) => !open) : undefined}
        role={hasDetail ? "button" : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        onKeyDown={
          hasDetail
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setExpanded((open) => !open);
                }
              }
            : undefined
        }
        aria-expanded={hasDetail ? expanded : undefined}
      >
        <ChevronRight
          className={`mt-0.5 h-3 w-3 shrink-0 text-muted-foreground transition-transform ${
            hasDetail ? "" : "invisible"
          } ${expanded ? "rotate-90" : ""}`}
        />
        <span className="shrink-0 tabular-nums text-muted-foreground">{formatLogTime(entry.timeMs)}</span>
        <span
          className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${levelBadgeClass(
            entry.level,
          )}`}
        >
          {entry.level}
        </span>
        {entry.service ? (
          <span className="shrink-0 max-w-[10rem] truncate text-muted-foreground" title={entry.service}>
            {entry.service}
          </span>
        ) : null}
        <span className={`min-w-0 flex-1 break-words ${levelToneClass(entry.level)}`}>{entry.msg}</span>
      </div>

      {expanded && hasDetail ? (
        <pre className="overflow-x-auto border-t border-border/40 bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {JSON.stringify(entry.detail, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

export function InstanceLogs() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [live, setLive] = useState(true);
  const [minLevel, setMinLevel] = useState<ServerLogLevel | "all">("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(200);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the operator is parked at the bottom watching new lines arrive, or
  // has scrolled up to read something. Auto-scroll must never yank the page
  // out from under them mid-read.
  const stickToBottom = useRef(true);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "Logs" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchDraft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  const query = useQuery({
    queryKey: queryKeys.instance.logs({ limit, level: minLevel, search }),
    queryFn: () =>
      instanceLogsApi.get({
        limit,
        minLevel: minLevel === "all" ? undefined : minLevel,
        search: search || undefined,
      }),
    refetchInterval: live ? POLL_MS : false,
    // Without this the list blanks out on every filter change, which reads as
    // a broken page when the operator is only narrowing a search.
    placeholderData: (previous) => previous,
  });

  const entries = useMemo(() => query.data?.entries ?? [], [query.data]);

  // Layout effect so the scroll lands before the browser paints; in an effect
  // the page visibly jumps.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [entries]);

  function onScroll() {
    const node = scrollRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottom.current = distanceFromBottom <= STICK_TO_BOTTOM_SLACK_PX;
  }

  const isForbidden = query.error instanceof Error && /403|admin/i.test(query.error.message);

  return (
    <div className="flex h-full min-h-0 max-w-6xl flex-col gap-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Logs</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          What this Paperclip server is writing as it runs, newest at the bottom. Useful for seeing what happened
          overnight, when nobody was watching. Anything that looks like a password or token is replaced before it
          reaches this page.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {LEVEL_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              title={choice.hint}
              onClick={() => setMinLevel(choice.value)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                minLevel === choice.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {choice.label}
            </button>
          ))}
        </div>

        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Search messages and detail"
            className="pl-8"
            aria-label="Search the log"
          />
          {searchDraft ? (
            <button
              type="button"
              onClick={() => setSearchDraft("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        <Button variant={live ? "default" : "outline"} onClick={() => setLive((on) => !on)}>
          {live ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {live ? "Live" : "Paused"}
        </Button>
      </div>

      {query.error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {isForbidden
            ? "Only instance admins can read the server log."
            : query.error instanceof Error
              ? query.error.message
              : "Failed to load the log."}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card"
      >
        {query.isLoading ? (
          <div className="px-3 py-6 text-sm text-muted-foreground">Reading the log...</div>
        ) : query.error && entries.length === 0 ? (
          // Never claim an empty result when the request itself failed: the
          // banner above says what went wrong, and "nothing matches" alongside
          // it reads as an answer rather than a failure.
          <div className="px-3 py-6 text-sm text-muted-foreground">
            Could not read the log, so there is nothing to show.
          </div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-6 text-sm text-muted-foreground">
            {search || minLevel !== "all"
              ? "Nothing in the log matches that. The search only covers what is still on disk, and the log is size-capped."
              : "Nothing has been written to the log file yet."}
          </div>
        ) : (
          entries.map((entry, index) => {
            const previous = index > 0 ? entries[index - 1] : undefined;
            const startsNewDay = !previous || logDayKey(previous.timeMs) !== logDayKey(entry.timeMs);
            return (
              <div key={entry.seq}>
                {startsNewDay ? (
                  <div className="sticky top-0 z-10 border-b border-border bg-muted/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                    {formatLogDay(entry.timeMs)}
                  </div>
                ) : null}
                <LogRow entry={entry} />
              </div>
            );
          })
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {entries.length} {entries.length === 1 ? "line" : "lines"}
          {query.data?.files.length ? ` from ${query.data.files.join(", ")}` : ""}
          {query.data?.truncated ? " (there is more history than this)" : ""}
        </span>
        {limit < 1000 ? (
          <Button variant="outline" size="sm" onClick={() => setLimit((value) => Math.min(value * 2, 1000))}>
            Show more
          </Button>
        ) : null}
      </div>
    </div>
  );
}
