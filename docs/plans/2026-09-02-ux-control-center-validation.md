# UX control center — acceptance and verification

Created: 2026-09-02. [Project entry point](2026-09-02-ux-control-center.md).

Current application acceptance status: **not run for the new UI; implementation has not started**.

## Test boundaries

Use three separate evidence categories:

1. **Historical audit:** existing app navigation/source observations, with limitations retained in the archived audits.
2. **Mockup:** local sample-data behavior only. The latest concept previously passed 545 JavaScript/DOM assertions with zero reported runtime errors; desktop/compact layouts were sampled in light/dark rendering. This is not an application integration result, a complete browser matrix, or proof of operational side effects.
3. **Implemented app:** actual unit/integration/browser/manual results on a recorded commit/working tree and instance. Only these count toward release acceptance.

Use isolated test fixtures or mock providers for sends, calls, public replies, uploads, approvals, task creation, agent invocations, scheduled callbacks and lifecycle changes. For live-instance tests, obtain an explicit safe target/action agreement first. Never use customer data or a live database for destructive or automated fixture tests. Do not fill empty live views by manufacturing work.

## Acceptance checklist

All checks below start **pending**. Record per-check results in the handoff ledger; mark a deferral only with its reason and Barry's agreement.

| ID | Scenario and expected result | Features |
|---|---|---|
| A01 | Switch company while in Email; stay in Email, show full new company/mailbox identity, clear old record selection and stale responses | F01, F05 |
| A02 | Collapse navigation; use another company's Email hover shortcut, keyboard equivalent, and touch/click equivalent; explicit target wins over memory, no double prefixes | F01, F29 |
| A03 | Navigate between Portfolio and HQ team; aggregate data and HQ-owned work are clearly distinct; a creation form from Portfolio requires a target | F02, F19 |
| A04 | Open legacy core/plugin/Clippy deep links with query/hash, reload and use back/forward; correct scope/path/breadcrumb with no redirect loop | F01, F10, F29 |
| A05 | Expand nested mail folders, select a path, resize/collapse/reopen folders independently of main nav; open reader/full-size and return without losing safe context | F05, F06 |
| A06 | Search, unread/all, sender groups, selection/bulk controls and moves work with real provider semantics; read state does not imply resolved or delegated | F06, F08 |
| A07 | Compose/reply/reply-all/forward and AI Draft/Revise retain instructions/model/attachment controls; visible sender/recipient/company; draft survives safe view transitions; action failure is actionable | F07, F30 |
| A08 | Help Scout reply and private note are unmistakably different; mailbox/status/rule/bulk/attachment behavior preserved | F09, X05 |
| A09 | Existing email handoff chooses an eligible company agent, links the work and reports partial failure; if P5a is implemented, follow With agents → progress → human review/takeover with durable source identity | F08, P5a |
| A10 | Calendar month/list, company/portfolio scope, event kind/all-day/timezone/once/repeat/cron, Slack target/desktop/lead time; notification time distinguished from event time | F12 |
| A11 | Toggle routine layer, inspect grouped frequent schedules, and open the real routine; no false Google/Outlook readiness | F13, F17 |
| A12 | Find a company's agents, see current work/next-action owner, filter/list/org/zoom/fit, then inspect instructions/skills/runs/config/budget/channels without losing context | F20–F22 |
| A13 | Tasks list/board/nesting/filter/sort/group/fields plus full detail/properties/reviewers/approvers/relationships/docs/attachments/history remain functional | F14, F15 |
| A14 | Open project and goal detail, including workspace/budget/configuration; keep distinct task/project/goal semantics and source links | F16 |
| A15 | Automation instructions, variables/default/type/required, schedule/event triggers, delivery/missed-run policy and run history; queues and broadcasts retain their separate lifecycle/targeting | F17–F19 |
| A16 | Traverse all Phone subviews; preserve shared-PBX versus company identity, custom date/extension filters, assistant call/test/transfer controls and guardrails | X01, X02, F22 |
| A17 | Reach notes, private To-dos, memories and skills; verify scopes, autosave/capture, original-preserving conversion and explicit promotion visibility | F23–F25 |
| A18 | Every catalog/pin/search destination matches installed routes/capabilities; no feature disappears; tool-only plugins are not fabricated pages | F29, X01–X11 |
| A19 | Open Clippy from each primary workspace; resize, switch chats, preserve per-chat drafts/scope, inspect history/filter/model/effort/permissions, open full page/pop-out and return | F10, F11 |
| A20 | Pending Clippy actions show exact target/action; approve/decline/read-only/stream/stop/interrupted/failed states obey real policy and do not silently retarget on company switch | F11 |
| A21 | Unsaved email/task/event/chat state during company or workspace change is preserved with original scope or explicitly confirmed; no silent discard/retarget | F01, F07, F10, F12, F15 |
| A22 | Attention/Overview/Team distinguish actual work, watching, waiting, review, pause and failure from source evidence; outcomes reconcile and diagnostic details remain accessible | F03, F04, F20, F26 |
| A23 | Empty, loading, disabled, unconfigured, permission-limited and failed plugin/page states are distinct; preserve navigation and recovery; no error object rendered as success data | F28, F29, X01–X11 |
| A24 | On desktop and narrow screens, no accidental clipping, overlapping actions or inaccessible third pane; Email and Clippy reachable; keyboard/focus/Escape/labels/touch usable | All changed UI |
| A25 | Company authorization, private data isolation, atomic checkout, single-assignee ownership, approval gates, budgets, audit logging and privacy/telemetry invariants still pass | All integrations |
| A26 | Barry completes a normal local operating session, identifies scope/agents/attention and starts work without internal jargon; records explicit satisfaction and remaining agreed deferrals | Entire project |

## Minimum regression matrix

- Scope: Portfolio, HQ, at least two operating companies, Personal/private, a company without a configured mailbox/plugin, shared service, instance settings.
- Workspace state: populated, truly empty, loading, failed, unavailable/unconfigured, permission denied; refresh and late old-scope response.
- Navigation: expanded/collapsed sidebar, expanded/collapsed/resized local pane, deep link, reload, browser back/forward, current versus remembered location.
- Screen: desktop 1280/1440 where available, 1024, compact 736, narrow 360; light/dark, keyboard and pointer/touch-equivalent paths. Use actual viewport tests, not scaled-down screenshots.
- Lifecycle: before/after background updates, active run versus watcher, reviewed versus unread, draft versus sent, partial API failure, interruption and duplicate submission.
- Plugin: all 11 installed families, including non-UI capabilities and current installed version/readiness.

## Verification commands and relevant tests

Commands are read from current repository scripts but **not executed during planning**. Run from the repo root; record the exact command, environment and result. Recheck scripts if the branch has advanced.

Small UI/routing regression selection:

```powershell
pnpm exec vitest run ui/src/lib/company-routes.test.ts ui/src/hooks/useCompanyPageMemory.test.ts ui/src/context/CompanyContext.test.tsx
pnpm exec vitest run ui/src/components/Layout.test.tsx ui/src/components/Sidebar.test.tsx ui/src/components/CommandPalette.test.tsx
```

Also extend/use affected Email action/header/popout, Help Scout compose/attachments/pane-layout, Clippy conversation/permission/stream, Calendar event/month, Inbox, IssuesList, IssueDetail, OrgChart and routine tests. Existing tests are a starting point; add cases for new contracts, scope transitions, hidden controls and regression reports.

Run UI typechecking after coherent UI slices:

```powershell
pnpm --filter @paperclipai/ui typecheck
```

The ordinary repo test path is `pnpm test` (Vitest, not browser suites). The current full-test wrapper creates isolated test instance directories. Confirm isolation before any server/integration test; do not pass Barry's live instance overrides into tests.

Before broad completion / publication readiness:

```powershell
pnpm -r typecheck
pnpm test:run
pnpm build
```

Browser verification is necessary for this navigation/interaction change. Inspect suite configuration and target instance before running `pnpm test:e2e`; select or add the relevant scenarios against safe fixtures. The release-smoke suite is opt-in for release-flow work, not a default planning or UI test. On Windows, apply the documented direct Node/Vite workaround if needed and report exactly what was/was not verified.

Do not weaken tests, hide genuine failures, or equate a green targeted subset with a green full suite. Baseline failures need separate evidence and an agreed disposition.

## Barry's daily-use trial

Have Barry operate Email, support, Calendar and a company team; switch companies repeatedly; use Clippy; find a less-used plugin/work detail; and inspect attention/agent progress. Observe misnavigation, hidden functionality and scope uncertainty rather than measuring only click counts.

For each feedback item record the current branch/commit, reproduction, expected behavior, affected feature/acceptance IDs, correction and confirmation. No push or PR is triggered automatically by completing this checklist.
