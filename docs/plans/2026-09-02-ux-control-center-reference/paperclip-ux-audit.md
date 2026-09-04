# Paperclip: operator workspace / information architecture audit

Reviewed September 2, 2026. Scope: the running customized fork at `paperclip.local:3100`, `~/paperclip/ui`, and the installed plugin implementations in `~/paperclip-extensions`.

## Conclusion

Paperclip is already more than an agent dashboard. It is a multi-company operator workspace: Barry personally reads and sends mail, manages support conversations and reminders, observes the phone system, and asks agents to act on the same work. The first mockup captured supervision but underweighted direct operation. Email belongs at the front, not under a miscellaneous Operations menu.

Preserve the first mockup's clear scope and calmer shell. Add first-class daily workspaces and a shared human/agent ownership model. Regroup existing capabilities; do not replace them with a generic dashboard or force every interaction through task creation.

## Review boundaries

- Walked the main company and portfolio navigation, representative task/project/goal/routine/agent details, company and instance settings, all installed plugin page families, and safe composition/setup dialogs.
- Inspected React route/shell/context code, the main workspaces and their shared components, plus installed plugin manifests and relevant UI implementations.
- No application source changes, sends, calls, task creation, agent wakeups, approvals, deletion, restore, or other operational mutations were performed. Opening pages naturally affects navigation memory; view toggles were used during inspection.
- This was a UX audit, not an end-to-end execution test. Every record and every destructive/configuration branch was not exercised. Authentication/invitation redemption, onboarding completion, installation, backup restore, and disabled experimental workflows were not executed.
- Live counts changed while background agents were running. Counts below describe observed states, not a current system-health report. Mockup contents are explicitly illustrative, not copied live mail or customer records.

## Highest-impact findings

### 1. Email is a full working environment, not a notification stream

Current company Email supports IMAP folders, search, unread/all, sender grouping, rich reading, attachments, composing, replying, forwarding, AI drafts, moving messages, sender rules, bulk operations, and agent handoff. The same surface embeds a Help Scout workspace with open/active/pending/closed/spam states, private notes, replies, drafts, attachments, and durable triage rules. Portfolio Email already spans multiple companies and both providers.

At desktop width the company rail, primary sidebar, mailbox tree, message list, and reader compete for horizontal space. Many consequential actions are icon-only. Account identity is stronger in the mailbox list than at the moment of sending. Rule learning is easy to overlook: marking read/replying/handing off may implicitly add a keep-always rule for an unclassified sender. Rules are administered down inside plugin configuration.

**Direction:** Email is a pinned top-level workspace and can be Barry's preferred home. Use a compact mailbox/folder picker plus list and reader; retain an expandable mailbox tree for heavy filing. Make the sending identity, company, provider, ownership, and next action explicit. Expose mail-handling rules inside Email; keep credentials/connections in Administration.

Source: `ui/src/pages/Email.tsx`, `PortfolioEmail.tsx`, `ui/src/components/HelpScoutEmailView.tsx`, `HelpScoutMailboxPanel.tsx`, `ui/src/components/email/EmailPopoutDialog.tsx`.

### 2. Handoff loses the source-workspace continuity

Company email handoff creates an issue, attempts to wake the selected agent, marks the message read so it leaves the unread list, and can create a keep-always rule. The return path is primarily a toast linking to the new issue. The source email does not become a clear ongoing case with persistent owner, progress, review status, and return-to-human controls. A failed wake is logged while the handoff still completes.

**Direction:** keep the email visible in a “With agents” view, linked to its work record. Show who owns the next step, the latest meaningful update, draft ready for review, and a way to take over. Human reply and agent handoff remain peers. Unread, unresolved, assigned, and waiting-for-review are different dimensions. Do not merely rename unread to “To handle” without explicit resolution/ownership data.

This continuity requires product behavior and probably durable linkage, not just CSS. Avoid inferring whether an email is handled from read status alone.

Source: `ui/src/pages/Email.tsx`, especially the handoff mutation around lines 1060–1120.

### 3. There are more scope types than “company”

- Portfolio pages aggregate across companies, but are mounted under HQ. HQ also has its own agents and work.
- Company switching can restore a different remembered page, making scope changes feel like unrelated navigation.
- The full current company name is not always visible in the content header.
- To-dos are private to the signed-in user and deliberately follow them across companies.
- Notepad is company-scoped and only available to configured companies.
- Some 3CX objects are company-filtered; extensions/trunks can represent a shared PBX.
- The current GBP Reviews page shows a portfolio-wide location summary even when reached under different company prefixes.
- Backups and most technical settings are instance-wide.

**Direction:** separate “Portfolio — all accessible companies” from “HQ team — company work.” Keep the same workspace when switching companies if it is supported; show an explicit unavailable/setup state otherwise. Show full scope in chrome and account/location identity on every outbound action. Shared tools must show their actual scope, not just inherit a misleading company header. Personal To-dos get a visibly personal utility entry.

Source: `ui/src/components/CompanyRail.tsx`, `Sidebar.tsx`, `SidebarMenu.tsx`, `Layout.tsx`, `ui/src/hooks/useCompanyPageMemory.ts`, `ui/src/pages/PluginPage.tsx`; To-dos/Notepad/GBP/3CX plugin implementations.

### 4. Human attention is not the same as a blocked task or a successful run

The inspected Help Scout watcher intentionally parks its work in `blocked` while waiting for new mail; a plugin watch resumes it. A successful agent run can simply report that nothing new arrived. Repeated routine runs and low-level lease/activity events overwhelm useful changes. Some lists include paused schedules with stale next-run times or repeated empty company sections.

**Direction:** distinguish Working, Watching, Waiting on someone, Needs your decision, Paused, and Failed. These must be based on real workflow semantics, not guessed from `blocked` or `succeeded`. Human attention should show why action is needed, impact, age, responsible company, owner, and the next decision. Watching healthy mail automation is not an alert. Receipts remain outcome history; raw events remain available in diagnostic history.

Source: `MorningBrief.tsx`, `PortfolioBrief.tsx`, `Inbox.tsx`, `Issues.tsx`, `IssueDetail.tsx`, `DashboardLive.tsx`, `AgentDetail.tsx`, `Activity.tsx`, `Receipts.tsx`, portfolio counterparts. Live representative record: IND-1075 and its routine.

### 5. Plugin packaging currently determines navigation too much

The HQ sidebar combines portfolio destinations, ordinary HQ destinations, and plugin-contributed navigation. Phone adds a nested Live/History/Directory tree; AI Calls adds a second related tree. GBP Reviews registers a page and dashboard widget but no comparable sidebar entry. Plugin pages show generic plugin breadcrumbs and Back-to-Brief behavior rather than a stable workspace location.

**Direction:** group by operator job, not plugin package. One Phone workspace contains PBX Live, History, Directory, and AI calls. A workspace catalog lists enabled tools with pinning and clear capability/scope information. Plugin Manager remains administration. Plugins need a host-owned navigation contract for workspace, local tabs, scope, availability, and contextual actions, while retaining their existing pages/tools.

Source: `ui/src/pages/PluginPage.tsx`, `ui/src/plugins/slots.tsx`, `ui/src/components/SidebarMenu.tsx`, 3CX `PhoneSidebarItem.tsx`, Phone `AiCallsSidebarItem.tsx`, plugin manifests.

### 6. Calendar needs both a human view and an automation layer

The current Calendar combines actual reminders, recurrence, notifications, and routine occurrences. A payroll reminder can compete with repeated monitoring runs. Portfolio list views also show completed/cancelled historical test entries. Current known calendar sources are Paperclip and routines; Google/Outlook styling alone is not evidence of an active external calendar integration.

**Direction:** Calendar stays a first-class workspace. Default to upcoming human events/reminders with overdue reminders visible; offer a separate, toggleable agent-schedule layer, grouped for frequent recurrence. Preserve timezone, recurrence, lead time, notifications, status, and company selection. Automation authoring belongs in Work → Automations, linked from Calendar.

Source: `Calendar.tsx`, `PortfolioCalendar.tsx`, `ui/src/components/calendar/*`.

### 7. Human phone/review functionality needs precise treatment

The 3CX pages inspected are operational displays: live calls, parked calls, queues, people/extensions, wallboard, history, recordings, daily report, DIDs, extensions, trunks. The plugin also has mutating agent tools, but those tools should not be described as existing buttons on the read-only pages.

The separate Phone plugin already provides real human controls for configured assistants. Alex in Personal exposes “Have Alex call someone,” “Test on my phone,” and human transfer configuration. The agent Phone tab is blank on non-assistant agents. Campaigns, inbound routes, DNC, and audit have separate pages; some route/DNC editing is not implemented in the current UI.

GBP Reviews currently renders location-level totals/rating/unreplied summary; the inspected UI has no review-list/reply editor. Replying is present in agent-tool/issue workflows. A richer human review workspace is a proposed extension, not just a rearrangement of existing UI.

Source: 3CX `src/ui/*`; Phone `AgentPhoneTab.tsx`, `PlaceCallModal.tsx`, `WarmTransferModal.tsx`, `CampaignsPage.tsx`, `InboundRoutesPage.tsx`, `DncListPage.tsx`; GBP `src/ui/index.tsx` and manifest.

## Proposed navigation and preservation map

The sidebar has a small stable control section plus individually pinned workspaces. Email and Calendar are pinned by default for this operator. Phone and Reviews are shown as pins in the mockup; less-used tools remain in All workspaces. No plugin is silently removed.

| Destination | Existing surfaces preserved | Scope / interaction |
|---|---|---|
| Overview | Brief, portfolio Brief, company summaries, meaningful live work | Portfolio or company. HQ team is separately selectable. |
| Attention | Inbox, approvals, access/join requests, failed work, required reviews | Actionable queue, not email unread or raw activity. |
| Email | Company/portfolio Email, IMAP, Help Scout, drafts, rules, attachments, folders, notes, handoff | Mailbox/company/provider explicit; human reply or agent ownership. |
| Calendar | Company/portfolio Calendar, reminders, recurrence, notifications, routine occurrences | Human schedule plus optional agent-schedule layer. |
| Phone | All eleven 3CX pages; assistants' phone controls; campaigns/rollup, inbound routes, DNC, audit | Local tabs, shared-PBX identity, explicit calling company/assistant. |
| Reviews | GBP summaries/widget, review ingestion, agent reply workflow | Actual portfolio/location scope. Proposed human reply UI separately identified. |
| Work → Tasks | Issues, details/chat, attachments/documents, subissues, related work, history | Human-readable “Tasks” label; IDs and full technical detail retained. |
| Work → Projects / Goals | Project lists/detail/overview/configuration/budget; goals/subgoals | Keep goals distinct from projects and tasks. |
| Work → Automations | Company/portfolio routines, triggers, schedules, delivery, runs/activity | Do not collapse recurring work into a task list. |
| Work → Intake queues | Work Queues, pending/claimed/completed/failed/cancelled items | Distinct incoming stream, not another name for Tasks. |
| Work → Broadcasts | Portfolio Directives, per-company execution/progress | Explicit multi-company target/preview. |
| Team | Agents, active/paused/error views, org chart, assistants, instructions, skills, configuration, runs, budgets, channel controls | Visible company grouping; current objective and next step first. |
| Knowledge | Memories, company skill library | Agent-readable durable knowledge. Keep memory categories and skill semantics. |
| Company notes | Notepad drafts/converted/archived and conversion to work | Company-scoped capture; original note retained. |
| My to-dos | Private quick capture, due dates, completion, promotion to work | Global personal scope, never silently shared with agents. |
| History & usage | Receipts, raw Activity, run/transcript detail, costs, budgets, providers/billers/finance | Outcomes first; diagnostic events accessible. $0 does not imply no resource use. |
| Clippy | Chat, contextual help/action requests, existing scoped capabilities | Persistent utility; explicit current target and action preview. |
| Administration → Company | Identity/branding, human access/invites/secrets, import/export, archived company management | Scoped settings, not operator task navigation. |
| Administration → System | Profile/access, outbound approval policy, identity safeguards, retention, heartbeats, templates, adapters, models, external MCP, experiments, logs, roadmap | Instance scope visibly different from company scope. |
| Administration → Integrations / Backups | Plugin manager/configuration, connection setup, backups schedules/destinations/history/restore | Keep dangerous controls in administration with existing protections. |
| All workspaces / contextual tools | Slack Tools, Print Tools, Code Scanner and future enabled plugins | These installed tools do not all have current standalone operator pages. Discover by capability; avoid fabricated empty workspaces. |
| Advanced work detail | Experimental workspaces/environment configuration/runtime logs | Preserve behind relevant project/task; do not promote disabled internals to primary navigation. |

## Live coverage register

“Inspected” below means navigation and visible read-only state, plus relevant source; it does not mean every mutation was executed or that integration behavior was certified.

| Area | Pages/states inspected | Material observations / limitations |
|---|---|---|
| Shell and scope | HQ and eight active operating-company rail entries, company menus, navigation, breadcrumbs, company switching | Company route memory; HQ doubles as aggregate and company. Companies administration also includes archived/stub companies. |
| Overview/attention | Company Brief, portfolio Brief, Inbox, portfolio/company approvals | Preserve actionable queue and clarify health semantics. No approval was submitted. |
| Portfolio | Brief, Email, Calendar, Agents, Issues, Directives, Routines, Approvals, Activity, Receipts, Costs | Empty-company repetition, different inclusion of HQ, noisy history, stale paused schedule dates. |
| Email | Industry IMAP list/reader, compose/handoff dialogs; Industry Help Scout mailbox/conversation controls; portfolio multi-mailbox view | No messages sent, filed, deleted, triaged, or handed off. Some already-read mail was opened. |
| Calendar | Company list/month, routine occurrence navigation; portfolio list/filters, new reminder dialog | No reminder saved. Paperclip/routine sources verified; external sync not assumed. |
| Work | Issues; representative issue/chat/activity/related work; projects/detail tabs; goals/detail; routine/detail; work queues | Intentionally blocked mail watcher; repetitive automation issues. Empty queues are still real workflows. |
| Agents/team | Org/agent lists, portfolio teams, agent Dashboard/Instructions/Skills/Configuration/Runs/Budget/Phone | Instructions/adapter controls kept separate from operator overview. Non-assistant Phone tab blank. |
| Assistants | Industry empty list; first step of eight-step builder; Personal Alex; Alex's Phone actions | Actual configured Personal assistant verified. No test or outbound call placed; no assistant created. |
| Knowledge/capture | Memories; Industry Notepad unavailable; Personal Notepad working; private To-dos | Availability is company-specific; To-dos global personal. |
| History/usage | Receipts, Activity, Costs tabs, Dashboard Live, portfolio counterparts | Raw lifecycle/lease noise can crowd meaningful outcomes; no backend root-cause claim for differing receipt counts. |
| 3CX Live | Active calls, parked calls, queues, agents/presence, wallboard | All five visited. Distinguish human extensions from AI agents. |
| 3CX History | Call history, recordings, daily report | Daily report remained loading during audit; cannot claim it rendered successfully. |
| 3CX Directory | DIDs, extensions, trunks | Shared PBX directory can include other-company objects. |
| AI Calls | Campaigns, inbound routes, DNC list, audit | Empty/configuration states inspected. Some editing flows described as not implemented. |
| GBP Reviews | Industry, M3 Media, C3 Media page mounts; same M3 Printing summary | Summary-only current UI; portfolio scope despite company URL. No public reply posted. |
| Backups | Overview, Schedules, Destinations, History | No Run backup or Restore operation clicked. |
| Company admin | Companies, Settings, Access, Invites, Secrets, Skills, Import, Export | Sensitive pages inspected for structure, not credential values. Export did not render a substantive state during the audit wait. |
| Instance admin | Profile, General, Access, Heartbeats, Templates, Adapters, Agent defaults, External MCP, Experimental, Logs, Roadmap | Roadmap did not render substantive content during audit wait. Template editing and settings were not saved. |
| Plugin management | Installed list; relevant email/helpdesk configuration structure, plugin route/contribution registrations | 11 installed plugins inventoried below. Connection secrets not copied into report/mockup. |
| Advanced/disabled | Workspaces navigation + route/code inventory | Workspaces redirected to Issues while experiments were disabled. No experimental workspace created. |

Installed plugins: 3CX PBX Tools, Backups, Code Scanner, Email Tools, GBP Reviews, Help Scout, Notepad, Phone, Print Tools, Slack Tools, To-dos. Other packages in the extensions repository are not automatically treated as installed functionality.

## Interaction contract before implementation

1. Company switching preserves the current workspace when possible; it never preserves a selected message/record from another company. Unsupported scopes show an explicit state, not mixed data or a silent redirect.
2. Each action carries an explicit target company and account/location. Portfolio selection alone must not silently choose an outbound identity. Existing company access boundaries remain authoritative.
3. Direct actions stay native to their workspace: Compose, Reply, New reminder, Have assistant call. “Start work” is for expressing an outcome, not a toll gate for sending an email.
4. Every delegation has source context, one accountable owner, visible progress, return-to-human behavior, and approval requirements. Existing outbound approval policies and budget stops are preserved; the redesign must not weaken them.
5. Agent work is summarized in outcome language. Raw runs, logs, tools, tokens, IDs, and configuration remain drill-downs.
6. Navigation pinning changes prominence, not availability or permissions. Plugin-provided pages, contextual actions, and agent tools remain discoverable.
7. Personal To-dos, company Notepad, agent Memories, and skills keep their different ownership and lifecycle semantics.
8. Failure and unavailable states are designed explicitly. Stale data cannot look live; not-configured cannot look like zero activity; paused cannot have a misleading imminent run.

## Suggested delivery sequence — not authorization to implement

1. Agree on shell, scope contract, pinned workspaces, and preservation map.
2. Rehouse existing routes without changing their data models; retain deep links and complete functionality.
3. Improve Email space/identity/rules ergonomics and Calendar layers.
4. Design and implement durable source-to-agent handoff continuity with clear migration and tests.
5. Consolidate Phone navigation; expose existing assistant controls without bypassing safeguards.
6. Treat richer human review handling and any missing phone operation controls as separately scoped product additions.
7. Validate portfolio/company isolation, read/unread vs handled semantics, keyboard/mobile behavior, plugin availability, setup/errors, and all outbound/approval paths before rollout.

No application implementation has begun.

## Mockup validation

The revised, isolated concept has sample data only and no network APIs. JavaScript syntax and 161 DOM interaction assertions passed, including navigation across all represented scopes, email handoff/takeover, company-filtered messages, calendar layers, all Phone subviews, review drafting, pinning, and escaped private-note input. This is DOM-only validation, not browser layout/theme/screenshot validation or an application integration test. The Paperclip worktree remained unchanged.
