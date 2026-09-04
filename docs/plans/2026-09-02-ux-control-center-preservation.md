# UX control center — feature preservation contract

Created: 2026-09-02. [Project entry point](2026-09-02-ux-control-center.md).

Status for every feature below: inventoried, not yet implementation-verified. This is a contract, not a claim of end-to-end testing. Reconcile it with actual routes, plugin manifests, and the two archived audits before each affected phase.

## Core surfaces

| ID | Surface → new home | Must remain usable |
|---|---|---|
| F01 | Shell / scope | Company rail, hover flyouts, main hamburger, company/account menus, explicit full name, route/query/hash compatibility, browser back/forward, keyboard/touch access |
| F02 | Portfolio and HQ | Portfolio Brief, Email, Calendar, Agents, Issues, Directives, Routines, Approvals, Activity, Receipts, Costs; HQ's own company work stays separate |
| F03 | Brief → Overview | Company/portfolio summaries, meaningful live work, latest outcomes and links; actual data and honest loading/error states |
| F04 | Inbox / approvals → Attention | Mine/All, issue/join/approval/failure categories, approval state, snoozing/attention handling where present, filters and source-record navigation |
| F05 | Company / portfolio Email | Mailbox selection, provider/source identity, nested folder paths/labels, independently collapsible/resizable folder pane, list/reader/full-size transitions |
| F06 | Email list operation | Search, unread/all, sender grouping, sorting, individual/group/bulk selection and triage, moves, read states, attachments, printing, hover controls and visible alternatives |
| F07 | Email composition | Compose, reply, reply-all, forward, attachments, AI Draft/Revise, separate AI instructions and model selection, sender/recipient identity, validation and actionable failures |
| F08 | Email delegation / rules | Real agent handoff, eligible company agents, outcome note, resulting work link, wake failure feedback, durable keep/triage rules and disclosed side effects |
| F09 | Help Scout | Shared mailbox selection, Open/Active/Pending/Closed/Spam, public reply versus private note, drafts, attachments, AI controls, keep-active/auto-noise rules, bulk controls |
| F10 | Clippy | Persistent launcher, resize/collapse drawer, full page, pop-out, recent chats, active/archived/all and company/group/sort filters, conversation menus, attachment controls |
| F11 | Clippy execution UI | Model/effort/permission controls, pending badge, exact permission action, expandable tool input/result, streaming/stop/failure/interruption, independent chat scope and drafts |
| F12 | Calendar | Company/portfolio month and list, reminder/appointment/deadline kind, date/time/all-day/timezone, once/repeats/cron, notes, desktop/Slack targets, lead time, status and detail |
| F13 | Calendar automation layer | Paperclip/routine source toggles, occurrence versus notification time, grouped repeated runs, route from occurrence to real routine; do not invent connector readiness |
| F14 | Issues → Work / Tasks | List/board, parent-child nesting, sort/group, filters, visible fields, card fields, status/priority/assignee/creator/project/labels, routine-run and live filters where present |
| F15 | Task creation and detail | IDs, full description, single accountable assignee, separate reviewers/approvers, parent/blocker/related work, tags/dates, properties pane, comments/chat, documents/revisions, attachments, history |
| F16 | Projects / Goals | Separate lifecycles, overview/detail/configuration/budget, goal/subgoal hierarchy, work links, project workspaces and advanced execution environment detail |
| F17 | Routines → Work / Automations | Company/portfolio lists, instructions, variables (type/default/required), schedule/event/API triggers, timezone, enable/pause state, delivery/coalescing/missed-run policy, runs and linked issues |
| F18 | Work Queues → Intake queues | Queue name/slug/description, incoming items, pending/claimed/completed/failed/cancelled semantics and linked work; not an alias for tasks |
| F19 | Directives → Broadcasts | Explicit target companies, previews, per-company work creation and execution tracking; no accidental portfolio-wide execution |
| F20 | Agents → Team | Company/portfolio list and filters, org tree/zoom/fit, reporting relationships, statuses, objectives, current task, next-action owner, individual agent navigation |
| F21 | Agent depth | Instructions (managed/external files, root/entry/tree), skills, configuration/adapters/models, budgets, channels, runs/transcripts/diagnostics, lifecycle controls with existing protections |
| F22 | Assistants | Distinct directory/builder, persona/behavior/guardrails/channels/voice/number/testing; configured Phone tab and real call/transfer forms remain reachable |
| F23 | Memories / skills → Knowledge | Memory categories (user, feedback, project, reference), company-wide/agent scope, company skill library and assignment; not personal note storage |
| F24 | Notepad → Company notes | Draft/converted/archived views, autosave semantics, preview conversion with optional AI expansion, original retention and resulting work link |
| F25 | To-dos → My to-dos | User-private across companies, capture/due/completion/reordering, explicit promotion target and visibility preview; capture must not start agents |
| F26 | Receipts / activity / usage | Outcome types/source links and aggregation limits, raw activity and run diagnostics, costs/budgets/quotas/providers/billers/finance; zero price is not zero usage |
| F27 | Company administration | Identity/branding, access/members/invites/secrets, import/export, skills/cost entry points, archived-company management and safeguards |
| F28 | Instance administration | Profile/access, outbound policy, identity safeguards, retention, heartbeats, templates, adapters/default models, external MCP, experiments, logs/roadmap, lifecycle controls |
| F29 | Navigation completeness | All installed UI contributions, catalog/pins/search, correct scope/readiness, old deep links, disabled experimental entry points and recovery paths |
| F30 | Fork-specific behavior | Transcript `tool_group`/`stderr_group`, readable latest-run excerpt, action failure feedback, existing privacy/no-phone-home behavior; do not regress newer fork changes |

## Installed plugin families

Audit-time source location: sibling repository `~/paperclip-extensions`. Its presence and installed-runtime wiring must be rechecked. A Paperclip branch does not branch or deploy that repository. No extension changes/releases are authorized by creating this plan.

| ID | Plugin | Preserve / placement |
|---|---|---|
| X01 | 3CX | Phone: Active calls, Parked calls, Queues, People/presence, Wallboard, Call history, Recordings, Daily report, DIDs/inbound numbers, Extensions, Trunks. Preserve date/extension filters and company-routing/shared-account distinctions. |
| X02 | Phone / AI calls | Phone: Assistants, Campaigns and portfolio rollup, Inbound routes, Do-not-call, Audit log. Assistant Phone tab: call objective/recipient/name/image context/spend cap, test call, warm-transfer number/spoken line/project linkage. |
| X03 | GBP Reviews | Portfolio/location summary and widget, review ingestion, agent reply tools. Current summary is not already a human reply editor. |
| X04 | Email Tools | Email provider operations and durable handling rules; credentials/connections stay in administration. |
| X05 | Help Scout | Preserve its conversation semantics and human support controls; do not represent all support states as IMAP folders. |
| X06 | Notepad | Company capture and conversion, enabled-company availability. |
| X07 | To-dos | Private user capture, independent of the active company. |
| X08 | Backups | Instance schedules, destinations, history and restore UI with safeguards; no restore/reset while evaluating UX. |
| X09 | Slack Tools | Discoverable agent/Clippy capabilities and connection administration; no fabricated operator page. |
| X10 | Print Tools | Discoverable action capability and real existing contributions; no accidental print jobs. |
| X11 | Code Scanner | Discoverable analysis capability and real existing contributions; do not invent unsupported UI. |

## Cross-cutting invariants

1. Company-scoped access checks, query keys and action targets remain authoritative. Personal/shared/instance scopes must not be mislabeled as company-local.
2. Single-assignee task ownership, atomic checkout conflicts, review/approval participants, budget hard stops, and mutation audit logging remain unchanged unless separately specified and verified.
3. Provider-specific attachments, mail state, sender rules, notifications, and call permissions cannot be replaced by generic callbacks that silently lose behavior.
4. Every empty, disabled, unconfigured, permission-denied, failed, and loading state remains distinguishable. Preserve errors and recovery paths.
5. Disclosures are accessible without hover alone. Focus, Escape, keyboard activation, dialog focus return, labels, and touch targets must work.
6. Existing deep links and long-running background activity remain usable while the shell changes. Never execute sample actions against live systems to fill a mockup state.
7. Existing functionality is necessary but not sufficient: test discoverability and current-company understanding with Barry's real workflow.

## Observed gaps to revalidate, not blindly patch

| ID | Historical observation | Required handling |
|---|---|---|
| B01 | Hover Personal → Email produced `/PER/PER/notepad`; company switch also produced `/IND/IND/clippy` | Reproduce on baseline, cover plugin route normalization and memory/shortcut precedence before changing helpers |
| B02 | Full Clippy retained previous page breadcrumb | Recheck page/breadcrumb registration and navigation lifecycle |
| B03 | Campaign rollup returned `Campaign portfolio-rollup not found.` and later a render fallback | Recheck route registration and refresh error handling; extension-repo scope may be needed |
| B04 | Personal Recordings returned `ECOMPANY_NOT_ROUTED` | Treat as configuration readiness, not automatically a software defect or zero activity |
| B05 | Daily report loading; Export/Roadmap blank; experimental workspace redirect | Recheck availability and render behavior; record unresolved cases honestly |
| B06 | Search/mobile navigation omitted Email or plugin workspaces | Include in shell/search/mobile acceptance |
| B07 | Repeated silent-run review entries crowded meaningful work | Use actual liveness/outcome semantics; no blanket hiding of true failures |

Historical source-only/unverified areas: live Clippy tool/permission streams and pop-out window rendering; compact live app behavior; populated To-dos/queue/campaign/active-call edge states; actual sends, calls, AI execution, approvals, uploads, configuration saves, installs, restores, and destructive actions. These need safe fixtures or an explicitly approved test—not an assumption of success.

## P0 revalidation (2026-09-02)

Done by reading current source directly (no live click-through: the agent has no login session for Barry's authenticated instance and did not attempt to obtain one — see the runbook). Confirmed baseline fact first: HEAD of `ux-control-center` is identical to `master` (`558f0096`, dated 2026-09-01, one day before the original audit), so nothing below could have been fixed by code that landed after the audit — these are first revalidations, not staleness checks.

**B01 — fully fixed, in two slices (2026-09-02).** Slice 1 fixed `clippy`: `ui/src/lib/company-routes.ts` only strips a leading company prefix when the next path segment is in a hard-coded `BOARD_ROUTE_ROOTS` allowlist; `clippy` was missing (a first fix attempt put it in `GLOBAL_ROUTE_ROOTS` instead, mirroring the neighboring `clippy-popup` comment — a unit test caught that this was the wrong set within minutes, since `App.tsx` registers the full Clippy workspace inside `boardRoutes()` at `/:companyPrefix/clippy`, company-prefixed like `email`/`calendar`/`brief`, not top-level like `clippy-popup`). Slice 2 fixed the two items slice 1 deliberately deferred, plus caught a wider version of the plugin-route problem along the way:

- **Plugin-contributed routes** (`notepad`, `campaigns`, `recordings`, …): rather than adding another hand-maintained per-slug entry (the same whack-a-mole history as `9cc07c0c`, `d1d3ce91`, and clippy itself), `ui/src/lib/company-routes.ts` now sources its whole `BOARD_ROUTE_ROOTS` set from `PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS` in `@paperclipai/shared` (also used to stop a plugin manifest claiming a host route name — the two lists had already drifted from each other, unifying them was as much a bugfix as the routing gap itself), and a new runtime registry (`ui/src/lib/plugin-route-registry.ts`) tracks the plugin routes that can only be known at install time, populated from data `useCompanyPageMemory.ts` already fetches. Along the way, found the shared/UI lists disagreed with the REAL `boardRoutes()` table in App.tsx too: `assistants`/`onboarding`/`settings`/`plugins` were missing from the UI's copy (same double-prefix bug, just never reported) and separately missing from the plugin-reservation list (a plugin manifest could have legally claimed one of those names and collided with a real host page). All fixed as part of the same unification, re-derived from a full line-by-line read of `boardRoutes()`.
- **Explicit shortcut vs. remembered-page restore (A02):** `ui/src/components/SidebarNavItem.tsx`'s hover-flyout click and `useCompanyPageMemory.ts`'s remembered-path replay used to share the `"manual"` `CompanySelectionSource`, so the flyout's explicit `navigate(to)` could be overwritten by a remembered-path redirect. Fixed with a fourth source, `"shortcut"`, threaded through exactly the four places the earlier root-cause analysis called for: `company-selection.ts`, `useCompanyPageMemory.ts`'s replay effect, `SidebarNavItem.tsx`, and `Layout.tsx`'s URL-reconciliation cleanup — the last one specifically to avoid reintroducing the documented PortfolioBrief email-row regression from a narrower, single-file version of this exact fix.

Verification: `pnpm --filter @paperclipai/ui|@paperclipai/shared|@paperclipai/server typecheck` all exit 0; full `@paperclipai/ui` project (181 files/1218 tests) and `@paperclipai/shared` project (13 files/72 tests) both pass cleanly with zero real failures (one mock-completeness break in `Layout.test.tsx` was caught by this same verification and fixed in the same slice — see implementation.md's P1 entry for the exact error). Full detail, file:line citations, and the reasoning trail are in that implementation.md entry rather than duplicated here.

**Third slice, code-review-caught (2026-09-02, same day):** a `/code-review max` pass over the whole session diff found that `SidebarNavItem.tsx`'s peek click handler had a SEPARATE bug from the one slice 2 fixed above — even with the correct `"shortcut"` source, `navigate(to)` still resolved its company prefix from the *current* page (via the wrapped `useNavigate`'s ambient URL-derived prefix), not the peeked company, because `setSelectedCompanyId(...)` only queues a state update and has no synchronous effect on the very next line. A hover-flyout click could silently open the current company's own page instead of switching, with a normal-looking, validly single-prefixed URL — indistinguishable from correct behavior by exactly the check ("no double prefix in the address bar") Barry's own live test used, so it coexisted with his confirmation undetected. Fixed by resolving the peeked company's real prefix explicitly (`applyCompanyPrefix(to, peekedCompany.issuePrefix)`) rather than trusting ambient state. Regression test: `ui/src/components/SidebarNavItem.test.tsx` (new). This is now the third, and hopefully last, distinct bug found in this one click handler — worth remembering if this file needs touching again.

**B02 — still present.** `ui/src/pages/Clippy.tsx` has no breadcrumb-registration call anywhere (`useBreadcrumbs`/`setBreadcrumbs`/`PageHeader` all absent), where peer pages like `Email.tsx` (`setBreadcrumbs([{label:"Email"}])`) and `Issues.tsx` do register. Nothing clears the previous page's crumbs.

**B03 — still present, and the root cause is worse than the audit knew.** Two independent bugs produce the two symptoms. (a) The `Campaign portfolio-rollup not found.` string comes from **API route shadowing**, not a UI bug: `server/src/routes/plugins.ts`'s `matchScopedApiRoute` (~line 489-506) has no literal-over-parameter specificity preference, and in the phone-tools plugin manifest `campaigns.get` (`/campaigns/:campaignId`) is declared *before* `campaigns.portfolio-rollup` (`/campaigns/portfolio-rollup`), so the literal route is permanently shadowed by the parameterized one and every request resolves as `campaignId="portfolio-rollup"`, producing that exact not-found string. Same latent shadowing also affects `campaigns.eligible-assistants`. (b) The later render fallback: `plugins/phone-tools/src/ui/PortfolioRollup.tsx`'s initial fetch checks `res.ok`, but its 30-second refresh (~line 78-83) does not and swallows errors with an empty `.catch`, so a 404 body gets cast to a success type and a subsequent `data.totals.*` dereference throws. Both are real, fixable bugs in `paperclip-extensions`, not UI navigation issues — flag for coordination before any P4 Phone work per the preservation contract's extension-repo rule.

**B04 — confirmed configuration readiness, not a defect**, consistent with the contract's required handling. `plugins/3cx-tools/src/scopeFilter.ts` (~line 25-46) throws `ECOMPANY_NOT_ROUTED` by design whenever a company has no `companyRouting`/`companyTenants` entry for the account, and already names the remediation in its own message. Whether Personal specifically lacks that entry is DB-backed plugin settings, not visible from source — inconclusive on the specific instance, confirmed on the general mechanism.

**B05 — mixed, partly inconclusive from source alone.** Daily report: `plugins/3cx-tools/src/ui/DailyReportPage.tsx` (~line 36) destructures `{ data, loading }` and discards the bridge hook's `error`, so a failed fetch renders as an empty state rather than an error — a real bug adjacent to the audit's report, but whether the *original* observation was this or a true unbounded hang can't be told from source. Roadmap: `ui/src/pages/Roadmap.tsx` has explicit loading/error/empty branches (~line 138-199) with real content behind them; the audit's "blank" was most likely the documented empty state, not a defect. Export/experimental-workspace-redirect: no static cause found; both pages are substantial and unremarkable in source. Inconclusive.

**B06 — fixed 2026-09-02, both halves.** `ui/src/components/CommandPalette.tsx`'s hard-coded "Pages"/"Portfolio" groups now render from a new `ui/src/lib/workspace-catalog.ts`, and a new "Plugins" group lists real installed pages via `usePluginSlots` — Email, Clippy, Automations, Intake queues, Assistants, Memories, Approvals, Receipts, and the previously-missing Portfolio Approvals/Activity/Receipts/Email are all present now, plugin pages show their real names. `ui/src/components/MobileBottomNav.tsx` gained Email as a sixth destination (added, not swapped, so Home/Issues/Create/Agents/Inbox are unchanged). Full trace and verification in implementation.md's P1 sixth bullet.

**B07 — still present as the shipped default; the suppression mechanism exists but isn't used where it matters.** `server/src/services/issues.ts` supports `includeRoutineExecutions`/`excludeRoutineExecutions`, and `IssuesList.tsx` has a `enableRoutineVisibilityFilter` gate — but `ui/src/pages/Issues.tsx` (~line 106) and `CommandPalette.tsx` (~line 73) both unconditionally pass `includeRoutineExecutions: true`. There is no liveness/outcome-based ranking anywhere yet, only a binary include/exclude a caller has to opt into. Matches F03/F04's requirement that attention semantics be evidence-based, not yet satisfied.

## Inventory reconciliation (2026-09-02)

X01-X11 confirmed exact: `~/.paperclip/installed-plugins/` has exactly 11 entries mapping 1:1 onto X01-X11, and every installed version matches the corresponding `paperclip-extensions` package version, so the extensions checkout there is the real installed runtime code, not just a sibling source tree. The extensions repo itself holds 24 plugin packages total; the other 13 (acx-tools, github-tools, google-analytics, google-workspace, image-tools, instagram-tools, kdp-tools, revenuecat-tools, rollbar-tools, s3-tools, social-poster, stripe-tools, youtube-tools) are present in source but **not installed** — matches the contract's "presence is not proof of installed-runtime wiring" caveat exactly; X01-X11 remains the correct installed set.

Routes/pages that exist in current code but have no F-row (additions since the audit, or always-present gaps in the original inventory — not yet triaged into which):

- `ui/src/pages/PluginManager.tsx` + `PluginSettings.tsx` (`/instance/settings/plugins[/:pluginId]`) — the admin surface that installs/updates/configures every X-numbered plugin has no F-row at all. This is the most consequential gap: F28 enumerates instance administration but omits plugin management specifically.
- `ui/src/pages/DesignGuide.tsx`, `ui/src/pages/DashboardLive.tsx` (a `/dashboard/live` variant distinct from the `/brief` redirect F03 covers), `ui/src/pages/UserProfile.tsx` (`/u/:userSlug`, distinct from instance-level `ProfileSettings`), `ui/src/pages/BoardClaim.tsx`, `ui/src/pages/CliAuth.tsx`, the `/onboarding` wizard, and `ui/src/components/CloudAccessGate.tsx` (wraps the whole authenticated route tree) — none have an F-row. Low individual stakes; fold into F28/F29 scope when P4 does the full catalog pass rather than adding new IDs for each.
- Minor: `ui/src/lib/company-routes.ts` whitelists a `usage` board-route root that `App.tsx` never actually declares a route for (dead whitelist entry — falls through to plugin-page handling instead); `AdapterManager` is mounted at two different paths in `App.tsx` (board-scoped and instance-settings-scoped), likely intentional but worth a second look in P4.

No F01-F30/X01-X11 item's cited source file was missing. Full detail, exact line numbers, and the plugin manifest-to-route mapping for all 19 plugin-contributed page routes are preserved in the P0 research agent's report; ask for it again from a fresh read of this repo state if the specifics are needed rather than re-deriving from scratch, since re-reading the same ~30 files is the bulk of the cost.
