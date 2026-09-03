# UX control center — scope and decisions

Created: 2026-09-02. [Project entry point](2026-09-02-ux-control-center.md).

## Requirements established by Barry

- Multiple companies each have their own agent team. HQ also has a portfolio role and its own company work.
- The existing fork, not upstream screenshots, is the starting product.
- Email is the number-one daily workflow. Calendar and human-operated plugin tools are also first-class requirements.
- Humans must remain able to perform work directly, get AI assistance, or hand it to an agent.
- Preserve expanded menus, the independently collapsible Email folder pane, Clippy's persistent bubble/drawer, and all existing operational depth.
- Refine the real app locally on a provider-neutral branch before pushing or opening a PR.
- Keep the complete working record here so any agent/provider can take over.

## Design direction to implement and evaluate locally

The following is the proposed navigation model, not a sign-off on every label or pixel in mockup 3.

### 1. A stable scope layer

Distinguish these contexts explicitly:

| Context | Meaning | Guardrail |
|---|---|---|
| Portfolio | Aggregate of accessible companies | Creation requires an explicit target; never silently defaults to HQ |
| HQ team | HQ's own agents, work, and data | Must not masquerade as the all-company aggregate |
| Individual company | That company's operating workspace | Queries, records, actions, and agent options remain company-bound |
| Private personal | Signed-in user's private capture | To-dos follow the user and are not silently shared with company agents |
| Shared service/account | Shared PBX or location/account-level data | Show the real account/location scope alongside the current company filter |
| Instance administration | System-wide configuration | Do not imply settings apply only to the currently selected company |

Keep the compact company rail and hover shortcuts as a fast path, with keyboard/touch equivalents. Show the full company name in the workspace header. Show sender/mailbox, caller identity, or public location at the point of an outbound action.

Changing company preserves the current workspace when supported. A clicked shortcut wins over remembered-page navigation. Unsupported access shows a clear unavailable/setup/permission state; it never borrows a different company's data. Clear selected records, cancel or isolate stale queries, and prevent in-flight old-scope results from populating the new scope. Decide explicitly what happens to unsaved forms; preserve them with their original scope or prompt, never silently retarget.

Resuming a company's remembered location may remain an explicit alternative, not a competing implicit redirect.

### 2. A small primary navigation

| Destination | Intended job |
|---|---|
| Email | Daily mail and support operation; eligible preferred landing workspace |
| Calendar | Human commitments and reminders, with an optional automation layer |
| Pinned tools | Phone, Reviews, or other frequently used operational workspaces |
| Overview | Brief, meaningful outcomes, and a company/portfolio summary |
| Attention | Human decisions, approvals, handbacks, overdue commitments, and actionable failures |
| Team | Company agents, objectives, current work, and help needed |
| Work | Tasks, Projects, Goals, Automations, Intake queues, Broadcasts |
| All workspaces | Complete discovery and pinning; not a replacement for daily shortcuts |

Keep private To-dos, History & usage, Knowledge, Company notes, and Administration discoverable through stable entries/catalog paths. Do not mix integration setup with operating the tools it enables. Command search must include Email, Clippy, and plugin workspaces, not only core issue-centric destinations.

### 3. Fully equipped local workspaces

Simplifying primary navigation must not flatten workspace-local controls:

- **Email:** real mailbox/folder tree, nested paths, list/reader/full-size mode, search, grouping, selections, provider-specific controls, sender rules, human composition, and delegation.
- **Phone:** Live, History, Directory, and AI calls with their existing subviews. Maintain distinct scope/permission semantics even when two plugins share one navigation group.
- **Work:** tasks are not queues or routines. Keep their separate lifecycles, deep controls, and links.
- **Calendar:** preserve event details, timezone, recurrence, notifications, and routine navigation.
- **Team:** retain org charts, instruction files, skills, runs/transcripts, configuration, budgets, assistants, and channels behind a current-work-first view.

Coordinate pane sizing and collapse state. Protect usable reader width; offer a deliberate full-size mode. On narrow screens, use explicit pane transitions rather than squeezing five columns together or dropping Email from mobile navigation.

### 4. Persistent Clippy

Keep the bottom-right launcher, resizable drawer, recent chats, full workspace, pop-out, attachment controls, model/effort/permission choices, streaming/stop states, and pending-action visibility. A conversation has its own scope. Switching the viewed company must not reassign a conversation or leak its draft into another chat. Actual permission gates remain authoritative.

### 5. Useful attention and activity

Lead with what changed, who owns the next action, why Barry is needed, and the next useful action. Keep receipts/outcomes separate from raw diagnostic activity.

Working, Watching, Waiting on someone, Needs a decision, Paused, and Failed must be backed by actual evidence. A `blocked` task can be intentionally waiting; a `succeeded` run can report a different failure. Reuse the fork's execution/liveness semantics and represent uncertainty explicitly. Never label the business healthy merely because a run succeeded.

## Existing behavior versus proposed additions

| Item | Classification | Implementation boundary |
|---|---|---|
| New shell, scope identity, grouping, complete catalog | Navigation/UI integration | Reuse current routes and components; preserve deep links and plugin slots |
| Clear sending/calling/location identity | UX improvement to existing operations | Use real configured identities and permissions, not a guessed address |
| Email handoff to an agent | Existing workflow to preserve | Its actual issue creation, read-state, wake, and sender-rule side effects need source-backed treatment |
| Persistent With agents, progress, handback, takeover | Proposed product behavior | Needs durable source-to-work linkage, concurrency and failure design; schema changes require live migration approval |
| Unified meaningful attention / team work summaries | Proposed aggregation/presentation | Define evidence and query contracts before new labels; do not fabricate state |
| Freeform Start work → reviewed plan | Proposed interaction | Current starter catalog filters automation templates; do not claim it is already a general natural-language executor |
| Rich human Google review reply editor | Proposed extension | Current inspected GBP surface is a location summary with agent-tool workflows; public posting needs explicit integration/permission design |
| External Google/Outlook calendar sync | Not established by audit | Existing source styling is not proof of a live connector; do not add or promise sync without separate scope review |
| All administrative fields recreated in mockup | Not implemented by mockup | Preserve real screens; placeholder detail dialogs are navigation examples only |

Proposed additions remain in the roadmap but are not automatically authorized migrations, external writes, or changes in another repository. Record their design and obtain necessary approval before the affected phase. If a feature is deferred, keep the existing capability and label the limitation; do not display simulated functionality as shipped.

## Non-goals

- Replacing the product with a generic dashboard, stock Paperclip, or a theme-only redesign.
- Rewriting the backend/domain model just to fit new labels.
- Renaming API `issues`/`routines` contracts merely because UI labels become Tasks/Automations.
- Removing provider-specific functionality, technical diagnostics, approval gates, budgets, or plugin pages.
- Reintroducing upstream telemetry/phone-home, changing agent providers, or adding dependencies without need.
- Production deployment, upstream synchronization, plugin releases, database resets, or external publication during local refinement.

## Decision register

| ID | Decision | State / rationale |
|---|---|---|
| D01 | Provider-neutral branch `ux-control-center` | User direction; no provider prefix |
| D02 | Project authority in `docs/plans/` | User direction; no private-agent-only dependency |
| D03 | Existing functionality is the preservation baseline | User direction; mockup omissions do not authorize removal |
| D04 | Email stays primary | User direction; exact default-landing preference can be refined locally |
| D05 | Portfolio and HQ team are visibly distinct | Proposed implementation direction addressing observed ambiguity |
| D06 | Preserve workspace on company change | Proposed; verify shortcut, detail, draft, and unavailable-state rules in P1 |
| D07 | Local working checkout, not a separate live clone | Agreed local workflow; process/database binding still needs verification |
| D08 | No push/PR until Barry approves | User-controlled publication gate |
| D09 | Additive UI work before behavior/schema expansion | Risk-control approach; preserves existing service contracts |
| D10 | Runtime rollback strategy chosen before shell replacement | Resolved 2026-09-02 (agent-proposed default, not yet Barry-reviewed — see rationale below) |
| D11 | Extension repository changes | Open only if needed; coordinate its own branch/deployment path before edits |
| D12 | Server-side restart safety gate | Agreed working rule 2026-09-02 (agent-adopted from P0 findings, not a product decision) |

D10 rationale: the new shell (P1) will wrap the *same* pages, routes, company context, and data hooks the current `Layout`/`Sidebar`/`CompanyRail` use — it must not fork business logic or duplicate the data layer (that would violate the "single domain implementation" preference and create drift risk). The chosen mechanism is a navigation-chrome-only runtime toggle: keep the existing shell components importable and working, add the new shell as a sibling, and gate which one renders behind a simple flag (instance setting or equivalent already-established settings surface, defaulting to a stored preference so Barry can flip back instantly without a git revert or restart). Both shells read the same pages/hooks/contexts underneath. This is an implementation-detail default chosen to keep P1 reversible cheaply; it is not a product/UX decision and does not need sign-off to start, but Barry should be told the toggle exists and where, the first time he sees the new shell.

D12: before any server restart during this project (a UI-only edit under Vite dev middleware does not need one), rerun the read-only migration check recorded in the runbook's "P0 verification results" section. If it reports anything other than `upToDate`, do not restart via `pnpm dev`/`dev:once`/`run` without first setting `PAPERCLIP_MIGRATION_PROMPT=never` (so the server refuses to start instead of silently migrating) and getting Barry's explicit approval for the specific pending migration list. Applies for the whole project life, not just P0.

Record new decisions with date, rationale, affected features/tests, and whether Barry approved them. Do not silently upgrade a proposal to an agreed requirement.
