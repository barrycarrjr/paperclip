# HEARTBEAT.md -- CEO Heartbeat Checklist

Read only the sections needed for this wake. AGENTS.md is the always-read core; this file supplies task procedures, not an every-wake reading requirement.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Local Planning Check (when the task needs a plan)

1. Read the relevant summary of today's plan from `$AGENT_HOME/memory/YYYY-MM-DD.md` under "## Today's Plan". Follow `references/memory.md` before deeper recall.
2. Review each planned item: what's completed, what's blocked, and what up next.
3. For any blockers, resolve them yourself or escalate to the board.
4. If you're ahead, start on the next highest priority.
5. Record progress updates in the daily notes.

## 3. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:

- Review the approval and its linked issues.
- Close resolved issues or comment on what remains open.

## 4. Get Assignments

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,in_review,blocked`
- Prioritize: `in_progress` first, then `in_review` when you were woken by a comment on it, then `todo`. Skip `blocked` unless you can unblock it.
- If there is already an active run on an `in_progress` task, just move on to the next thing.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.

## 5. Checkout and Work

Use `POST /api/issues/{id}/checkout` when the core checkout rule calls for a claim. The core defines ownership, conflicts, and exit requirements.

Status quick guide:

- `todo`: ready to execute, but not yet checked out.
- `in_progress`: actively owned work. Agents should reach this by checkout, not by manually flipping status.
- `in_review`: waiting on review or approval, usually after handing work back to a board user or reviewer.
- `blocked`: cannot move until something specific changes. Say what is blocked and use `blockedByIssueIds` if another issue is the blocker.
- `done`: finished.
- `cancelled`: intentionally dropped.

## 6. Delegation

Routing and hiring are defined in `references/leadership.md`; child-issue fields and board interactions in `references/coordination.md#task-procedures`. Open only the relevant subsection.

### Portfolio directives

Some tasks arrive as **portfolio directives**, one high-level intent the board issued from HQ and fanned out to every company's CEO. You'll recognize it: the issue is tagged `originKind: "portfolio_directive"`, the body says so, and it carries a Directive ID. Treat it as real work to drive, not something to merely acknowledge:

1. Decide how the intent applies to *this* company specifically.
2. Break it into concrete subtasks for the agents who own those areas. If the owner is unclear, use the discovery procedure in `references/capabilities.md` before assigning the child issue.
3. Apply that reference's missing-capability procedure on the directive issue; its approval surfaces in the board's Portfolio Approvals at HQ.
4. Keep the directive issue as the umbrella: comment progress on it, and only move it to `done` when this company's part is genuinely handled.

## 7. Fact Extraction (when new durable facts need storing)

1. Check for new conversations since last extraction.
2. Extract durable facts to the relevant entity in `$AGENT_HOME/life/` (PARA).
3. Update `$AGENT_HOME/memory/YYYY-MM-DD.md` with timeline entries.
4. Update access metadata (timestamp, access_count) for any referenced facts.

## 8. Exit

Apply the core exit requirements. If no assignments and no valid mention-handoff remain, exit cleanly.

## Comment format

Comment in concise markdown: status line, bullets, and links. The core defines assignment scope, CEO responsibilities, budget, and cross-team cancellation rules.
