# Team: a live operations console for the AI team

Written 2026-09-09, branch `team-operations-console`.

Barry brought four mockups showing a card grid, a table, a member detail page and a Gantt-style
timeline, with a note that the mockups were written by an assistant that did not know how Paperclip
works. He also said the real problem in his own words: some work he does by hand in Paperclip, like
reading and answering email, and some he wants agents to do, and for the agent half he does not yet
feel he has **insight and control**.

This file records what was built, what was deliberately not built, and where the app still cannot
answer a question the mockups asked.

## What is on screen now

| Where | What |
|---|---|
| `/team` | Five clickable summary tiles, a card grid or a table of the same rows, search, state filters, and per-member controls. |
| `/team/timeline` | New tab. One row per member, bars for runs, over the last hour / 2 hours / today / 24 hours. |
| `/agents/<one agent>` (Current work tab) | New panel above the existing charts: current task, live activity, recent outputs, what it can use, and how it has been getting on. |

Nothing moved and nothing was removed. The roster, org chart, assistants list and every tab on an
agent's own page are exactly where they were.

## The three things the mockups asked for that the app cannot honestly do

**Progress percentages.** Every card and every row in the mockups carries a percentage and a
progress bar. Paperclip has no total to measure a run against, so any number there would be
invented. What the app really knows is when the run started, when the agent last did something
real, and whether the run has gone quiet, and all three are shown instead. The quiet warning
(`lib/run-now-line.ts`) is the one that matters most: it is the signal a fake percentage would have
hidden, because a stuck run at "68%" looks healthy.

**Per-member connected tools.** The mockups show GitHub, Jira and Slack chips on each card. In
Paperclip those are add-ons installed for a whole company, not access granted to one agent, so a
per-member list of them would state something about permissions that is not true. The cards show
the provider the member runs on. The member's own page shows its skills, which is the real
per-agent grant.

**Idle versus paused, historically.** The timeline draws runs, because runs are what the database
records. There is no history of an agent's status, so the app cannot say whether a gap at 11:20 was
an agent with no work or an agent that was paused at the time. A gap therefore means one thing,
"nothing was running", and the page says so in those words. The single exception is a member paused
right now, because `agents.paused_at` records the moment; that is drawn as a band to the right-hand
edge and nothing more is claimed.

## The two backend changes, and why they were worth making

### 1. Saying why an agent stopped

An agent in an error state used to read "Stopped with an error." and nothing else, on both the
list and its own page. That is the least useful card on the screen and it is exactly the question
Barry says he cannot answer today.

The app does record the reason; it was just not on the routes the screens read. Three places hold
it and any of them can be empty: `agent_runtime_state.last_error`, the failed run's own
`heartbeat_runs.error`, and now the roster. So:

- `GET /companies/:id/agents` gained `lastError` and `lastRunStatus`, from one extra query over
  `agent_runtime_state` (indexed on company_id, agent_id) left-joined to the run it points at.
  The runtime row's own message is preferred; the run's is the fallback, because in practice the
  runtime row is often empty and the run is not.
- Both fields are appended **only** for viewers who may read configurations. An adapter's error
  text can carry paths and internals, and a restricted viewer still sees the state without the
  message. There is a test for that.
- The agent's own page needs no new request: it already loads its runtime state and its runs, so
  it falls back through the same three sources locally.
- When nothing recorded a reason the row says "No reason was recorded." rather than sending you
  somewhere. The earlier wording told you to open the agent's page, which was silly on the agent's
  page.

Verified against real data on 2026-09-09: an M3 Media agent that had been sitting in an error
state now reads "Claude run failed ... Failed to authenticate: OAuth session expired and could not
be refreshed" on both surfaces. **That is a live problem on Barry's instance, not a test case.**

### 2. Bounding the timeline's read to the window it draws

The timeline first asked for "the newest 500 runs" and filtered them in the browser. Measured on
M3 Media that was **1,283 KB per request, repeating every 30 seconds** while the tab was open, to
draw a handful of bars. Worse, it was quietly wrong in the making: a company busy enough to do 500
runs inside the window would have had the chart cut off with nothing saying so.

`GET /companies/:id/heartbeat-runs` now takes `since`, an ISO timestamp, and the timeline passes
the left edge of whatever window is on screen. Same view, **34 KB** instead of 1,283 KB.

The subtlety worth keeping: `since` does NOT mean "created after". It means "was still going at or
after", so it keeps a run that started three hours ago and finished twenty minutes ago, and a run
that started this morning and has not finished. Filtering on creation time alone would drop both,
and drop them silently. There is a test with all four cases.

Two smaller things went with it: the timestamp sent is rounded down to five minutes so a clock
ticking every thirty seconds does not invalidate the query every thirty seconds, and a `since` that
is not a date is answered with a 400 rather than ignored, because ignoring it would return the whole
history to a caller that asked for a slice.

## What was added rather than restyled

**"Ready for review" is a new state.** The right-now view previously had seven states and none of
them covered the most common way work stalls: the agent finished, handed the task back, and the
task sits in `in_review` waiting on a person. Such a member used to read "Nothing running", which is
true and useless. It now reads "Finished and handed the work back to you" and sorts near the top.
A member that is busy but also has finished work waiting says so as a second line rather than
losing its state. See `lib/team-current-work.ts`.

**Controls next to the work.** Every list row and the member's own page carry the same control
strip: the one button on show is whatever that member's state says the next move is (Answer,
Review, Stop, Resume or Wake), with the rest behind the menu. All of these already existed on the
agent's own page; none of them is new behaviour. This is the "control" half of Barry's sentence, and
it was the half the mockups underweighted: they show play/pause/stop, but the moves that actually
unblock work are answering a question and reviewing finished work.

**Health from run history.** Success rate, typical run length, failures and last success are
counted from the member's own runs over a stated seven-day window (`lib/agent-health.ts`). Two
choices worth knowing: a run somebody stopped by hand is counted separately and is NOT a failure,
and the duration reported is the middle run rather than the average, so one four-hour wait on a rate
limit does not move it. With nothing to count it says "not enough to go on" rather than "0%".

## Naming

Barry asked that "Agents" become "Team" everywhere. Most of that was already true: the section is
Team, there is no parallel Agents area, and every new view here is Team-first. The word "agent" was
kept for an individual worker, because it is the word used by the API, the routes (`/agents/...`),
the CLI, the docs and every add-on. Renaming only the labels would leave the screen disagreeing with
the address bar and with every other surface, which is the thing
`docs/plans/2026-09-07-mockup-vs-app.md` (difference 2) already warns about for the other pending
renames. If the rename is wanted it should be done as one pass across all layers, not started here.

## A routing trap for whoever adds the next Team tab

The timeline lives at `/team/timeline`, not `/team/activity`, and the reason is not taste. The app
decides whether the first segment of an address is a company code by asking whether the SECOND
segment is a known top-level page (`lib/company-routes.ts`, `toCompanyRelativePath`). "activity" is
a top-level page, so `/team/activity` reads as company "team" showing the Activity page, and the tab
never lights up. A sub-path under `/team` must not be the name of a top-level page. This is written
into `lib/team-tabs.ts` beside the constant as well.

Related, and left alone deliberately: `toCompanyRelativePath` will strip a first segment that is
itself a reserved top-level page, while `extractCompanyPrefixFromPath` in the same file guards
against exactly that. The two disagree. No address in the app trips over it today, so it was not
changed as part of this work, but it is a real inconsistency and it is what caused the trap above.

## Files

New: `lib/team-timeline.ts`, `lib/agent-health.ts`, `hooks/useTeamMemberActions.ts`,
`components/TeamSummaryTiles.tsx`, `TeamMemberCard.tsx`, `TeamMemberTable.tsx`,
`TeamMemberControls.tsx`, `TeamActivityTimeline.tsx`, `AgentCurrentWork.tsx`, plus tests for the
three libraries and the console.

New: `lib/agent-activity-filter.ts`.

Changed: `lib/team-current-work.ts` (new state, new fields, the error reason), `lib/team-tabs.ts`
(sub-path tabs), `lib/status-colors.ts` (dots and card edges), `components/TeamCurrentWork.tsx`
(now the console), `components/MetricCard.tsx` (a clickable tile is a real button now, not a div),
`pages/Team.tsx`, `pages/AgentDetail.tsx`, `App.tsx`, `api/heartbeats.ts`, plus on the server
`packages/shared/src/types/agent.ts`, `server/src/routes/agents.ts` and
`server/src/services/heartbeat.ts`.

## Checked in a browser against real data, 2026-09-09

Signed in on the local instance at `http://paperclip.local:3100`, which serves the UI straight
from source, so no separate dev server is needed to see changes.

- **HQ (2 agents)** and **M3 Media (9 agents)**, cards and table. Summary tiles, chips, search, the
  view switch and the sort all behave. Rows arrive urgency-first: ready-for-review, then error,
  then paused, then waiting, then nothing-running.
- **Controls** offer the right move per row without being told: Review on the agent holding
  finished work, Wake on an idle one, Resume on the paused one.
- **Timeline** over 24 hours drew real runs with their task identifiers (HQ-322, HQ-323, HQ-324)
  and reported "19m across 3 runs". Short runs become slivers on a day-wide window, which is
  honest; they keep a minimum width so they stay clickable, and the tooltip carries the label.
- **Agent page** showed the current state, a real activity stream, the notes its last run wrote,
  its skills, and seven-day health (12 runs, 91%, typical run 4m 56s, last failure 4d ago).
- **Narrow (390px)**: no page-level horizontal scroll on any of the three views. The table scrolls
  inside its own box by design.

One defect found and fixed during that pass: the agent's activity stream was half workspace-lease
bookkeeping, two entries per run, which pushed the real events off the panel. Those two actions are
now filtered out on the agent's page only (`lib/agent-activity-filter.ts`); the Activity page still
shows everything, and if bookkeeping is genuinely all an agent has, it is shown rather than
pretending the agent has done nothing.

## Still to do

- Filters the mockups list that are not built: by team/department, by project, by tool/provider.
  Search covers the names and the work; the rest are worth adding only if the plain filters turn
  out not to be enough.
- Nothing is committed. The branch is `team-operations-console`, off master.
