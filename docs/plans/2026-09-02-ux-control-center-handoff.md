# UX control center — current status and handoff

Last updated: 2026-09-03. [Project entry point](2026-09-02-ux-control-center.md).

## Resume summary

Barry wants a real local UX overhaul of his customized multi-company Paperclip, with Email first, persistent Clippy, clear Portfolio/HQ/company scope, and every existing operational feature preserved. He will trial and refine the local branch before authorizing a push or PR. Any provider/agent must be able to continue from this package.

**P0 is complete. P1's first, fourth, fifth and sixth bullets are done; bullets 2, 3, and 7 each have a first slice done, none fully complete.** Bullet 7 (stale queries/drafts/unsupported companies) went from unstarted to a real first slice on 2026-09-03: an investigation found and this session fixed two genuine cross-company data leaks (an Email compose draft that could send from the wrong company's mailbox, and a Clippy chat transcript that stayed visible after switching companies) plus five smaller correctness issues in the same family — see implementation.md's bullet-7 entry for the full list. The live instance was verified read-only (checkout, running process, instance config, database, migration state), the F01-F30/X01-X11 inventory was reconciled against real current source, all seven B01-B07 historical bugs were revalidated against current code, and a full automated-test baseline was captured with every failure traced to a specific pre-existing cause. B01 (routing double-prefix), B06 (search/mobile-nav catalog completeness) are **fully fixed and tested**. A first slice of explicit scope labeling (Portfolio/HQ/company/personal/instance, shown in the page header) is done but not yet seen by Barry. He confirmed B01 live the night of 2026-09-02; on 2026-09-03 he additionally confirmed, live, the Everything page (right items, no Portfolio section outside HQ) and both bullet-7 cross-company fixes (Email compose draft and Clippy chat both clear properly on a company switch). Everything else from 2026-09-03 (the scope-label header, the fuller centralized-route-resolution work) is still unseen by him. Separately, an unrelated pre-existing bug found while capturing the test baseline (a test leaking a real local credential) was fixed in an isolated worktree, not this branch.

**Barry went to bed on 2026-09-02 and explicitly asked this agent to keep going unsupervised ("keep going on your own").** He then checked in the morning of 2026-09-03, said the app "looks the same" and that he "expected to wake up and see more done" — direct feedback that overnight correctness/review work, while real, wasn't the visible progress he wanted. That is why bullet 4 (the shell itself) was started next despite the previous version of this file saying it should wait for his direct input: he had, by then, already given the go-ahead to keep working unsupervised, and repeated it more emphatically. If he gives different guidance in a future session, that supersedes this note. Everything from the workspace-catalog slice onward (see verification ledger) was done autonomously, with no live human check-in — verified only by typecheck/automated test, same constraint as P0 (no credentialed browser session: the app shows a real sign-in form and this agent has never had Barry's login). Treat anything not marked "Barry-confirmed" in the verification ledger below as real, tested, but visually unseen. Full detail lives in the runbook (verification results) and the preservation/implementation docs (B01/B06 sections); this file stays the short pointer to both.

**Important for Barry specifically: a `/code-review max` pass after the P1 bullet-3/6 slices found a real bug in the exact flow he already tested and confirmed working.** The hover-flyout click (collapse sidebar, hover a different company, click a page) could silently open the CURRENT company's page instead of switching, because of a closure-timing issue unrelated to the double-prefix bug his test checked for — the resulting URL still looked completely normal (single-prefixed, valid), so nothing about that specific check would have caught it. This is now understood and fixed, with a regression test that reproduces the exact wrong-company scenario. Flagging this not to walk back his confirmation (the double-prefix fix he tested is real and still correct) but because it's a good example of why "the address bar looks right" isn't the same as "it went to the right place" — worth being a little more skeptical of a clean-looking URL when re-checking this area of the app.

The package remains uncommitted: the local `commit-review` skill prohibits staging untracked files and requires a separate draft-review approval, and no commit has been requested yet for either the planning package or the P0/P1 code changes. Preserve all of it at takeover — see the file list below.

## Git / runtime status

| Item | Recorded state |
|---|---|
| Checkout | `C:\Users\barry\paperclip` |
| Local branch | `ux-control-center`, still identical to `master` at `558f0096` as of branch creation; now has uncommitted code changes on top (see below) |
| Baseline HEAD | `558f0096faa8fbb1caee01dede0de231568f7ee5` — Say why a mail action failed instead of looking like nothing happened |
| Application changes from this project | Uncommitted working-tree changes (full detail in implementation.md's P1 entries, including the "Code review pass" entry, and preservation.md's B01/B06 entries). Modified: `packages/shared/src/constants.ts`, `packages/shared/src/index.ts`, `ui/src/App.tsx`, `ui/src/components/BreadcrumbBar.tsx`, `ui/src/components/ClippyDrawer.tsx`, `ui/src/components/CommandPalette.tsx`, `ui/src/components/CommandPalette.test.tsx`, `ui/src/components/IssuesList.tsx`, `ui/src/components/IssuesList.test.tsx`, `ui/src/components/Layout.tsx`, `ui/src/components/Layout.test.tsx`, `ui/src/components/MobileBottomNav.tsx`, `ui/src/components/NewIssueDialog.tsx`, `ui/src/components/SidebarMenu.tsx`, `ui/src/components/SidebarNavItem.tsx`, `ui/src/hooks/useCompanyPageMemory.ts`, `ui/src/lib/company-routes.ts`, `ui/src/lib/company-routes.test.ts`, `ui/src/lib/company-selection.ts`, `ui/src/lib/company-selection.test.ts`, `ui/src/lib/workspace-catalog.ts`, `ui/src/pages/Clippy.tsx`, `ui/src/pages/Email.tsx`, `ui/src/pages/Inbox.tsx`, `ui/src/pages/Memories.tsx`. New: `ui/src/lib/plugin-route-registry.ts` + test, `ui/src/lib/scope-kind.ts` + test, `ui/src/lib/workspace-catalog.test.ts`, `ui/src/lib/clippy-company-scope.ts` + test, `ui/src/pages/Everything.tsx` + test (named `Catalog.tsx` until 2026-09-03, when Barry picked "Everything"), `ui/src/pages/Email.composeDraftKey.test.ts`, `ui/src/components/MobileBottomNav.test.tsx`, `ui/src/components/SidebarNavItem.test.tsx`, `ui/src/components/NewIssueDialog.draftKey.test.ts`. |
| Plan/reference files | Files under `docs/plans/` updated this session (runbook, scope, preservation, implementation, this file); not staged or committed |
| Push / PR / merge | None; explicitly prohibited until Barry authorizes |
| Intended trial URL | `http://paperclip.local:3100` — confirmed reachable and correctly configured (real DNS resolution, in `allowedHostnames`) |
| Runtime rebinding/restart | None performed. Live server (PID 3588, started 2026-09-02 00:17:35 via `paperclipai run`, not `pnpm dev`) was left running throughout; only read-only inspection was done against it and its database. |
| Database / operational actions | None; no migrations, messages, calls, agent invocation, settings save or destructive action. Migration status confirmed `upToDate` via a read-only call to the server's own `inspectMigrations()` (92 tables, all 95 migrations applied, zero pending). |
| Extension repository changes | None. `paperclip-extensions` confirmed present, on `master`, clean, and its 11 installed plugin versions confirmed to match `~/.paperclip/installed-plugins/` exactly. |
| Stray unrelated worktree | `.claude/worktrees/bold-hugle-9fff22` (branch `claude/bold-hugle-9fff22`, clean, unrelated prior feature) — found, not touched, not part of this project. |
| Separate credential-leak fix (not this project) | Fixed in its own worktree at `.claude/worktrees/agent-afe3604782701316e` (branch `worktree-agent-afe3604782701316e`), one file (`server/src/services/__tests__/chat-account-routing.test.ts`), verified passing, **uncommitted**. Reproduces on `master` too — independent of `ux-control-center`. See "Verification ledger" below for what it fixed. |

Recheck all of this at takeover; this table is a dated handoff, not live system state.

## 2026-09-04 update

Barry read the session's output and said he had expected to see UI changes.
That was fair: the day had gone server-side at his direction (the P5a spec
review, the migration, the resolve caller), so little of it was visible. He
then said to go autonomously and not stop, committing after each phase.

Since then, and all pushed to `origin/ux-control-center`:

- **P5a is finished and live.** The delegation table, lifecycle, resolve
  path, four routes, four agent tools, and a panel on the issue an email
  created. Resolving replies to the original sender through the same tool an
  agent would use by hand, and obeys a new three-state setting that decides
  whether that reply waits for approval. Migrations 0095 and 0096 applied to
  the running instance.
- **P1 bullet 3's availability half.** The workspace list now carries the
  conditions a workspace needs, and the sidebar, search and Everything all
  read them. Opening Workspaces with the switch off used to redirect silently
  to Issues; it now says so. Same for a plugin with no page of its own, which
  used to open that plugin's settings without a word.
- **P1's "Pinned tools", which had never been built.** Pin from the Everything
  page; pinned workspaces appear in the sidebar under Calendar. Pins are per
  person, and one that a company cannot open is hidden there rather than
  removed from the saved list.
- **Stale email handoffs join the attention queue**, per P5a's §4.5
  recommendation to extend it rather than build a second "stuck" list.

Still open, and honestly named: P1 bullet 2's "Shared service/account" scope
needs the Phone and Reviews plugins, which live in a repository this work is
not to touch without separate coordination. P5b (freeform work entry) and P5c
(richer Reviews) have not started and are net-new features needing Barry's
product decisions, not inference. P6 is his own trial and cannot be done for
him.

Three pre-existing test failures remain, none from this work: two assume a
machine with no Switchboard accounts, and one is in the Claude adapter's
plan-exhausted parsing, which another session was editing on this same branch
during the run.

## Phase status

| Phase | Status | Next evidence needed |
|---|---|---|
| Planning | Complete and validated | Seven documents, five reference snapshots, portable read-only checker |
| P0 baseline/runtime | **Complete (2026-09-02)** | Done — see runbook's "P0 verification results" |
| P1 scope/shell | **In progress (2026-09-03)** | Bullet 1 (regression cases + B01) **fully done**, Barry-confirmed live — though a code-review pass afterward found and fixed a second, unrelated bug (wrong-company navigation) in the same click handler, not caught by that confirmation; see the resume summary. Bullet 2 (explicit scope) **first slice done, not yet Barry-confirmed** — header label distinguishing Portfolio/HQ/company/personal/instance; still needed: "Shared service/account" scope, whether server authorization needs any change (none made — label only). Bullet 3 (centralize route/workspace resolution) **first slice done** — `workspace-catalog.ts` for core routes; full version (route resolver/availability/capability fields, one registry covering core+plugin together) still open. Bullet 4 (the new shell) **first slice done 2026-09-03, Barry-confirmed live** — the Everything page (renamed from "Catalog", his call) shows the right items with no Portfolio section outside HQ. Real gap still open: scope.md names a Knowledge page and a Company notes page — resolved 2026-09-03 as NOT a gap, both already exist under different names (Memories+Skills, and the Notepad plugin); see the resume summary. Bullet 5 (hover shortcuts) — covered by bullet 1's fix. Bullet 6 (search/catalog/pins) **fully done** (B06), including a code-review correction to two labels that had drifted from the rest of the app. Bullet 7 (unsupported companies, draft transitions, stale queries, navigation memory, back/forward) — **first slice done 2026-09-03, Barry-confirmed live**: the Email compose draft and Clippy transcript both now correctly clear on a company switch. A `/code-review max` pass covering all of P1's work through bullet 6 found 15 real issues, all fixed same-session — see implementation.md's "Code review pass" entry. |
| P2 Email/Clippy | **In progress (2026-09-03)** | First slice done: two parallel investigation agents audited Email and Clippy against the P2 checklist; found and fixed 4 real issues (1 high-severity Clippy regression, 3 medium), all with regression tests. 4 more pre-existing gaps were flagged for Barry — he said fix those too, and all 4 are now done (agent-wake failure visible, resulting-work link real, failure toasts added to two Help Scout/portfolio surfaces). See implementation.md's two P2 dated entries. Not yet Barry-confirmed live. |
| P3 Calendar/Team/Attention | **Mostly done (2026-09-03)** | Three parallel audits (Calendar; Team/Agents/Assistants; Brief/Overview/Inbox/Approvals) found the stale-`useCompany()` bug in 11 more files (fixed, including one write-path case in `NewAgent.tsx`), two false "all clear" / false-empty-state bugs in Brief/Overview (fixed), a calendar create-dialog scoping gap (fixed), a missing notification-time display (a real standing gap, now built), and a sidebar Team-section gap (fixed). One thing intentionally left unbuilt: agent "objectives"/"next-action owner" don't map to a concrete field — flagged for a product decision, not invented. See implementation.md's P3 dated entry. Not yet Barry-confirmed live. |
| P4 remaining workspaces/plugins | **Done (2026-09-03)** | Three parallel audits found the stale-`useCompany()` bug in ~30 more files (fixed — the most severe, `NewAgent.tsx`-class, being writes: hiring an agent, company secrets/settings/access, budgets, a new chat session, import/export). Separately found and fixed a real HIGH server-side bug: an explicit empty company list on a portfolio broadcast silently fanned out to every accessible company instead of targeting none (Clippy-tool-reachable, not just the one gated form). Also fixed: 4 dead links in Company Settings, 2 missing catalog entries (Org chart, Workspaces), Work Queue items not showing their linked issue, an issue's goal link never rendered. Phone/Reviews host-side reachability audited and confirmed intact, closing out the checklist. A few things flagged rather than built — see implementation.md's P4 entries. Not yet Barry-confirmed live. |
| P5 behavioral additions | **Gated — P5a spec written, not implemented (2026-09-03)** | `docs/plans/2026-09-03-p5a-email-delegation-spec.md` specifies durable email delegation (source identity, lifecycle, failure/concurrency handling, and what needs a migration vs. what reuses existing data) per this phase's own gate — written for Barry's review, nothing implemented, no migration applied. Several concrete decisions are deliberately left open in the doc for him to make. P5b/P5c not started. |
| P6 daily-use trial | Pending | Actual app checks and Barry's explicit satisfaction |
| P7 publication | Not authorized | Separate approval to push and create PR |

## Completed preparation

- Read repository guidance and required goal/product/implementation/development/database documents.
- Reviewed current package/test scripts and existing routing source/test locations for an actionable runbook.
- Established provider-neutral branch and centralized charter, scope/decision register, feature inventory, phased backlog, validation contract and runbook.
- Included repository-local snapshots of both prior audits and all three mockups; no need to retrieve this conversation or private task files.
- Separated existing features from proposed durable email handoff, freeform work entry and richer human Reviews behavior.
- Recorded historical audit limitations and the need to revalidate defects against newer source.

## Next action

**If Barry is picking this up:** read this file's resume summary first, in particular the 2026-09-03 note about why bullet 4 got started without waiting for him — that reasoning only holds if he hasn't said otherwise since. Two concrete things are waiting for his eyes: the scope-label header (Portfolio/HQ/company/personal/instance, in `BreadcrumbBar.tsx`), and Calendar's new position plus the new **Everything** page/link (bottom of the sidebar, renamed from the placeholder "Catalog" on 2026-09-03 — see below). Everything else changed since is routing/navigation-completeness work with no visual signature to check — it either works when clicked or it doesn't.

**The two open questions from earlier are resolved, 2026-09-03, both decided directly by Barry in chat:**
1. **Naming:** the new "see everything" page is called **Everything** (route `/everything`). Barry rejected both the plan's literal "All workspaces" and the placeholder "Catalog" as potentially confusing; "Everything" was proposed and he accepted it, with the explicit note that it can change again later if needed. Renamed everywhere: `ui/src/pages/Catalog.tsx` → `Everything.tsx` (+ its test file), the route in `App.tsx`, the sidebar link in `SidebarMenu.tsx`, and the reserved route segment in `packages/shared/src/constants.ts`.
2. **Knowledge / Company notes:** turned out not to be missing features at all — just old mockup labels for things that already exist. Traced via `docs/plans/2026-09-02-ux-control-center-reference/paperclip-ux-audit.md`'s own workspace table: "Knowledge" = Memories (`/memories`, already in the sidebar) + the company Skills library (`/skills`, reachable from the company dropdown menu); "Company notes" = the Notepad plugin already installed (same one the old audit calls "Industry/Personal Notepad"). Nothing was built. The one real, small gap this surfaced — Skills wasn't in `workspace-catalog.ts`, so it didn't show up in Command Palette search or the new Everything page — was fixed by adding it there.

**Barry then asked, specifically: does switching companies and clicking around Everything ever expose another company's information, except HQ, which is expected to see everything?** Good question to ask — it found a real bug. `Everything.tsx` was deriving "is this HQ" from `useCompany()`'s selection state, which is synced from the URL by an effect that runs one render late. `ui/src/hooks/useRouteCompany.ts` documents this exact pattern as the cause of a real, already-measured incident on the Email page (58 failed requests). Practical effect here: switching away from HQ to a normal company could, for one frame, still show HQ's Portfolio section (Portfolio Brief/Email/Issues/etc.) on the normal company's Everything page, before self-correcting a moment later. Not another company's actual records showing up — the Portfolio section only ever shows portfolio-aggregate destinations, never a second company's own page — but a real scope-boundary bug and exactly the class of thing he was asking about. Fixed by switching to `useActiveCompanyId()` (URL-derived, synchronous), the same pattern `BreadcrumbBar.tsx` already uses for the identical reason. New test proves the Portfolio section is gated on the URL's company, not any other state. Full detail in implementation.md's bullet-4 entry.

**2026-09-03, Barry-confirmed live:** checked the Everything page directly — right items show, and no Portfolio section outside HQ. Separately confirmed the two bullet-7 cross-company fixes by hand too: switching companies now properly clears both the Email compose draft and the open Clippy chat, nothing carries over. This is the first live confirmation of anything from the 2026-09-03 autonomous work (bullets 4 and 7), not just the earlier bullet-1 routing fix.

**2026-09-03, P2 started at Barry's direct request ("start on P2").** Two parallel investigation-only agents audited Email and Clippy against P2's full checklist (F05-F11, A05-A09, A18-A21), specifically hunting for anything the P1 shell rework broke. Found and fixed 4 real issues, most serious a genuine regression: `ClippyDrawer.tsx`'s own "Recent chats" dropdown (which deliberately lists chats from every company) was being silently overridden by bullet 7's own company-scope fix, so clicking a different company's chat there didn't work. Also fixed: Clippy's composer draft/attachments weren't scoped per chat session (an unsent draft could go to the wrong chat); `PortfolioEmail.tsx` had the identical stale-company bug just fixed in Everything.tsx; Email's search term wasn't cleared on a company switch. All four have regression tests; full detail in implementation.md's first P2 dated entry. Four more pre-existing gaps were flagged rather than fixed unprompted (silent agent-wake failure, a dead resulting-work link, inconsistent failure toasts in two surfaces) — **Barry said "Yes, fix those too"**, and all four are now done too: see implementation.md's second P2 dated entry for exactly what changed. Not yet clicked through live.

**If another agent is picking this up:** P1's bullets 1 (routing/B01), 5 (hover shortcuts), 6 (search/catalog/B06), and now 4 (the shell) are done and code-reviewed for the pieces that actually needed new code — don't redo them, and read implementation.md's bullet-4 entry before assuming any part of "the new shell" is still unbuilt, most of it already existed. Don't re-investigate the "Knowledge"/"Company notes" gap either — it's resolved (see the 2026-09-03 entry above and in implementation.md): both terms just refer to existing features (Memories + Skills library; the Notepad plugin) under old mockup names, nothing was missing, nothing needed building. The new discovery page is called **Everything**, not "Catalog" — if you find "Catalog" anywhere it's a stale reference that should be updated to match. Bullet 2 (explicit scope) and bullet 3 (centralized route/workspace resolution) each have a first slice done; the natural next increment is bullet 3's fuller version (a real "host-owned workspace/navigation description" covering scope kind, availability, and capability restrictions in one place for core AND plugin routes together — `workspace-catalog.ts` and `plugin-route-registry.ts` are the narrower building blocks already in place). Bullet 2's remaining "shared service/account" scope is mostly plugin-side (3CX, GBP Reviews) and likely needs `paperclip-extensions` coordination — do not start editing that repo without a separate, explicit scope decision (see the preservation contract's own rule on this). **Bullet 7 (unsupported companies, draft transitions, stale queries, navigation memory, back/forward) now has a first slice** — see implementation.md's bullet-7 entry and this file's 2026-09-03 changelog entry below for the full list of what was fixed (two real cross-company leaks: Email compose draft, Clippy transcript; five smaller issues; plus a from-source check confirming back/forward isn't broken, no fix needed there). What's genuinely still open, in case it reads as more finished than it is: navigation memory beyond the existing shortcut-vs-remembered-path fix wasn't specifically investigated; "unsupported companies" was only checked for the one case the investigation happened to look at (Email's "not configured" state, already correct) — not audited page-by-page; and `Calendar.tsx`'s `editingEvent`/`detailEventId` were deliberately left alone (low severity, modal-blocked in practice). Don't re-run the same investigation from scratch — read what's already there first. Before touching anything: rerun the read-only migration check in the runbook first if a restart is ever needed (D12 in scope.md), and re-read `ui/src/lib/company-selection.ts`'s file comment before touching selection-source logic again — three separate bugs were found in that one area this session.

No product-design question currently prevents this work. P5 migrations, changes in another repository, consequential live tests, and publication have their own approval boundaries. Live browser verification of any page needs either Barry's own signed-in session or an explicitly-approved test account — this agent had neither and relied on source-level verification throughout P0.

## Verification ledger

| Date | Scope | Evidence/result |
|---|---|---|
| 2026-09-02 | Before plans | Working tree clean; local branch `master`; baseline commit recorded |
| 2026-09-02 | Branch preparation | `git switch -c ux-control-center` succeeded; no application changes or restart |
| Historical mockup pass | Mockup 3 only | 545 JS/DOM assertions passed; no reported runtime errors; sample data only. Not a real-app verification result. |
| 2026-09-02 | Planning files | Structural/link/contract checks passed; all five archived references match originals after line-ending normalization; mockup scripts parse; application tracked-file diff empty; `master` remains at baseline |
| 2026-09-02 | Handoff preparation | Package checker rerun successfully: 7 planning documents, 5 reference snapshots, 19 local links, 30 feature contracts, 11 plugin families, 26 acceptance scenarios. Index remains empty; no commit or push. |
| 2026-09-02 | P0 execution | Live checkout/process/instance/DB/migration state verified read-only (full detail in runbook). Zero pending migrations confirmed via a direct read-only call to the server's own `inspectMigrations()`. Route/plugin inventory reconciled against real source (Explore agent, ~58 tool calls); all 11 X-plugins confirmed installed-and-matching, several F-row gaps found (notably: `PluginManager`/`PluginSettings` has no F-row at all). All seven B01-B07 items revalidated against current code with exact file:line citations; five confirmed still-present, one confirmed not-a-defect (config readiness), one mixed/partly inconclusive. |
| 2026-09-02 | P0 baseline tests | Full automated-test baseline captured across all 8 vitest projects (2568 tests). Every failure traced to a specific pre-existing cause unrelated to this project: 2 Windows-path/permission test-fixture assumptions, 1 Windows pnpm-shim spawn resolution bug (reproduced in total isolation), 1 unrelated adapter error-classification test, 1 test-isolation gap that leaks a real local Claude Code credential into test output (flagged separately, not fixed here — see below). `ui` project: 1204/1205 pass, 0 failures. `server` project: 1670/1943 real assertions pass, exactly 2 pre-existing failures once 40 false-signal `beforeAll`-timeout file failures (a full-256-file-invocation resource-contention artifact on this specific loaded machine, not a code defect) are set aside. Full table and exact repro notes in the runbook. |
| 2026-09-02 | P1 first bullet, slice 1 | Fixed and tested: `clippy` was missing from `company-routes.ts`'s `BOARD_ROUTE_ROOTS`, the confirmed direct cause of B01's `/IND/IND/clippy` double-prefix. `pnpm exec vitest run --project @paperclipai/ui ui/src/lib/company-routes.test.ts ui/src/lib/company-selection.test.ts ui/src/hooks/useCompanyPageMemory.test.ts ui/src/context/CompanyContext.test.tsx` → 4 files, 27 tests, all pass. `pnpm --filter @paperclipai/ui typecheck` → exit 0. Two related sub-bugs deliberately left open at this point (plugin-route double-prefix; shortcut-vs-remembered-path precedence), fixed in slice 2 below the same day. |
| 2026-09-02 | P1 first bullet, slice 2 (B01 complete) | Same-day follow-up user request ("keep going with P1"). Unified `BOARD_ROUTE_ROOTS` with `@paperclipai/shared`'s `PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS` (now exported from its public index) after finding the two had already drifted from the real route table in both directions; added `ui/src/lib/plugin-route-registry.ts` for plugin routes that can't be known at compile time; added a fourth `CompanySelectionSource` ("shortcut") across `company-selection.ts`/`useCompanyPageMemory.ts`/`SidebarNavItem.tsx`/`Layout.tsx`. `pnpm --filter @paperclipai/ui\|@paperclipai/shared\|@paperclipai/server typecheck` → all exit 0. Full `@paperclipai/ui` project run: 181 files, 1217/1218 pass (1 pre-existing skip) — first full run caught a real break (`Layout.test.tsx`'s complete mock of `../lib/company-selection` didn't know about the new `shouldClearTransientSelectionSource` export, failing 3 unrelated tests with `No "shouldClearTransientSelectionSource" export is defined on the mock`), fixed by adding it to the mock, reran clean. Full `@paperclipai/shared` project run: 72/72 pass, unchanged. Repo-wide grep confirmed no other test exercises the expanded reserved-segment list or a colliding `routePath`. |
| 2026-09-02 | Credential-leak fix (separate from this project) | User asked to also act on the spawn_task chip raised during P0 baseline testing. Dispatched as a background agent in an isolated worktree (not this branch — reproduces on `master`). Root cause: `resolveActiveAccountEnv` legitimately falls back to asking Switchboard (the account broker) which account to sign in with when no explicit account is configured — intentional, documented behavior tied to a real prior outage, left unchanged. The test just never blocked that path, so on a machine with a real login it shelled out for real and got a live token back. Fix: `server/src/services/__tests__/chat-account-routing.test.ts` now sets `SWITCHBOARD_ENABLED=false` and resets the Switchboard cache around every test, copied from the same pattern already used in the sibling file `active-account.test.ts`. Verified: `pnpm exec vitest run --project @paperclipai/server server/src/services/__tests__/chat-account-routing.test.ts` → 6/6 pass, output scanned for any credential-shaped string, none found. Uncommitted, in worktree `.claude/worktrees/agent-afe3604782701316e` (branch `worktree-agent-afe3604782701316e`) — needs its own commit/PR path, separate from `ux-control-center`. |
| 2026-09-02 | B01 confirmed live by Barry | First real (non-test) confirmation of this project: collapsed sidebar, hovered a different company, clicked Clippy from the flyout, landed correctly instead of the old double-prefix break. Server was already serving the change with no restart (Vite dev middleware + source-based package resolution, both confirmed separately). |
| 2026-09-02 | P1 second bullet, first slice | Added `ui/src/lib/scope-kind.ts` + `ui/src/components/BreadcrumbBar.tsx` header label (Portfolio/HQ/company/personal/instance). `scope-kind.test.ts` → 10/10 pass, including a case that caught a first wrong implementation (`isPortfolioRoutePath` read the wrong path segment for a company-prefixed URL — naive first-segment check instead of reusing `toCompanyRelativePath`). `pnpm --filter @paperclipai/ui typecheck` → exit 0. Full `@paperclipai/ui` project: 182 files, 1227/1228 pass (1 pre-existing skip). Caught and fixed one more bug in self-review before shipping: the label's separator dot was gated on a JSX element's truthiness (always true) instead of on whether the label actually had text. Not yet shown to Barry. |
| 2026-09-02 | Barry: "keep going on your own" (going to bed) | Everything below is autonomous, unsupervised, no live human check-in. Same verification constraint as always (typecheck + automated test, no credentialed browser session) — nothing below is Barry-confirmed yet. |
| 2026-09-02 | P1 bullets 3+6, B06 fully fixed | Added `ui/src/lib/workspace-catalog.ts` (static core-route catalog, self-tests against `company-routes.ts`). Rewrote `CommandPalette.tsx`'s hard-coded Pages/Portfolio groups to render from it; added a "Plugins" group via `usePluginSlots`. Added Email as a 6th `MobileBottomNav.tsx` destination (grid-cols-5→6). `pnpm --filter @paperclipai/ui typecheck` → exit 0 after each of the three changes. `workspace-catalog.test.ts` 5/5, `CommandPalette.test.tsx` expanded 1→4 tests (added a `@/plugins/slots` mock that hadn't existed — the file previously left `usePluginSlots` unmocked and it happened to work by accident), `MobileBottomNav.test.tsx` new, 1 test — all pass. Full `@paperclipai/ui` project run after each change: 182→183→184 files, zero failures throughout (1 pre-existing skip). |
| 2026-09-02 | `/code-review max` pass + fixes | Reviewed the full session diff (21 files at the time) before continuing further, on the judgment that the scale of unsupervised work warranted a deliberate verification pause. Ten parallel review-angle agents, two of which empirically ran the real code rather than only reading it. 15 real findings, all fixed same-session — full list with severity/verdict/outcome in the review tool's own findings report; the two most serious are summarized in implementation.md's "Code review pass" entry and this file's resume summary (the SidebarNavItem wrong-company bug that coexisted with Barry's confirmed-working test). Re-verified after fixes: `pnpm --filter @paperclipai/ui\|@paperclipai/shared\|@paperclipai/server typecheck` → all exit 0. Full `@paperclipai/ui` project: 185 files, 1241/1242 pass (1 pre-existing skip), zero failures. Full `@paperclipai/shared` project: 72/72 pass, unchanged. Two candidates deliberately left unfixed, documented in-source rather than silently dropped (plugin-route-registry staleness on uninstall; a small duplicated filter between `usePluginRouteRootsSync` and `usePluginSlots` that isn't safe to naively merge). |
| Not run | Browser/manual acceptance (A01-A26) beyond the two Barry-confirmed items above, full-repo `pnpm -r typecheck`/`build` | Full-repo typecheck/build not run this session (targeted per-package typecheck was run instead, covering every touched package) — run before any broader completion claim per AGENTS.md §7 |

Repeatable package check: `node docs/plans/2026-09-02-ux-control-center-check.mjs`. This checks the planning package, not app behavior. Reference fidelity was additionally checked against the original task artifacts when copied; those private originals are not required for future work.

## Proposed local commit

```text
Add the multi-company UX plan and agent handoff

Centralize the scope, preservation contract, implementation phases,
acceptance checks, local runbook, audits, and mockup references.
Keep implementation and publication gated on local verification and review.
```

No commit was made. Do not include unrelated work or bypass the active commit workflow.

## Handoff/update template

Append a dated entry after each meaningful work slice:

```text
Date / contributor (provider-neutral role; optional accurate provenance):
Branch / HEAD / uncommitted paths:
Phase and task IDs:
What changed in the real app:
Affected preservation IDs / acceptance IDs:
Commands and actual results:
Browser/manual evidence and test-instance identity (no secrets):
Data/schema/plugin/runtime impact:
Known limitations / baseline failures / rollback:
Barry's feedback and decisions:
Exact next action:
Publication authorization (unchanged unless explicitly given):
```

Keep the current summary/table accurate; do not bury the latest blocker beneath old logs. Never turn a proposed feature, a mocked result, or a merely inspected action into a completed implementation item.

### 2026-09-02 — P0 execution + P1 first bullet (partial)

```text
Date / contributor: 2026-09-02, AI agent (provider-neutral; Claude Sonnet 5 via Claude Code)
Branch / HEAD / uncommitted paths: ux-control-center @ 558f0096 (unchanged, no commits made). Uncommitted:
  docs/plans/2026-09-02-ux-control-center*.md (this session's edits), ui/src/lib/company-routes.ts,
  ui/src/lib/company-routes.test.ts, ui/src/lib/company-selection.ts.
Phase and task IDs: P0 (all bullets, complete). P1 bullet 1 "Add regression cases for company/plugin/
  Clippy route normalization and explicit shortcut precedence" (partial — one fix shipped, two known
  gaps deliberately deferred with analysis recorded in-source).
What changed in the real app: ui/src/lib/company-routes.ts — moved "clippy" from GLOBAL_ROUTE_ROOTS to
  BOARD_ROUTE_ROOTS (it was in the wrong set on the first attempt; a unit test caught this before it was
  called done). This fixes the "/IND/IND/clippy" double-prefix half of B01. ui/src/lib/company-selection.ts
  got a documentation-only comment (no behavior change) recording the root cause and exact multi-file fix
  shape for the other half of B01 (shortcut-click vs remembered-path race), left unfixed this slice.
Affected preservation IDs / acceptance IDs: B01 (partial fix), F01/F29 (route normalization), contributes
  toward A02/A04.
Commands and actual results: pnpm exec vitest run --project @paperclipai/ui ui/src/lib/company-routes.test.ts
  ui/src/lib/company-selection.test.ts ui/src/hooks/useCompanyPageMemory.test.ts
  ui/src/context/CompanyContext.test.tsx -> 4 files, 27 tests, all pass. pnpm --filter @paperclipai/ui
  typecheck -> exit 0. Full 8-project vitest baseline captured separately (see verification ledger above
  and the runbook) — 2568 tests total, every failure traced to a pre-existing, unrelated cause.
Browser/manual evidence and test-instance identity (no secrets): None obtained. paperclip.local:3100 shows
  a real Sign In form with no persisted session; this agent has no credentials for Barry's authenticated
  instance and did not attempt to obtain any. All verification this slice was source/unit-test level.
Data/schema/plugin/runtime impact: None. Zero database, migration, config, or plugin changes. Live server
  (PID 3588) left running and untouched throughout — read-only inspection only, including a direct
  read-only call to the server's own inspectMigrations() to confirm zero pending migrations.
Known limitations / baseline failures / rollback: See runbook for the full baseline-test table. Two B01
  sub-bugs remain open on purpose (plugin-route double-prefix; shortcut-precedence race) — do not patch
  either as a quick one-file fix; read the in-source comments first (company-selection.ts, and
  company-routes.test.ts's "known gap" test). Rollback: the two source-file changes are small, additive,
  and covered by tests; `git diff` and `git checkout -- <path>` would cleanly revert if ever needed
  (not needed now, no issue found).
Barry's feedback and decisions: None yet — first work session since the handoff was written; Barry has not
  seen this slice yet.
Exact next action: Continue P1 from its second bullet (explicit scope layer) or third bullet (centralized
  route/workspace resolution, which is where the two deferred B01 items belong). Re-read this entry and
  preservation.md's B01 section first.
Publication authorization: Unchanged — none given. No push/PR/commit performed or requested this slice.
```

### 2026-09-02 — P1 first bullet slice 2 (B01 fully fixed) + separate credential-leak fix

```text
Date / contributor: 2026-09-02, same session as the entry above, AI agent (Claude Sonnet 5 via Claude Code)
Branch / HEAD / uncommitted paths: ux-control-center @ 558f0096 (unchanged, no commits made). Uncommitted, on
  top of the slice-1 changes: packages/shared/src/constants.ts, packages/shared/src/index.ts,
  ui/src/components/Layout.tsx, ui/src/components/Layout.test.tsx, ui/src/components/SidebarNavItem.tsx,
  ui/src/hooks/useCompanyPageMemory.ts, ui/src/lib/company-routes.ts, ui/src/lib/company-routes.test.ts,
  ui/src/lib/company-selection.ts, ui/src/lib/company-selection.test.ts (all modified);
  ui/src/lib/plugin-route-registry.ts, ui/src/lib/plugin-route-registry.test.ts (new). Separately, an
  unrelated worktree at .claude/worktrees/agent-afe3604782701316e has one uncommitted file
  (server/src/services/__tests__/chat-account-routing.test.ts) — not part of this branch.
Phase and task IDs: P1 bullet 1, now fully done (both sub-items deferred in slice 1). User explicitly asked
  to continue P1 and separately asked to act on the credential-leak spawn_task chip from the P0 entry.
What changed in the real app: See implementation.md's P1 entry and preservation.md's B01 entry for the full
  reasoning trail — summary: (1) BOARD_ROUTE_ROOTS in company-routes.ts now sources from a single shared
  constant instead of an independently-drifting copy, and that constant's own content was corrected against
  a full re-read of App.tsx's route table (found 4 more missing core routes beyond clippy along the way).
  (2) A new runtime registry recognizes plugin-contributed routes, which can never be known at compile time.
  (3) A fourth CompanySelectionSource ("shortcut") fixes the hover-flyout-vs-remembered-page race, threaded
  through all four places the slice-1 analysis said it would need to touch. Separately, in an isolated
  worktree: a test that was supposed to assert "no account configured returns null" now actually blocks the
  real Switchboard fallback path instead of silently exercising it.
Affected preservation IDs / acceptance IDs: B01 (now fully fixed), F01/F29, A02/A04. Credential fix is
  unrelated to this project's feature/acceptance IDs.
Commands and actual results: pnpm --filter @paperclipai/ui typecheck, pnpm --filter @paperclipai/shared
  typecheck, pnpm --filter @paperclipai/server typecheck -> all exit 0. pnpm exec vitest run --project
  @paperclipai/ui (full project) -> 181 files, 1217/1218 tests pass (1 pre-existing skip), 0 failures — this
  caught one real break from the change (Layout.test.tsx's mock needed updating) before it was fixed and
  reverified clean. pnpm exec vitest run --project @paperclipai/shared (full project) -> 72/72 pass,
  unchanged. Credential fix, run from its worktree: pnpm exec vitest run --project @paperclipai/server
  server/src/services/__tests__/chat-account-routing.test.ts -> 6/6 pass.
Browser/manual evidence and test-instance identity (no secrets): None obtained by this agent — no
  credentialed session for Barry's live instance, so verification here was typecheck + automated test only.
  Confirmed separately by Barry live in his own browser, same day, at http://paperclip.local:3100 on his
  real HQ portfolio instance: collapsed the sidebar (hamburger icon, tooltip "Hide sidebar"), hovered a
  different company's icon in the rail, clicked Clippy from the flyout — landed correctly instead of the
  old double-prefix break. First confirmation of any part of this project on the real running app, not just
  tests. (Confirmed the server was already serving the change with no restart, per the Vite dev-middleware
  markers found in the served HTML and the source-based package.json `exports` for `ui/`'s dependencies —
  worth reusing that check before ever telling Barry something needs a restart to try.)
Data/schema/plugin/runtime impact: None. No database, migration, config, or plugin changes in either the
  main checkout or the credential-fix worktree. Live server (PID 3588) untouched throughout.
Known limitations / baseline failures / rollback: The plugin-route registry has one accepted, documented
  limitation (a route isn't recognized until plugin contribution data has loaded at least once this
  session — see the comment in plugin-route-registry.ts). Rollback: all changes are additive, typechecked,
  and covered by tests; `git diff`/`git checkout -- <path>` per file would cleanly revert if ever needed
  (not needed now). The credential-fix worktree is fully separate from this branch and can be abandoned or
  merged independently without touching ux-control-center.
Barry's feedback and decisions: Asked to "keep going with P1" and to also act on the credential-leak chip,
  in the same message, after seeing the slice-1 summary. Both done in this slice.
Exact next action: Continue P1 from its second bullet (explicit scope layer) — there is no "scope kind"
  concept in the code yet (Portfolio vs HQ vs company vs personal vs shared vs instance). Consider doing it
  together with the third bullet's "host-owned workspace/navigation description" (implementation.md's
  technical-approach section), since each entry in that description would naturally carry its own scope
  kind — designing them separately risks a second migration later. The credential-fix worktree needs its
  own commit/PR path when Barry wants it; it does not block or depend on anything in this branch.
Publication authorization: Unchanged — none given. No push/PR/commit performed or requested this slice,
  in either the main checkout or the credential-fix worktree.
```

### 2026-09-03 — P1 bullet 4 (shell) first slice, bullet 7 investigation started

```text
Date / contributor: 2026-09-03, same session continued overnight, AI agent (Claude Sonnet 5 via Claude Code)
Branch / HEAD / uncommitted paths: ux-control-center @ 558f0096 (unchanged, no commits made). New on top of
  everything above: ui/src/App.tsx, ui/src/components/SidebarMenu.tsx (both modified),
  ui/src/pages/Catalog.tsx + ui/src/pages/Catalog.test.tsx (new).
Phase and task IDs: P1 bullet 4 ("build the new shell around real pages") — first slice done. P1 bullet 7
  (unsupported companies, draft transitions, stale queries, navigation memory, back/forward) — investigation
  dispatched, not yet a code change.
What changed in the real app: Before writing any UI code, checked each of bullet 4's named sub-pieces
  (compact company rail, main collapse, readable scope header, pinned daily workspaces, control section,
  catalog, administration paths) against the real app. Five of the seven already existed and worked
  (CompanyRail.tsx, SidebarContext.tsx's collapse toggle, the scope-kind header from bullet 2, and
  SidebarAccountMenu.tsx's instance-settings link) — no change made to any of them. Two real gaps: (1)
  Calendar was inside SidebarMenu.tsx's "Work" section instead of pinned at the top with Email/Inbox/Clippy,
  which is where scope.md's primary-nav table puts it — moved. (2) There was no single "see everything"
  destination — added ui/src/pages/Catalog.tsx (new /catalog route in App.tsx, new sidebar link, last item
  after plugin slots) built on the same workspace-catalog.ts + usePluginSlots data CommandPalette already
  uses. Also checked scope.md's list of things that must stay "discoverable through stable entries/catalog
  paths" (private To-dos, History & usage, Knowledge, Company notes, Administration) against the real app:
  Administration is already covered by the account menu; nothing anywhere implements a Knowledge page or a
  Company notes page. Left them alone rather than build new product surface unsupervised — see implementation.md
  bullet 4 and the "Next action" section above.
Affected preservation IDs / acceptance IDs: F01/F29 (navigation), contributes toward A01-A04/A18/A20 (the
  bullet's stated acceptance targets). No preservation ID directly covers Knowledge/Company notes since they
  don't exist to preserve — flagged as a scope.md gap, not a regression.
Commands and actual results: pnpm --filter @paperclipai/ui typecheck, pnpm --filter @paperclipai/shared
  typecheck -> both exit 0. Full @paperclipai/ui project run twice (once before adding Catalog.test.tsx, once
  after): 185 files/1241 pass -> 186 files/1244 pass, 1 pre-existing skip throughout, zero failures both times.
  One test bug caught and fixed before trusting the result: Catalog.test.tsx's plugin-slot test first gave a
  mock slot the same displayName and pluginDisplayName, so the rendered card's two stacked labels concatenated
  to "NotepadNotepad" and an exact-string assertion failed — not a Catalog.tsx bug, fixed by using two
  different mock values and asserting with .includes instead of exact match.
Browser/manual evidence and test-instance identity (no secrets): None obtained — same constraint as every
  other slice, no credentialed session for paperclip.local:3100. Opened the live sign-in page in the sandboxed
  browser pane to confirm the dev server (PID 3588, unchanged since 2026-09-02) was still serving, then stopped
  there rather than attempt to guess or enter Barry's password.
Data/schema/plugin/runtime impact: None. No database, migration, config, or plugin changes. Live server left
  running and untouched.
Known limitations / baseline failures / rollback: The "Catalog" name and the Knowledge/Company-notes gap both
  need a decision from Barry, not an agent (see "Next action" above and implementation.md bullet 4). Rollback:
  all changes are additive and typechecked/tested; `git diff` / `git checkout -- <path>` per file would cleanly
  revert if ever needed (not needed now).
Barry's feedback and decisions: Woke up, said the app "looks the same" and that he expected to see more done —
  read as feedback that overnight correctness work, while real, wasn't the kind of progress he wanted to see.
  This slice is the direct response: the one part of P1 that's actually visible in the UI. Not yet seen or
  confirmed by him.
Exact next action: An Explore agent was dispatched (2026-09-03, still running as this entry was written) to
  map how the app currently isolates company-scoped data during a company switch — React Query key scoping,
  Layout.tsx's cleanup effect, selected-record/draft state on list+detail pages, and what happens when the
  newly-selected company doesn't support the feature being viewed. This is pure investigation, no code changed
  by it. Once it reports: (1) if query keys are already company-scoped everywhere, most of bullet 7's "stale
  query" concern is likely already handled by construction and just needs a couple of targeted regression
  tests to prove it, not new production code; (2) if any company-scoped page's query key is missing the
  company id, that's a real bug worth fixing directly; (3) the "unsupported access" and "unsaved draft"
  requirements may need Barry's product judgment on specific cases rather than a single general-purpose fix —
  don't invent behavior for those without flagging it the way Knowledge/Company notes were flagged above.
  Whoever picks this up next should look for a follow-up dated entry below this one before re-running the same
  investigation.
Publication authorization: Unchanged — none given.
```

### 2026-09-03 — P1 bullet 7 first slice: two real cross-company data leaks fixed

```text
Date / contributor: 2026-09-03, same session continued, AI agent (Claude Sonnet 5 via Claude Code)
Branch / HEAD / uncommitted paths: ux-control-center @ 558f0096 (unchanged, no commits made). New on top of
  everything above: ui/src/lib/clippy-company-scope.ts + .test.ts, ui/src/pages/Email.composeDraftKey.test.ts,
  ui/src/components/NewIssueDialog.draftKey.test.ts, and one added test in ui/src/components/IssuesList.test.tsx.
  Modified: ui/src/pages/Email.tsx,
  ui/src/pages/Clippy.tsx, ui/src/components/ClippyDrawer.tsx, ui/src/components/IssuesList.tsx,
  ui/src/pages/Inbox.tsx, ui/src/components/NewIssueDialog.tsx, ui/src/pages/Memories.tsx.
Phase and task IDs: P1 bullet 7 ("handle unsupported companies, draft transitions, stale queries, navigation
  memory, and back/forward behavior") — first slice done, not fully complete (see implementation.md for what's
  still open).
What changed in the real app: Dispatched an investigation-only Explore agent first (no code changes) to map
  how the app currently isolates company-scoped data during a switch, rather than guessing at fixes for a
  bullet this broad. It found React Query's cache-key hygiene is already correct everywhere — the classic
  "stale request overwrites the new company's cache" race structurally cannot happen — but pages don't
  remount on a company switch, so component-local state routinely survives one untouched. Two of its seven
  findings were genuine cross-company data leaks, both fixed this slice: (1) Email's "New message" draft used
  global (not company-scoped) localStorage keys and was sent via whichever mailbox was currently selected —
  so a draft typed for one client could be sent from a different client's mailbox after switching companies.
  Fixed by scoping the draft keys to company id. (2) Clippy's open chat session (page and persistent drawer)
  wasn't reset on a company switch, so a company's full chat transcript kept rendering after switching away
  from it — fixed by extracting the reconciliation logic into tested pure functions
  (ui/src/lib/clippy-company-scope.ts) and wiring both Clippy.tsx and ClippyDrawer.tsx to them. Five smaller,
  lower-severity issues from the same investigation were also fixed: a stale mailbox selection in Email.tsx
  causing an error state after switching between two mail-enabled companies; a naive placeholderData in
  IssuesList.tsx and Inbox.tsx that visibly painted a previous company's issue rows under the new company
  with no loading indicator (switched to the already-existing keepPreviousDataForSameQueryTail helper); an
  unreset search term in the same two files (the other half of the placeholderData issue); NewIssueDialog's
  persisted draft carrying company-specific entity ids with no company tag (the dialog's own in-session
  company pinning was already correct — only the localStorage draft wasn't); and Memories.tsx's kind/agent/
  search filters not resetting on a company switch. Deliberately left alone: Calendar.tsx's editingEvent/
  detailEventId (low severity, modal-blocked in practice) and WorkQueues.tsx (already has the correct guard).
Affected preservation IDs / acceptance IDs: A02 (company-scoped data must not cross companies), F05-F11
  (Email), contributes toward A18/A21 (Clippy persistence). Not a preservation-doc regression — these leaks
  predate this project; this slice is fixing pre-existing bugs the redesign work happened to investigate.
Commands and actual results: pnpm -r typecheck (full repo, every package) -> exit 0. pnpm --filter
  @paperclipai/ui typecheck -> exit 0. New tests: clippy-company-scope.test.ts (10/10), Email.
  composeDraftKey.test.ts (4/4), NewIssueDialog.draftKey.test.ts (3/3), plus one new behavioral test in
  IssuesList.test.tsx that simulates an actual company switch (24/24 in that file). Full @paperclipai/ui
  project: 189 files, 1262/1263 pass (1 pre-existing skip), zero failures. Ran the full server vitest project
  in isolation afterward to check for fallout from an earlier, separate slice's packages/shared/src/
  constants.ts change — the only failures were the 3 already-documented chat-account-routing.test.ts
  failures (fix lives in the separate credential-leak worktree, unrelated to this slice).
Browser/manual evidence and test-instance identity (no secrets): None obtained — no credentialed session for
  paperclip.local:3100, same constraint as every other slice this session.
Data/schema/plugin/runtime impact: None. No database, migration, config, or plugin changes. Live server left
  running and untouched.
Known limitations / baseline failures / rollback: Bullet 7 is a first slice, not complete — navigation memory
  and back/forward behavior weren't investigated; "unsupported companies" was checked for only one case
  (Email, already correct); see implementation.md's bullet-7 entry for the full accounting. The IssuesList.
  test.tsx company-switch test needed fake timers to be reliable — a first version with real timers was
  flaky for reasons traced to the search box's own debounce racing the test's assertions, not to the fix
  itself; worth knowing if a similar behavioral test is added elsewhere. Rollback: all changes are additive
  and typechecked/tested; `git diff` / `git checkout -- <path>` per file would cleanly revert if needed.
Barry's feedback and decisions: None yet on this specific slice — not shown to him.
Exact next action: These seven fixes are logic-level correct (typecheck + full suite + new pure-function
  tests) but none has been clicked through live — the two serious ones (Email compose, Clippy transcript)
  are exactly the kind of thing worth Barry actually trying by hand: open a compose draft under one company,
  switch companies, reopen compose, confirm it's empty; open a Clippy chat under one company, switch, confirm
  a fresh/different chat opens rather than the old transcript. If confirmed, continue P1 bullet 7's remaining
  scope (navigation memory, back/forward, a fuller unsupported-company audit) or move to P2.
Publication authorization: Unchanged — none given.
```

### 2026-09-03 — Barry answered the two open questions: "Everything" and the Knowledge/Company notes gap resolved

```text
Date / contributor: 2026-09-03, same session resumed after a gap, AI agent (Claude Sonnet 5 via Claude Code)
Branch / HEAD / uncommitted paths: ux-control-center @ 558f0096 (unchanged, no commits made). Renamed on top
  of everything above: ui/src/pages/Catalog.tsx -> ui/src/pages/Everything.tsx, ui/src/pages/Catalog.test.tsx
  -> ui/src/pages/Everything.test.tsx (both untracked new files, plain rename not git mv). Modified:
  packages/shared/src/constants.ts (reserved route segment "catalog" -> "everything"), ui/src/App.tsx
  (import/route), ui/src/components/SidebarMenu.tsx (link path/label), ui/src/lib/workspace-catalog.ts (new
  Skills entry). Also updated: this file and implementation.md's bullet-4 entry.
Phase and task IDs: P1 bullet 4 (naming decision, was blocking full confirmation) and the bullet-4
  "Knowledge/Company notes" open item (was flagged as a real gap needing a product decision) — both closed
  out this slice, no remaining open decision on either.
What changed in the real app: Asked Barry directly which name he wanted for the new discovery page; he
  wasn't sure "Catalog" was better and didn't recognize "Knowledge"/"Company notes" as existing features, so
  before renaming anything this investigated whether those two mockup terms mapped to real, already-built
  parts of the app rather than assuming they were gaps. They do: `paperclip-ux-audit.md` in this project's
  own reference snapshots spells out "Knowledge = Memories, company skill library" and "Company notes =
  Notepad drafts/converted/archived" — and Memories (`/memories`), the company Skills library (`/skills`,
  `CompanySkills.tsx`, linked from the company dropdown menu), and the Notepad plugin (installed, route
  `notepad`) all already exist in the running app. Reported this back to Barry with the one real, small gap
  found in the process (Skills wasn't in the searchable catalog list) rather than either building new pages
  or silently doing nothing. He confirmed "Everything" as the new page's name, noting it can change again
  later if needed. Renamed the page/route/component/sidebar-link/reserved-segment from "Catalog"/`catalog` to
  "Everything"/`everything` everywhere, and added the one real gap found (`{ id: "skills", label: "Skills",
  routeRoot: "skills", icon: Boxes }` in workspace-catalog.ts), which also makes Skills show up in Command
  Palette search for the first time.
Affected preservation IDs / acceptance IDs: Same as implementation.md bullet 4 (F01/F29, A01-A04/A18/A20) —
  this slice is a naming/completeness correction to that bullet's existing work, not new scope.
Commands and actual results: pnpm --filter @paperclipai/ui typecheck, pnpm --filter @paperclipai/shared
  typecheck -> both exit 0. Targeted run (Everything.test.tsx, workspace-catalog.test.ts,
  company-routes.test.ts) -> 3 files, 19 tests, all pass. Full @paperclipai/ui project: 189 files, 1262/1263
  pass (1 pre-existing skip), zero failures — same counts as before this slice, confirming the rename touched
  nothing else. Full @paperclipai/shared project: 13 files, 72/72 pass, unchanged.
Browser/manual evidence and test-instance identity (no secrets): None obtained — same constraint as every
  other slice, no credentialed session for paperclip.local:3100. The rename and Skills addition have not been
  clicked through live any more than the original Catalog page had.
Data/schema/plugin/runtime impact: None. No database, migration, config, or plugin changes. Live server left
  running and untouched.
Known limitations / baseline failures / rollback: None new. Rollback: all changes are a rename plus one small
  additive entry, fully typechecked and tested; `git diff` / re-renaming the files back would cleanly revert
  if ever needed (not needed now).
Barry's feedback and decisions: Said he wasn't sure about "Catalog" and didn't recognize "Knowledge"/"Company
  notes" as things the app actually has. After the investigation above was reported back to him in plain
  terms, accepted "Everything" as the page name ("Everything works, go with that. if we need to modify later
  we can").
Exact next action: Both open questions from the prior handoff are closed. Resume from where that handoff's
  "next action" pointed before these two questions came up: bullet 3's fuller version (a real host-owned
  workspace/navigation description covering scope kind, availability, and capability restrictions for core
  AND plugin routes together), or continue bullet 7's remaining scope (navigation memory beyond the shortcut
  fix, a page-by-page unsupported-company audit). Both still need Barry's own live click-through of what's
  already built before going much further, per every prior entry's "not yet Barry-confirmed" note.
Publication authorization: Unchanged — none given.
```
