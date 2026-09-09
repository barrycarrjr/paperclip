# Paperclip: expanded-state interaction audit

September 2, 2026 · Live customized fork at `http://paperclip.local:3100`

This supplements [the page and feature inventory](./paperclip-ux-audit.md). It specifically checks the hidden interaction layers that the earlier mockups did not represent adequately. The existing mockup is a direction study, **not an implementation-ready specification**.

## Bottom line

The product should have a simpler entry layer and retain rich workspaces underneath it. Flattening everything into a dashboard, a single menu, or generic detail dialogs would remove useful functionality.

Email is the clearest example: the company rail, application sidebar, mailbox/folder pane, message list, reader, full-size reader, compose dialogs, and Clippy drawer all serve different purposes. They need coordinated behavior, not wholesale removal.

No application source was changed. No message, call, AI draft, handoff, task, routine, note conversion, approval, or reminder was submitted. No delete, archive, pause/resume, reset, restart, restore, or other operational action was executed. Safe UI disclosures and presentation controls were exercised. Tested persistent display settings were restored, including the Email folder-pane width to 176px. Navigation itself naturally updates the app's remembered locations.

## What the mockup missed

1. **A real mailbox/folder navigation pane.** The previous “Folders & handling” dialog is not an adequate replacement for the independently collapsible and resizable pane used for daily filing.
2. **Clippy as a persistent conversation system.** A generic “Ask Clippy” modal misses the bottom-right launcher, resizable drawer, recent chats, full chat workspace, pop-out affordance, attachments, model/effort choices, and permission handling.
3. **Company hover shortcuts.** With the application sidebar collapsed, hovering another company's rail icon exposes its actual navigation. This is a valuable power-user shortcut.
4. **Human operation within each workspace.** Replying, forwarding, composing, adding a private support note, creating a reminder, and asking an assistant to call someone are not all instances of one generic task form.
5. **Secondary controls that change how people work.** Issue nesting, list/board configuration, routine variables and delivery policy, calendar notification settings, agent instruction files, and provider-specific mail behavior cannot be represented by labels alone.
6. **Unavailable and failed states.** A workspace may be visible but not routed/configured for a company. A blank or broken page must not be presented as “nothing happening.”

## Expanded states inspected live

“Live” means the control was opened or its visible state was inspected, often with screenshots, not that its consequential action was executed. The earlier inventory covers the broader page families; the following adds interaction depth.

### Shell and company navigation

- Main hamburger: hides application navigation independently of the company rail and page-local panes.
- Company hover flyout: exposes full company navigation, including nested plugin entries and the Personal/private label.
- Company menu: invitation, skills, costs, and company settings—not the same thing as the company switcher.
- Account menu: profile, instance settings, appearance/help, and application lifecycle controls. Lifecycle actions were not clicked.
- Phone and AI Calls nested sections: Live, History, Directory, Assistants, Campaigns, Inbound routes, DNC, and Audit log. Open/closed controls inspected and tested sections restored.
- Command palette: actions and company-scoped issue/agent/project results. Its navigation catalog does not include Email or the complete plugin workspace set.
- Plain-language starter catalog: “What do you want done?” filters starter automations. It is not a general-purpose freeform delegation composer; “Turn this on” is an actual activation action and was not clicked.

### Email: IMAP and portfolio mail

- Independent application-sidebar and mailbox-column collapse/expand.
- Folder divider drag and double-click behavior; original width restored.
- Provider-specific folder lists, including deeply nested IMAP paths and Gmail-style labels.
- Folder selection with the unread-only empty state; returned to INBOX.
- Sender grouping and its group-level toolbar, including folder destination menu; returned to flat list.
- Hover-revealed message action toolbars.
- Selected-message narrow list plus reader; full-size message overlay.
- Full-size handoff panel with company agent choices and optional instructions; no handoff submitted.
- Full-size reply, reply-all affordance, and forward forms; no content entered or sent.
- New-message composer, separate AI instruction field, attachments affordance, and draft-model dropdown; no draft generated, model changed, or upload performed.
- Portfolio mail's per-mailbox grouping and secondary action menu.

Important observations:

- At 1280px, the full navigation/folder/list stack leaves a narrow reader. The independent collapse controls and full-size reader are functional necessities.
- The full-size reader identifies company/mailbox in its header. The new-message dialog does not provide an equally prominent explicit From/company identity.
- The full-size reply/forward panel and the main Email composer do not have identical capabilities. The main composer exposes AI Draft/Revise and attachments; do not promise perfect feature parity merely because the toolbar looks similar.
- Keep-always and auto-triage are durable rules, not just sorting controls. Their consequences need clear labels and feedback.
- Read/unread, agent ownership, unresolved work, and waiting for human review must remain separate concepts.

### Email: Help Scout

- Shared mailbox selection; Open/Active/Pending/Closed/Spam navigation.
- Conversation list, bulk-selection affordances, thread and attachment presentation.
- Private-note composer and human-reply composer.
- Reply attachments, separate AI drafting instructions, model selector, and send action.
- Provider-specific keep-active/auto-noise and status actions were inspected but not executed.

The Help Scout reply and private-note panels can both be open. In the narrow reader, stacked composition controls occupy substantial space. A redesign must distinguish the public reply from the internal note and preserve provider semantics rather than impersonating every provider as IMAP folders.

### Clippy

- Bottom-right bubble on ordinary workspaces.
- Resizable conversation drawer and its separator; current chat remains available without leaving Email.
- Recent-chat dropdown, full-page chat list, and hover-revealed chat menu.
- Nested filter/sort menus: active/archived/all, company, last activity, grouping, and sort order.
- Model, effort, and permission menus opened without changing selections.
- Attachment controls inspected without uploading.
- Existing historical chats opened and original selection restored. The sampled historical chats showed text replies or authentication errors, not tool cards.
- Pop-out affordance was clicked earlier in this audit. The drawer closed, but the separate window was not exposed by the browser tool, so its rendered behavior is **not visually verified**.

Source review additionally verified pending-action badges, permission cards, expandable tool input/result details, streaming/stop behavior, and pop-out restrictions during streaming. No live permission request or tool execution was created to test those states.

### Tasks, attention, and recurring work

- New-issue participant menu expanded to show separate reviewer and approver rows; no task created.
- Issues: column picker, full filters, sort/group menus, list/board views, board card-field picker. List mode and existing filters retained/restored.
- Parent-child nesting controls inspected; existing nesting preference left enabled.
- Issue detail: overflow menu and independently collapsible right-hand Properties pane. Relationships include parent, blockers, related tasks, reviewers, and approvers—not just assignee/status.
- Inbox: Mine/All navigation, category menu, approval-state menu, grouping/column affordances. Returned to Mine; nothing marked read in bulk or dismissed.
- Routines: row menu, new-routine advanced delivery disclosure, existing routine variables, triggers, delivery settings, and Runs tab.
- Work Queues: empty state and safe new-queue form. Populated item lifecycle/details reviewed in source because the sampled company had no queue data.
- Receipts: outcome categories and linked outcome rows; source reviewed for aggregation limits and entity navigation.

Useful controls are currently scattered behind small icons. Keep the power, but provide recognizable view settings and an operator-oriented starting view.

### Calendar

- Company List and month Calendar views; real reminder detail.
- Source-layer toggles for Paperclip and Routines; original source visibility restored.
- New-reminder form with repeating schedule, timezone, event kind, all-day and notification options.
- Slack selection in an unsaved new form reveals its target field; desktop delivery and lead-time controls inspected. Form cancelled.
- Portfolio new-reminder form explicitly requires company selection, rather than silently defaulting to HQ or the first company.

The month grid can be dominated by repeated monitoring routines. Keep automation visible as a deliberate layer while making human appointments/deadlines easy to see. Also distinguish occurrence time from notification time: a lead-time-adjusted next firing can be earlier than the displayed schedule.

### Teams, assistants, and Phone

- Company org chart zoom/fit and agent navigation.
- Agent Dashboard, overflow menu, Instructions advanced disclosure and file tree, Runs list and expandable diagnostic detail.
- Portfolio Agents: company/status filters and list/org-tree modes. Returned to list; no agent selected for bulk action.
- Configured Personal assistant Alex: Phone tab and native “Have Alex call someone” form, including image-input affordance and spend cap; form cancelled.
- Warm-transfer configuration form, including destination, spoken handoff, and project linkage; cancelled without saving.
- Recordings: date-range controls including Custom; returned to original preset. No recording played or downloaded.
- Campaigns: list/status controls and portfolio-rollup subview.

Agent technical configuration remains necessary, but it should not be the default answer to “what is my team doing?” Preserve the org chart, channels, instructions, skills, budget, and run details behind a team/activity overview.

### Capture and knowledge

- Notepad: selected an existing draft and opened its Convert-to-issue preview. This explicitly preserves the original note and offers optional AI expansion. No conversion or edit performed.
- To-dos: current empty personal state inspected. Hover actions, due-date editing, completion, reordering, and promotion reviewed in source only; no synthetic to-do was created to populate it.
- Memories: new-memory dialog and company-wide versus individual-agent scope choices; cancelled.

These are not interchangeable: To-dos are private personal capture; Notepad is company capture; Memories are durable information for agents; skills define repeatable capability.

## Concrete failures and inconsistencies

These are observations, not code changes or a complete backend diagnosis.

### Company navigation can lose the intended destination

Observed flow: from Industry with the main sidebar hidden, hover Personal and choose Email. The destination became `/PER/PER/notepad`, showing Page not found, rather than Personal Email. Later a normal company switch also produced `/IND/IND/clippy`.

The routing helpers only strip a company prefix when the next segment belongs to a hard-coded core-route list. Plugin slugs such as `notepad` are absent; `clippy` is absent from the global-route list even though `clippy-popup` is present. Company-page memory then prefixes the remembered path. The hover shortcut also changes company and navigates, while the memory hook independently navigates on company change. This is a source-supported explanation of the observed failure, not an integration-tested patch.

Relevant source: `ui/src/lib/company-routes.ts`, `ui/src/lib/company-page-memory.ts`, `ui/src/hooks/useCompanyPageMemory.ts`, `ui/src/components/SidebarNavItem.tsx`.

### Clippy retains a stale page breadcrumb

After entering the full Clippy workspace, the top breadcrumb still said Email on one visit and Agents → CEO → Runs on another. `Clippy.tsx` does not establish its own breadcrumbs. This creates a context problem even when the conversation itself is usable.

### Campaign portfolio rollup fails

Opening Personal → Campaigns → Portfolio rollup returned `Campaign portfolio-rollup not found.` On the earlier visit the plugin eventually showed its failed-to-render fallback. The rollup's refresh code accepts a JSON body without the initial request's status check, which can explain why an error response later becomes a render failure; this remains a source-supported inference. The feature should show a stable unavailable/error state and a route back, not disappear.

Relevant source: Phone plugin `src/ui/CampaignsPage.tsx`, `src/ui/PortfolioRollup.tsx`, and route declarations.

### Plugin visibility is not readiness

Personal exposes the 3CX navigation, but Recordings returned `ECOMPANY_NOT_ROUTED` with instructions to configure company routing. The next design needs distinct states for available, configured, inactive, unavailable, and failed. It must not conflate these with “0 calls.”

### Activity counts are not meaningful work counts

The Industry issue list and CEO run history contained many repeated silent-run review entries. A succeeded run can be a report about another failed or intentionally waiting operation. The earlier audit's healthy-watcher example must not be generalized into a claim that the current company is healthy: both waiting and failure narratives appeared during this pass. Determine attention from actual workflow evidence, not `blocked`, `done`, or `succeeded` alone.

## Revised overall interaction model

### A stable scope layer

Use visibly distinct **Portfolio**, **HQ team**, and individual-company contexts. Preserve the compact company rail and its hover shortcut as an optional fast path. Keep the current workspace when changing scope where supported; make “resume this company's last location” an explicit alternate behavior rather than overriding a clicked destination.

Show the full company name in the workspace header. On outbound operations also show the actual mailbox, caller identity, location, or account. Shared PBX, private personal tools, and instance settings must state their real scope.

### A small primary navigation with real workspaces

- **Overview** — meaningful company/portfolio summary.
- **Attention** — decisions, approvals, failed work, overdue commitments, and handbacks that require the human.
- **Email** — permanently prominent for Barry; eligible to be the preferred landing workspace.
- **Calendar** — human schedule with optional automation layer.
- **Team** — company agents, current objectives, live work, waiting states, and help needed.
- **Work** — tasks, projects, goals, automations, intake queues, and portfolio broadcasts.
- **Pinned tools** — Phone, Reviews, and any other daily operator workspaces.
- **All workspaces** — complete discovery, not a dumping ground for frequently used tools.

History/usage and administration get stable secondary entries. Personal capture remains visibly personal. Integration administration is different from operating the tools those integrations provide.

### Workspace-local navigation remains intact

Email retains mailbox/folder navigation; Phone retains Live/History/Directory/AI-call subviews; Work retains its distinct object types; Calendar retains views and source layers; Team retains hierarchy and profile tabs.

The navigation shell should coordinate collapsible panes, minimum reader width, and narrow-screen behavior. Do not turn every secondary panel into a generic modal. Presentation choices should survive navigation without leaking a selected record into another company.

### Human action and agent delegation are peers

Inside each workspace, people can do the work directly, get assistance, or delegate it. Preserve native forms and provider-specific controls. For a delegation, show the source item, target company, accountable agent, intended outcome, permission boundary, progress, and handback.

Persistent “With agents,” takeover, and resolved-versus-unread states are proposed behavior requiring durable linkage—not merely visual relabeling of the existing email list.

### Clippy is a persistent utility

Retain the bubble, drawer, full-page history, and separate-window affordance. Preserve recent-chat switching and advanced composer controls. Clearly show the conversation's scope, which may differ from the page the operator is viewing; do not silently reassign an existing conversation when a company changes.

Pending Clippy permission requests should be visible from the launcher and connect coherently to human attention. Keep the actual permission boundary; the redesign must not turn an approval into a decorative confirmation.

## Required demonstration flows for the next mockup

The next mockup should be assessed by completing these flows, not by whether every feature name appears somewhere:

1. Switch company while in Email; the workspace stays Email and the mailbox/record context changes safely.
2. Collapse the main navigation, use a company hover shortcut, and return to expanded navigation.
3. Expand the real mail folder pane, choose a nested folder, resize/collapse it, open a message, and enter/leave full-size reading.
4. Compose/reply/forward with a clearly visible sending identity; inspect attachments and AI-assisted draft controls.
5. Open Help Scout, distinguish reply from private note, and inspect its status/triage controls.
6. Delegate an email and find it again with its owner and progress; clearly label any proposed behavior absent from the app today.
7. Open Clippy from an ordinary workspace, switch conversations, inspect permission/model/effort controls, and return without losing the workspace.
8. Show a pending Clippy action and a declined/interrupted/failed state using illustrative data, without claiming those states were live-tested.
9. Open Calendar, separate human events from routine schedules, and configure an unsaved recurring reminder including timezone and notifications.
10. Create from Portfolio only after choosing the target company; distinguish HQ's own team from the all-company view.
11. Find a company's agents, see current work, open org view, and inspect an agent's run without losing the company context.
12. Use Tasks list/board, nesting, fields, filters, and a full Properties pane; retain reviewer/approver and relationship controls.
13. Open an automation's instructions, variables, triggers, delivery settings, and history.
14. Navigate the complete Phone hierarchy and reach an assistant's actual call/transfer controls without hunting through configuration.
15. Find company notes, private To-dos, Memories, and skills without conflating who can see or use them.
16. Show a disabled/unconfigured plugin, a failed load, an empty workspace, and a permission-limited scope as distinct states.
17. Reach every currently installed page/contribution through the preservation inventory. Tool-only plugins should remain discoverable without inventing nonexistent operator pages.
18. Verify narrow-screen navigation and pane transitions separately; mobile Email must not be sidelined by a stock issue-centric bottom bar.

## What remains source-only or unverified

- Mobile/compact viewport behavior was reviewed in code, not visually validated in this browser pass. `MobileBottomNav.tsx` still prioritizes Home, Issues, Create, Agents, and Inbox, omitting Email.
- Pop-out Clippy rendering was not exposed to the browser tool.
- Live Clippy streaming/tool/permission cards were not manufactured; sampled historical conversations did not show those cards.
- Populated To-do hover/promotion flows, queue item lifecycle, campaign lead detail, active-call transfer/transcript states, and empty-company record variants were not created just for the audit.
- Sends, calls, AI execution, approval decisions, uploads, deletion, lifecycle controls, installs, backup operations, and configuration saves remain untested by design.
- The previous inventory's Daily report loading state, blank Export/Roadmap observations, and disabled experimental workspaces remain limitations; no claim of successful rendering is made.
- GBP Reviews' current UI remains a location summary; a richer human review editor is a proposed extension, not an existing screen merely relocated.

## Source coverage added or revisited

Core UI: `Email.tsx`, `PortfolioEmail.tsx`, `HelpScoutEmailView.tsx`, `email/EmailPopoutDialog.tsx`, `DraftModelSelect.tsx`; Clippy drawer/page/conversation/composer/permission/tool cards; `CompanyRail.tsx`, `SidebarNavItem.tsx`, sidebar/account/breadcrumb/layout components and company route-memory helpers; `CommandPalette.tsx`, `StarterCatalogDialog.tsx`, `NewIssueDialog.tsx`; `IssuesList.tsx`, issue filters/columns, `IssueDetail.tsx`, `PropertiesPanel.tsx`, `Inbox.tsx`; `Routines.tsx`, `RoutineDetail.tsx`; Calendar pages/event dialogs/source legend; `OrgChart.tsx`, `AgentDetail.tsx`, `PortfolioAgents.tsx`, `OrgTreeNode.tsx`; `WorkQueues.tsx`, `Memories.tsx`, `Receipts.tsx`, `MobileBottomNav.tsx`.

Plugin UI: 3CX nested navigation and Recordings; Phone nested navigation, Campaigns/rollup, assistant Phone tab, call and warm-transfer forms; Notepad list/editor/conversion; To-do row behavior and promotion.

The complete preservation inventory still includes all 11 installed plugins: 3CX, Backups, Code Scanner, Email Tools, GBP Reviews, Help Scout, Notepad, Phone, Print Tools, Slack Tools, and To-dos. A redesigned navigation is not permission to remove any of them.

Application implementation and a third mockup have not begun in this pass. The interaction requirements above are the acceptance criteria for the next revision.
