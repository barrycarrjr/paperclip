# Team: putting the company's reporting lines back into the operational views

Written 2026-09-10, branch `team-operations-console`, on top of commit `9abb6c217`.

The console built on 2026-09-09 answers "what is everyone doing" but it answers it as a flat list
of agents. The operator's follow-up brief is about the half that was missing: **who works for whom**. A
company of thirty agents shown as thirty equal cards cannot be read, and worse, a flat list quietly
suggests that everybody reports to the CEO.

This file records what the app already stores, what it does not, and what is being built on top.

## What the app already knows, checked before writing any code

| The brief asks for | Where it really lives | Change needed |
|---|---|---|
| Manager / reports to | `agents.reportsTo`, returned on `GET /companies/:id/agents` | None |
| Role | `agents.role`, the enum in `packages/shared/src/constants.ts` (includes `ceo`, `cto`, `cmo`, `cfo`) | None |
| Title | `agents.title` | None |
| Status, current run, current task, last heartbeat, run start | Already assembled by `lib/team-current-work.ts` | None |
| Run history | `GET /companies/:id/heartbeat-runs`, already windowed by `since` | None |
| Adapter / provider | `agents.adapterType` | None |
| Why an agent stopped | `agent.lastError` / `lastRunStatus`, added on 2026-09-09 | None |
| Budget | `agent.budgetMonthlyCents` / `spentMonthlyCents`, and `pauseReason === "budget"` | None |
| The reporting tree | `svc.orgForCompany`, roots are the agents with no manager | None |

So the whole hierarchy is already in the browser: the Team page loads every agent, and every agent
carries its manager. **No schema change and no new endpoint.** That matches the brief's instruction
to prefer additive UI changes.

### What is genuinely not stored, and what is shown instead

- **Department.** There is no department field and none is being added. What the app can honestly
  work out from the reporting lines is which executive somebody sits under, so that is what is
  shown, and it is called that. A person directly under the CEO is their own branch.
- **Progress percentage.** Still absent, still not invented. Unchanged from 2026-09-09.
- **A history of who reported to whom.** Only the current line is stored, so the timeline groups by
  today's reporting lines and says so.
- **The board.** The human operator is not an agent and does not get a node. The CEO's card says
  its manager is the board in words, and the tree still starts at the CEO.

## The one new idea: `lib/team-hierarchy.ts`

Every new view reads the same function, so the card grid, the table, the timeline, the attention
list and the member's own page can never disagree about who reports to whom.

It turns the flat agent list into, for each member: their manager, their depth, their direct
reports, everybody beneath them, and which executive branch they sit in. Four things it is careful
about, each of which is a real case on the operator's own instance:

1. **The top is found, not assumed.** One agent with no manager is the top. Several, and the one
   whose role is `ceo` is the top; the rest are shown as outside the reporting line rather than
   being quietly adopted by the CEO.
2. **A manager who is missing or terminated** leaves that member as a root, not as a dangling
   reference to a name that is not on screen.
3. **A cycle in the reporting lines cannot hang the page.** Walking up stops when it sees an agent
   twice, exactly as the server's `getChainOfCommand` already does.
4. **Nobody is invented.** An agent whose branch cannot be worked out is put in a group that says
   so, not under the CEO.

## What is being built on top of it

- **Right Now** gains a grouped mode: executives as section headers carrying their own state plus a
  summary of their whole organization, with their people beneath them. The flat grid stays and is
  one click away; grouped is the default only when the company actually has a hierarchy.
- **Cards** gain a "Reports to" line, and a manager's card gains the summary of their organization.
- **The table** gains "Reports to" and "Branch" columns, both sortable.
- **A "reports under X" filter**, which narrows every view to one executive's whole organization.
- **Needs attention** becomes company-wide and grouped by branch, so a problem three levels down is
  visible from the top.
- **The timeline** indents by reporting line and can group by branch.
- **A member's own page** gains the drill-down: their manager, their direct reports with live
  state, the size of their organization and anything beneath them needing attention.
- **The org chart** keeps doing its job and is not replaced. The only change is that the CEO's tree
  is drawn first when a company has more than one root.

## Four things the live instance caught that tests had not

Checked in a browser against Company A (9 agents, a real CEO, six executives, one agent nobody has
placed) on 2026-09-10. Each of these was wrong on screen while every test was green, which is the
argument for doing this pass rather than trusting the suite.

1. **The CEO's own error was filed under "Not in the reporting line."** The top of the company has
   no branch, because every branch is beneath them, and the attention list was reading "no branch"
   as "not placed". An unwell CEO now heads the list under "Executive leadership".
2. **An agent with no manager was described as leading an organization.** The table's Branch column
   said "Sam (leads)" for an agent nobody has placed. Such a member is given a branch internally so
   the grouped view has somewhere to put them, which is not the same as leading anything; the table
   now says "Not in the line".
3. **A section with no leader printed its own title twice**, once as the small heading and once as
   the section heading.
4. **A company with no reporting lines at all was being offered reporting-line chrome**: a "no
   manager set" line on every card and a filter bar with one chip per agent. Neither says anything
   in a company where nobody has been given a manager, so both are hidden until at least one has.

## Not being changed, deliberately

Hiring, approvals, delegation, task ownership and the `agent` vocabulary in the API, routes, CLI
and adapters. The new controls call the existing mechanisms. This work is observation and
management, not a second governance path.
