<!-- GENERATED FILE — DO NOT EDIT. Run pnpm generate:capability-inventory. -->

# Capability Capability Contract

This generated contract is a self-contained derivative of the Paperclip skill, its bundled references, the Paperclip Evals corpus, and the legacy MCP tool surface. It does not import or contact the Paperclip control plane.

The skill/reference inventory and eval cases are the only normative behavior sources. Paperclip does not use the legacy MCP calls as a production capability surface; all MCP names below are traceability aliases folded into normative skill or eval rows. Their disposition, grants, assertions, and evidence contract are inherited from the target row rather than classified independently.

## Baseline Counts

- Skill/reference headings: 130
- Eval cases: 106 across 16 groups
- Total normative rows: 236
- Legacy MCP aliases folded into normative rows: 45

| Eval group | Cases |
| --- | ---: |
| hb | 5 |
| co | 6 |
| st | 8 |
| cm | 6 |
| se | 4 |
| su | 4 |
| bl | 5 |
| dp | 3 |
| ix | 9 |
| ap | 6 |
| ar | 4 |
| er | 9 |
| rf | 22 |
| mh | 4 |
| rs | 3 |
| wk | 8 |

## Regeneration

- `pnpm --dir packages/paperclip-runner generate:capability-inventory` imports the canonical baselines and rewrites every generated file.
- `pnpm --dir packages/paperclip-runner check:capability-inventory` validates counts, uniqueness, normative dispositions, one-to-one MCP folds, required fields, and generated-file drift without requiring the external eval repository.

## Skill / Reference Rows

| Capability | Primary disposition | Source anchor |
| --- | --- | --- |
| skill:skills/paperclip/SKILL.md:paperclip-skill:12 | optional_agent_tool | skills/paperclip/SKILL.md:12 |
| skill:skills/paperclip/SKILL.md:authentication:16 | control_plane_owned | skills/paperclip/SKILL.md:16 |
| skill:skills/paperclip/SKILL.md:the-heartbeat-procedure:26 | optional_agent_tool | skills/paperclip/SKILL.md:26 |
| skill:skills/paperclip/SKILL.md:status-quick-guide:134 | control_plane_owned | skills/paperclip/SKILL.md:134 |
| skill:skills/paperclip/SKILL.md:issue-dependencies-blockers:146 | control_plane_owned | skills/paperclip/SKILL.md:146 |
| skill:skills/paperclip/SKILL.md:requesting-board-approval:171 | optional_agent_tool | skills/paperclip/SKILL.md:171 |
| skill:skills/paperclip/SKILL.md:niche-workflow-pointers:192 | optional_agent_tool | skills/paperclip/SKILL.md:192 |
| skill:skills/paperclip/SKILL.md:company-skills-workflow:204 | optional_agent_tool | skills/paperclip/SKILL.md:204 |
| skill:skills/paperclip/SKILL.md:routines:215 | optional_agent_tool | skills/paperclip/SKILL.md:215 |
| skill:skills/paperclip/SKILL.md:issue-workspace-runtime-controls:226 | optional_agent_tool | skills/paperclip/SKILL.md:226 |
| skill:skills/paperclip/SKILL.md:critical-rules:233 | optional_agent_tool | skills/paperclip/SKILL.md:233 |
| skill:skills/paperclip/SKILL.md:comment-style-required:252 | always_agent_tool | skills/paperclip/SKILL.md:252 |
| skill:skills/paperclip/SKILL.md:update:284 | optional_agent_tool | skills/paperclip/SKILL.md:284 |
| skill:skills/paperclip/SKILL.md:planning-required-when-planning-requested:294 | optional_agent_tool | skills/paperclip/SKILL.md:294 |
| skill:skills/paperclip/SKILL.md:key-endpoints-hot-routes:323 | optional_agent_tool | skills/paperclip/SKILL.md:323 |
| skill:skills/paperclip/SKILL.md:searching-issues:351 | optional_agent_tool | skills/paperclip/SKILL.md:351 |
| skill:skills/paperclip/SKILL.md:full-reference:361 | optional_agent_tool | skills/paperclip/SKILL.md:361 |
| skill:skills/paperclip/references/artifacts.md:generated-artifacts-and-work-products:1 | always_agent_tool | skills/paperclip/references/artifacts.md:1 |
| skill:skills/paperclip/references/artifacts.md:workspace-only-file-references:15 | optional_agent_tool | skills/paperclip/references/artifacts.md:15 |
| skill:skills/paperclip/references/cases.md:cases:1 | optional_agent_tool | skills/paperclip/references/cases.md:1 |
| skill:skills/paperclip/references/cases.md:core-model:12 | optional_agent_tool | skills/paperclip/references/cases.md:12 |
| skill:skills/paperclip/references/cases.md:upsert-semantics:29 | optional_agent_tool | skills/paperclip/references/cases.md:29 |
| skill:skills/paperclip/references/cases.md:read-and-search:67 | optional_agent_tool | skills/paperclip/references/cases.md:67 |
| skill:skills/paperclip/references/cases.md:documents:90 | always_agent_tool | skills/paperclip/references/cases.md:90 |
| skill:skills/paperclip/references/cases.md:fields:118 | optional_agent_tool | skills/paperclip/references/cases.md:118 |
| skill:skills/paperclip/references/cases.md:issue-links:151 | optional_agent_tool | skills/paperclip/references/cases.md:151 |
| skill:skills/paperclip/references/cases.md:child-cases:176 | optional_agent_tool | skills/paperclip/references/cases.md:176 |
| skill:skills/paperclip/references/cases.md:attachments:195 | optional_agent_tool | skills/paperclip/references/cases.md:195 |
| skill:skills/paperclip/references/cases.md:lifecycle:208 | optional_agent_tool | skills/paperclip/references/cases.md:208 |
| skill:skills/paperclip/references/cases.md:worked-blog-post-example:222 | optional_agent_tool | skills/paperclip/references/cases.md:222 |
| skill:skills/paperclip/references/company-skills.md:company-skills-workflow:1 | optional_agent_tool | skills/paperclip/references/company-skills.md:1 |
| skill:skills/paperclip/references/company-skills.md:what-exists:5 | optional_agent_tool | skills/paperclip/references/company-skills.md:5 |
| skill:skills/paperclip/references/company-skills.md:permission-model:17 | optional_agent_tool | skills/paperclip/references/company-skills.md:17 |
| skill:skills/paperclip/references/company-skills.md:core-endpoints:24 | optional_agent_tool | skills/paperclip/references/company-skills.md:24 |
| skill:skills/paperclip/references/company-skills.md:install-a-skill-into-the-company:36 | optional_agent_tool | skills/paperclip/references/company-skills.md:36 |
| skill:skills/paperclip/references/company-skills.md:source-types-in-order-of-preference:40 | optional_agent_tool | skills/paperclip/references/company-skills.md:40 |
| skill:skills/paperclip/references/company-skills.md:example-skills-sh-import-preferred:51 | optional_agent_tool | skills/paperclip/references/company-skills.md:51 |
| skill:skills/paperclip/references/company-skills.md:example-github-import:73 | optional_agent_tool | skills/paperclip/references/company-skills.md:73 |
| skill:skills/paperclip/references/company-skills.md:inspect-what-was-installed:92 | optional_agent_tool | skills/paperclip/references/company-skills.md:92 |
| skill:skills/paperclip/references/company-skills.md:assign-skills-to-an-existing-agent:109 | optional_agent_tool | skills/paperclip/references/company-skills.md:109 |
| skill:skills/paperclip/references/company-skills.md:include-skills-during-hire-or-create:137 | optional_agent_tool | skills/paperclip/references/company-skills.md:137 |
| skill:skills/paperclip/references/company-skills.md:notes:177 | optional_agent_tool | skills/paperclip/references/company-skills.md:177 |
| skill:skills/paperclip/references/issue-workspaces.md:issue-workspace-runtime-controls:1 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:1 |
| skill:skills/paperclip/references/issue-workspaces.md:discover-the-workspace:5 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:5 |
| skill:skills/paperclip/references/issue-workspaces.md:control-services:23 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:23 |
| skill:skills/paperclip/references/issue-workspaces.md:start-all-configured-services-waits-for-configured-readiness-checks:28 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:28 |
| skill:skills/paperclip/references/issue-workspaces.md:restart-all-configured-services:36 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:36 |
| skill:skills/paperclip/references/issue-workspaces.md:stop-all-running-services:44 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:44 |
| skill:skills/paperclip/references/issue-workspaces.md:read-the-url:63 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:63 |
| skill:skills/paperclip/references/issue-workspaces.md:mcp-tools:72 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:72 |
| skill:skills/paperclip/references/routines.md:paperclip-routines:1 | optional_agent_tool | skills/paperclip/references/routines.md:1 |
| skill:skills/paperclip/references/routines.md:lifecycle:15 | optional_agent_tool | skills/paperclip/references/routines.md:15 |
| skill:skills/paperclip/references/routines.md:creating-a-routine:26 | optional_agent_tool | skills/paperclip/references/routines.md:26 |
| skill:skills/paperclip/references/routines.md:concurrency-policies:59 | optional_agent_tool | skills/paperclip/references/routines.md:59 |
| skill:skills/paperclip/references/routines.md:catch-up-policies:71 | optional_agent_tool | skills/paperclip/references/routines.md:71 |
| skill:skills/paperclip/references/routines.md:adding-triggers:82 | optional_agent_tool | skills/paperclip/references/routines.md:82 |
| skill:skills/paperclip/references/routines.md:schedule-cron:92 | optional_agent_tool | skills/paperclip/references/routines.md:92 |
| skill:skills/paperclip/references/routines.md:webhook:106 | optional_agent_tool | skills/paperclip/references/routines.md:106 |
| skill:skills/paperclip/references/routines.md:api-manual-only:123 | optional_agent_tool | skills/paperclip/references/routines.md:123 |
| skill:skills/paperclip/references/routines.md:updating-and-deleting-triggers:135 | optional_agent_tool | skills/paperclip/references/routines.md:135 |
| skill:skills/paperclip/references/routines.md:manual-run:152 | optional_agent_tool | skills/paperclip/references/routines.md:152 |
| skill:skills/paperclip/references/routines.md:updating-a-routine:168 | optional_agent_tool | skills/paperclip/references/routines.md:168 |
| skill:skills/paperclip/references/routines.md:reading-routines-and-runs:179 | optional_agent_tool | skills/paperclip/references/routines.md:179 |
| skill:skills/paperclip/references/workflows.md:paperclip-workflow-playbooks:1 | optional_agent_tool | skills/paperclip/references/workflows.md:1 |
| skill:skills/paperclip/references/workflows.md:project-setup-ceo-manager:7 | optional_agent_tool | skills/paperclip/references/workflows.md:7 |
| skill:skills/paperclip/references/workflows.md:openclaw-invite-ceo:22 | optional_agent_tool | skills/paperclip/references/workflows.md:22 |
| skill:skills/paperclip/references/workflows.md:setting-agent-instructions-path:50 | optional_agent_tool | skills/paperclip/references/workflows.md:50 |
| skill:skills/paperclip/references/workflows.md:company-import-export:79 | optional_agent_tool | skills/paperclip/references/workflows.md:79 |
| skill:skills/paperclip/references/workflows.md:self-test-playbook-app-level:106 | optional_agent_tool | skills/paperclip/references/workflows.md:106 |
| skill:skills/paperclip/references/api-reference.md:paperclip-api-reference:1 | optional_agent_tool | skills/paperclip/references/api-reference.md:1 |
| skill:skills/paperclip/references/api-reference.md:response-schemas:7 | optional_agent_tool | skills/paperclip/references/api-reference.md:7 |
| skill:skills/paperclip/references/api-reference.md:agent-record-get-api-agents-me-or-get-api-agents-agentid:9 | optional_agent_tool | skills/paperclip/references/api-reference.md:9 |
| skill:skills/paperclip/references/api-reference.md:company-portability:47 | optional_agent_tool | skills/paperclip/references/api-reference.md:47 |
| skill:skills/paperclip/references/api-reference.md:issue-with-ancestors-get-api-issues-issueid:113 | optional_agent_tool | skills/paperclip/references/api-reference.md:113 |
| skill:skills/paperclip/references/api-reference.md:execution-policy-fields-on-an-issue:199 | optional_agent_tool | skills/paperclip/references/api-reference.md:199 |
| skill:skills/paperclip/references/api-reference.md:worked-example-ic-heartbeat:253 | optional_agent_tool | skills/paperclip/references/api-reference.md:253 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:258 | control_plane_owned | skills/paperclip/references/api-reference.md:258 |
| skill:skills/paperclip/references/api-reference.md:2-check-inbox-prefer-inbox-lite-for-compact-assignment-list:262 | control_plane_owned | skills/paperclip/references/api-reference.md:262 |
| skill:skills/paperclip/references/api-reference.md:fallback-when-you-need-full-issue-objects:268 | optional_agent_tool | skills/paperclip/references/api-reference.md:268 |
| skill:skills/paperclip/references/api-reference.md:get-api-companies-company-1-issues-assigneeagentid-agent-42-status-todo-inprogress-inreview-blocked:269 | control_plane_owned | skills/paperclip/references/api-reference.md:269 |
| skill:skills/paperclip/references/api-reference.md:3-already-have-issue-101-inprogress-highest-priority-continue-it:271 | optional_agent_tool | skills/paperclip/references/api-reference.md:271 |
| skill:skills/paperclip/references/api-reference.md:4-do-the-actual-work-write-code-run-tests:278 | optional_agent_tool | skills/paperclip/references/api-reference.md:278 |
| skill:skills/paperclip/references/api-reference.md:5-work-is-done-update-status-and-comment-in-one-call:280 | always_agent_tool | skills/paperclip/references/api-reference.md:280 |
| skill:skills/paperclip/references/api-reference.md:6-still-have-time-checkout-the-next-task:284 | control_plane_owned | skills/paperclip/references/api-reference.md:284 |
| skill:skills/paperclip/references/api-reference.md:7-made-partial-progress-not-done-yet-comment-and-exit:291 | always_agent_tool | skills/paperclip/references/api-reference.md:291 |
| skill:skills/paperclip/references/api-reference.md:worked-example-report-a-board-user-s-mine-inbox:296 | control_plane_owned | skills/paperclip/references/api-reference.md:296 |
| skill:skills/paperclip/references/api-reference.md:board-user-created-the-requesting-issue:301 | optional_agent_tool | skills/paperclip/references/api-reference.md:301 |
| skill:skills/paperclip/references/api-reference.md:fetch-the-board-user-s-mine-inbox-issues:305 | control_plane_owned | skills/paperclip/references/api-reference.md:305 |
| skill:skills/paperclip/references/api-reference.md:summarize-it-back-to-the-board-in-a-comment-or-document:319 | always_agent_tool | skills/paperclip/references/api-reference.md:319 |
| skill:skills/paperclip/references/api-reference.md:worked-example-reviewer-approver-heartbeat:324 | always_agent_tool | skills/paperclip/references/api-reference.md:324 |
| skill:skills/paperclip/references/api-reference.md:worked-example-manager-heartbeat:363 | optional_agent_tool | skills/paperclip/references/api-reference.md:363 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:366 | control_plane_owned | skills/paperclip/references/api-reference.md:366 |
| skill:skills/paperclip/references/api-reference.md:2-check-team-status:370 | optional_agent_tool | skills/paperclip/references/api-reference.md:370 |
| skill:skills/paperclip/references/api-reference.md:3-agent-42-is-blocked-read-comments:377 | control_plane_owned | skills/paperclip/references/api-reference.md:377 |
| skill:skills/paperclip/references/api-reference.md:4-unblock-reassign-and-comment:381 | control_plane_owned | skills/paperclip/references/api-reference.md:381 |
| skill:skills/paperclip/references/api-reference.md:5-check-own-assignments:385 | optional_agent_tool | skills/paperclip/references/api-reference.md:385 |
| skill:skills/paperclip/references/api-reference.md:6-create-subtasks-and-delegate:392 | optional_agent_tool | skills/paperclip/references/api-reference.md:392 |
| skill:skills/paperclip/references/api-reference.md:load-tests-depend-on-caching-layer-being-done-first-paperclip-will-auto-wake-agent-55-when-the-blocker-resolves:398 | control_plane_owned | skills/paperclip/references/api-reference.md:398 |
| skill:skills/paperclip/references/api-reference.md:7-dashboard-for-health-check:403 | optional_agent_tool | skills/paperclip/references/api-reference.md:403 |
| skill:skills/paperclip/references/api-reference.md:comments-and-mentions:409 | always_agent_tool | skills/paperclip/references/api-reference.md:409 |
| skill:skills/paperclip/references/api-reference.md:update:416 | optional_agent_tool | skills/paperclip/references/api-reference.md:416 |
| skill:skills/paperclip/references/api-reference.md:cross-team-work-and-delegation:454 | optional_agent_tool | skills/paperclip/references/api-reference.md:454 |
| skill:skills/paperclip/references/api-reference.md:receiving-cross-team-work:458 | optional_agent_tool | skills/paperclip/references/api-reference.md:458 |
| skill:skills/paperclip/references/api-reference.md:escalation:468 | optional_agent_tool | skills/paperclip/references/api-reference.md:468 |
| skill:skills/paperclip/references/api-reference.md:company-context:478 | optional_agent_tool | skills/paperclip/references/api-reference.md:478 |
| skill:skills/paperclip/references/api-reference.md:company-branding-ceo-board:490 | optional_agent_tool | skills/paperclip/references/api-reference.md:490 |
| skill:skills/paperclip/references/api-reference.md:openclaw-invite-prompt-ceo:510 | optional_agent_tool | skills/paperclip/references/api-reference.md:510 |
| skill:skills/paperclip/references/api-reference.md:setting-agent-instructions-path:529 | optional_agent_tool | skills/paperclip/references/api-reference.md:529 |
| skill:skills/paperclip/references/api-reference.md:project-setup-create-workspace:562 | optional_agent_tool | skills/paperclip/references/api-reference.md:562 |
| skill:skills/paperclip/references/api-reference.md:option-a-one-call-create-with-workspace:566 | optional_agent_tool | skills/paperclip/references/api-reference.md:566 |
| skill:skills/paperclip/references/api-reference.md:option-b-two-calls-project-first-then-workspace:585 | optional_agent_tool | skills/paperclip/references/api-reference.md:585 |
| skill:skills/paperclip/references/api-reference.md:governance-and-approvals:614 | optional_agent_tool | skills/paperclip/references/api-reference.md:614 |
| skill:skills/paperclip/references/api-reference.md:requesting-a-hire-management-only:618 | optional_agent_tool | skills/paperclip/references/api-reference.md:618 |
| skill:skills/paperclip/references/api-reference.md:ceo-strategy-approval:638 | optional_agent_tool | skills/paperclip/references/api-reference.md:638 |
| skill:skills/paperclip/references/api-reference.md:issue-thread-confirmations:647 | always_agent_tool | skills/paperclip/references/api-reference.md:647 |
| skill:skills/paperclip/references/api-reference.md:checking-approval-status:695 | optional_agent_tool | skills/paperclip/references/api-reference.md:695 |
| skill:skills/paperclip/references/api-reference.md:approval-follow-up-requesting-agent:701 | always_agent_tool | skills/paperclip/references/api-reference.md:701 |
| skill:skills/paperclip/references/api-reference.md:issue-lifecycle:719 | always_agent_tool | skills/paperclip/references/api-reference.md:719 |
| skill:skills/paperclip/references/api-reference.md:error-handling:746 | control_plane_owned | skills/paperclip/references/api-reference.md:746 |
| skill:skills/paperclip/references/api-reference.md:full-api-reference:760 | optional_agent_tool | skills/paperclip/references/api-reference.md:760 |
| skill:skills/paperclip/references/api-reference.md:agents:762 | optional_agent_tool | skills/paperclip/references/api-reference.md:762 |
| skill:skills/paperclip/references/api-reference.md:run-visibility-managers-board:784 | optional_agent_tool | skills/paperclip/references/api-reference.md:784 |
| skill:skills/paperclip/references/api-reference.md:issues-tasks:795 | optional_agent_tool | skills/paperclip/references/api-reference.md:795 |
| skill:skills/paperclip/references/api-reference.md:companies-projects-goals:831 | optional_agent_tool | skills/paperclip/references/api-reference.md:831 |
| skill:skills/paperclip/references/api-reference.md:routines:858 | optional_agent_tool | skills/paperclip/references/api-reference.md:858 |
| skill:skills/paperclip/references/api-reference.md:approvals-costs-activity-dashboard:875 | optional_agent_tool | skills/paperclip/references/api-reference.md:875 |
| skill:skills/paperclip/references/api-reference.md:secrets:897 | optional_agent_tool | skills/paperclip/references/api-reference.md:897 |
| skill:skills/paperclip/references/api-reference.md:binding-a-secret-to-an-agent-s-env-ceo-authorized-agent:907 | optional_agent_tool | skills/paperclip/references/api-reference.md:907 |
| skill:skills/paperclip/references/api-reference.md:common-mistakes:945 | optional_agent_tool | skills/paperclip/references/api-reference.md:945 |
| skill:skills/paperclip/references/email-handoffs.md:email-handoffs:1 | optional_agent_tool | skills/paperclip/references/email-handoffs.md:1 |

## Legacy MCP Alias Index

This is a compatibility/traceability index, not a tool catalog. “Inherited disposition” is shown only to make the normative target easy to audit.

| Legacy MCP name | Folded into normative row | Inherited disposition | Source anchor |
| --- | --- | --- | --- |
| paperclipMe | eval:hb-inbox-lite-01 | control_plane_owned | packages/mcp-server/src/tools.ts:226 |
| paperclipInboxLite | eval:hb-inbox-lite-01 | control_plane_owned | packages/mcp-server/src/tools.ts:232 |
| paperclipListAgents | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:238 |
| paperclipGetAgent | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:244 |
| paperclipFindAgentsByCapability | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:253 |
| paperclipListIssues | eval:se-q-filters-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:274 |
| paperclipGetIssue | eval:se-get-issue-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:289 |
| paperclipGetHeartbeatContext | eval:hb-context-01 | control_plane_owned | packages/mcp-server/src/tools.ts:295 |
| paperclipListComments | eval:se-get-issue-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:304 |
| paperclipGetComment | eval:hb-wake-comment-01 | control_plane_owned | packages/mcp-server/src/tools.ts:317 |
| paperclipListIssueApprovals | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:324 |
| paperclipListDocuments | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:330 |
| paperclipGetDocument | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:336 |
| paperclipListDocumentRevisions | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:343 |
| paperclipListProjects | eval:rf-wf-project-setup-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:353 |
| paperclipGetProject | eval:rf-wf-project-setup-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:359 |
| paperclipGetIssueWorkspaceRuntime | eval:rf-iws-start-url-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:368 |
| paperclipControlIssueWorkspaceServices | eval:rf-iws-start-url-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:374 |
| paperclipWaitForIssueWorkspaceService | eval:rf-iws-target-restart-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:391 |
| paperclipListGoals | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:417 |
| paperclipGetGoal | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:423 |
| paperclipListApprovals | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:429 |
| paperclipCreateApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:438 |
| paperclipGetApproval | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:447 |
| paperclipGetApprovalIssues | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:453 |
| paperclipListApprovalComments | eval:ap-approval-deny-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:459 |
| paperclipCreateIssue | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:465 |
| paperclipUpdateIssue | eval:st-done-comment-01 | always_agent_tool | packages/mcp-server/src/tools.ts:472 |
| paperclipCheckoutIssue | eval:co-body-contract-01 | control_plane_owned | packages/mcp-server/src/tools.ts:479 |
| paperclipReleaseIssue | eval:er-release-01 | control_plane_owned | packages/mcp-server/src/tools.ts:491 |
| paperclipListEmailHandoffs | skill:skills/paperclip/references/email-handoffs.md:email-handoffs:1 | optional_agent_tool | packages/mcp-server/src/tools.ts:497 |
| paperclipAcknowledgeEmailHandoff | skill:skills/paperclip/references/email-handoffs.md:email-handoffs:1 | optional_agent_tool | packages/mcp-server/src/tools.ts:507 |
| paperclipResolveEmailHandoff | skill:skills/paperclip/references/email-handoffs.md:email-handoffs:1 | optional_agent_tool | packages/mcp-server/src/tools.ts:523 |
| paperclipHandBackEmailHandoff | skill:skills/paperclip/references/email-handoffs.md:email-handoffs:1 | optional_agent_tool | packages/mcp-server/src/tools.ts:541 |
| paperclipAddComment | eval:cm-multiline-01 | always_agent_tool | packages/mcp-server/src/tools.ts:558 |
| paperclipSuggestTasks | eval:ix-suggest-tasks-01 | always_agent_tool | packages/mcp-server/src/tools.ts:565 |
| paperclipAskUserQuestions | eval:ix-questions-01 | always_agent_tool | packages/mcp-server/src/tools.ts:577 |
| paperclipRequestConfirmation | eval:ix-confirmation-plan-01 | always_agent_tool | packages/mcp-server/src/tools.ts:589 |
| paperclipUpsertIssueDocument | eval:dp-plan-doc-01 | always_agent_tool | packages/mcp-server/src/tools.ts:601 |
| paperclipRestoreIssueDocumentRevision | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:612 |
| paperclipLinkIssueApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:627 |
| paperclipUnlinkIssueApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:636 |
| paperclipApprovalDecision | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:646 |
| paperclipAddApprovalComment | eval:ap-approval-deny-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:668 |
| paperclipApiRequest | eval:rf-api-404-report-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:677 |
