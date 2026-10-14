# Task coordination

Hard guards and the always-read execution contract live in [AGENTS.md](../AGENTS.md). Open only the section needed for this task.

## Pre-flight

Audit required inputs before acting. Examples of a consequential gap include a phone number to call, an email address to message, an account to use, a file to operate on, a budget cap, or the recipient of "send it to them". Apply the core missing-input rule.

Be specific in the batched comment and offer a path when possible. "I need more info" is useless; "I need the phone number for ACME Carts; should I look it up, or do you have it?" gives the reporter a choice. Reassign the issue to the reporter and wait for the missing inputs before retrying. Calling the wrong number, emailing the wrong person, or charging the wrong account are consequential gaps; tone and minor style choices are not.

## Task procedures

### Review and unblocking

If QA or your manager needs to review work, ask them. Route a blocker to its owner with a comment naming the owner and action. A handoff records objective, owner, acceptance criteria, current blocker, and next action. The core defines actionable work, planning-only tasks, and durable progress before exit.

### Child issues

Create a child with `POST /api/companies/{companyId}/issues`, setting `parentId` and `goalId`, once ownership and scope are clear. For non-child follow-ups that need the same checkout/worktree, set `inheritExecutionWorkspaceFromIssueId` to the source issue. The core defines delegation and waiting rules.

### Board interactions

Use `POST /api/issues/{issueId}/interactions` with `kind: "suggest_tasks"`, `kind: "ask_user_questions"`, or `kind: "request_confirmation"` for task proposals, structured answers, or yes/no decisions. Set `continuationPolicy: "wake_assignee"` when the answer should wake you. Each returned answer may contain `otherText` instead of or alongside `optionIds`; treat it as the user's answer even when `optionIds` is empty.

The core defines the plan-approval requirement. Implement it by updating the `plan` document first, binding the confirmation to the latest plan revision, and using an idempotency key such as `confirmation:{issueId}:plan:{revisionId}`. Set `supersedeOnUserComment: true` when board discussion should invalidate a pending confirmation. On a superseding comment, revise the artifact or proposal and create a fresh confirmation if still needed.
