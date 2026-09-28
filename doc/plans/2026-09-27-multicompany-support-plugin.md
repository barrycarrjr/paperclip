# Reusable company support and fix workflow

Date: 2026-09-27
Status: implementation underway
Scope: Paperclip, `paperclip-extensions`, and an existing support bridge

## Goal

Turn an existing support bridge into a reusable Paperclip support plugin. Customers, resellers, and staff can submit requests through a connected Slack workspace or help desk. Paperclip keeps the conversation and work in the reporting company's scope, helps answer or investigate it, and routes action to an authorized person, vendor, or agent. The plugin must handle computer, equipment, operations, and software requests without assuming every request is a coding task.

The existing bridge dashboard is part of the product scope. Its support and operator controls should move into a company-aware Paperclip UI. A connected Slack surface may offer the same actions when the operator has authority.

## Product boundary

| Owner | Responsibility |
| --- | --- |
| Paperclip core | Company access, agents, issues, runs, budgets, approvals, activity, and secrets. Add generic host capabilities when a plugin integration demonstrates a gap. |
| Support plugin | Intake routing, durable cases and messages, triage, drafts, decisions, source links, work coordination, dashboard, and metrics. Install once; configure and store data by company. |
| Source connectors | Provider-specific intake, thread retrieval, attachments, replies, and state checks. Slack and Help Scout are initial candidates; a legacy ticketing system is optional. |
| Paperclip agents | Classification, knowledge-backed answers, diagnosis, feature scoping, repair plans, coding, verification, and requester-safe drafts within granted permissions. |

A support case is a durable conversation record and may resolve without a Paperclip issue. Substantial local work can link to one issue and one accountable assignee. A defect in vendor software goes through that vendor's ordinary support channel, even if the Paperclip operator also manages the vendor. Local computer and equipment work remains with the reporting company.

## Findings from the existing bridge

- The bridge records conversations, messages, decisions, runs, tickets, replies, findings, and handoffs. Its triage paths include immediate escalation, information gathering, investigation, answer, acknowledgement, and human handoff.
- Its product routing contains fixed product names and a fallback product. Those values belong in company configuration and must not become plugin defaults.
- Slack has the fullest triage flow. Other help-desk sources use different classification and reply paths. The plugin needs one case and policy model with provider-specific adapters.
- The dashboard includes Overview, Work, Logs, Fleet, Health, Routines, and Config, plus an operator message entry point and approval controls. Each action needs a Paperclip route or plugin action before cutover.
- Paperclip's plugin SDK already provides company context, a plugin database namespace, jobs, scoped routes, pages, activity, issue actions, and secret references. Validate gaps through implementation rather than duplicating core services.

## Shared-source pilot pattern

The first rehearsal should use two companies sharing one Slack workspace. Existing support channels may contain mixed requests, so channel membership alone cannot identify the reporting company. Each workflow post needs a required Company answer. Configure one exact route per channel and company selection, reject ambiguous or missing answers, and verify the workflow change before enabling live intake. Keep workspace IDs, channel IDs, company names, workflow IDs, and personal links in private deployment configuration rather than this reusable plan.

The plugin foundation in `paperclip-extensions/plugins/customer-support` includes company-scoped cases and messages, retry-safe intake, exact route mapping, opt-in Slack workflow polling, bounded thread sync, attachment references, a Support page, case review, local issue creation, work start, and vendor escalation drafts. The poller baselines its first run, retries failed posts without advancing the cursor, and lets an operator request immediate thread sync. External vendor submission, automated triage, source replies, and full dashboard parity remain to be built.

Representative support threads show why full reply history matters. A form category may be wrong; a workstation problem can turn out to be hardware or access trouble. A short help request may be resolved entirely in replies. Equipment repairs may require a service visit and verified return to service. Shipping and production work may require order and shipment references. A shared software symptom can produce separate company cases linked to one reviewed cross-company incident. Treat form categories, reactions, and ownership clicks as hints until reviewed.

Some support threads contain credentials supplied for troubleshooting. Preserve original source access for authorized staff. Pass a credential needed for an approved action through a company-scoped Paperclip secret reference, and keep it out of issue summaries, logs, model prompts, and reusable knowledge. The current intake stores source text as received; controlled credential extraction and handoff remain a prerequisite for sensitive live intake.

## Connector contract

Each connector supplies a stable conversation key, new-message events or a poll cursor, ordered messages, attachment references, a source URL, and a fresh-state read before an outbound action. It declares supported operations such as public reply, private note, status change, and assignment. Inbound delivery, case updates, and outbound sends need separate idempotency keys. Provider-specific IDs and statuses remain adapter data rather than universal case state.

Each reporting company needs at least one working communication route. The support plugin includes a Slack poller; a separate communication plugin is optional for that path. External Slack, Help Scout, email, and other plugins may feed the normalized intake API under a company-authorized integration agent. An installed plugin alone is insufficient: require an exact company route, a tested delivery path, and a way to send or hand off replies. A source label in settings does not imply that its adapter has been implemented. Show setup health per company, including configured route, provider status, last successful intake, reply capability, and missing dependencies.

| Source | Planning status |
| --- | --- |
| Slack | Initial shared-workspace intake and reply-thread coordination. |
| Help Scout | Adapt the existing connector to the shared case flow. |
| Legacy ticketing | Optional connector for operators that use it. |
| Generic form or API | Future authenticated intake and callback path. |
| Other help desks | Add through the same connector contract based on operator demand. |

## Core contract

### Routing

1. Resolve every inbound event to exactly one `companyId` before any model run, case creation, or outbound action. Hold unresolved events with minimal metadata and no triage or reply.
2. Resolve company policy, service domain, work kind, and vendor destination from configuration. Never guess a vendor address or target from requester text.
3. A shared source may serve multiple companies, but exact route mapping and `allowedCompanies` checks must agree.
4. Customer identities are case participants, not Paperclip board or agent identities. Customer text cannot become a command or approval.

### Case and work records

The plugin owns namespaced support connections, routes, cases, messages, events, decisions, outbox records, and case-to-issue links. Store provider IDs and cursors, but keep company checks on every read and mutation. Large attachments use existing company-scoped storage. Define retention and deletion before historical import. Unique source keys and origin IDs prevent duplicate cases, messages, issues, and sends; recover partial failures by checking the existing record before retrying.

### Workflow

1. Ingest and deduplicate the source event, preserving the complete thread and attachment references.
2. Classify service domain and work kind with evidence, confidence, missing information, affected asset or order, and a requester-safe draft. Invalid output goes to review.
3. Gather facts or answer from approved knowledge. Use company and domain-specific tools for investigation.
4. Require evidence before creating a software bug; scope feature requests separately. Computer and equipment cases use their own work paths.
5. Link substantial local work to one accountable assignee. Draft vendor software reports for the configured external support channel and track its reference.
6. Review machine changes as governed actions. Recheck target, company, credentials, command or script hash, expected effects, and approval before execution. Record results and rollback notes.
7. Re-read the source before sending a requester update. Retire stale drafts and record actual sends separately from case resolution.
8. Handle new replies, re-triage, stop, resume, and handoff through versioned case transitions.

Start companies in `observe` mode. `draft` requires review for plans and replies. Configure later automation per company and action. Preserve Paperclip budget stops, activity logging, and atomic issue checkout.

### General support capability model

The plugin should accept any support domain, but it must represent the outcome honestly: answered, fixed and verified, awaiting requester, awaiting vendor, handed to a technician, or unresolved. A successful command is evidence of an attempted action, not proof that the original problem is gone.

- **Diagnose from complete context.** Combine source replies, attachments, asset history, recent changes, service status, and company-scoped knowledge. Ask for missing facts when multiple causes remain plausible. Record the evidence, competing explanations, confidence, and the next test; never turn a form category into a diagnosis by itself.
- **Use approved knowledge.** Retrieve company-specific runbooks, product documentation, past resolved cases, and vendor instructions with source references and freshness dates. Keep company boundaries in search indexes and derived summaries. An agent may suggest a new runbook after a verified fix, with review before reuse.
- **Find the correct target.** Maintain company-owned inventories of devices, printers, networks, applications, accounts, and relevant service owners. Bind a case to an exact asset and its authorized connection profile before probing or changing it. Discovery results require confirmation before an action targets a machine.
- **Make action providers extensible.** Expose a common contract for capability discovery, preflight, read diagnostics, propose change, execute, collect receipt, verify, and recover. Windows PowerShell/CMD is the first provider; SSH, device or printer management APIs, endpoint management, SaaS administration, and interactive technician handoff can follow. Each provider declares what it can actually verify and reverse.
- **Govern write actions.** A proposed action contains the exact target, reviewed script or API operation, expected effect, scope of access, risk, approval, preconditions, verification check, and rollback or recovery method. Resolve company-scoped secrets only at execution. Recheck approval, target, case version, secret ownership, and current device state immediately before execution. A retry after an unknown outcome must reconcile the device first rather than rerun a possibly completed change.
- **Verify the customer's outcome.** Collect before and after evidence, run a service-specific health check, sync the source thread, and request confirmation when the result cannot be observed remotely. Reopen or escalate if the symptom persists. Closure records the diagnostic finding, action, evidence, and requester-facing explanation.
- **Handle urgent and external work.** Triage security events, outages, and time-sensitive operational failures to an incident or human path. Respect vendor ownership and their normal support channels. Track acknowledgement, due time, handoff owner, vendor reference, and next update even when Paperclip cannot perform the fix.
- **Learn from outcomes.** Measure first response, time to verified resolution, reopen rate, incorrect diagnoses, failed actions, escalations, and connector lag by company. Replay representative cases in tests before changing prompts, runbooks, or action policies. Do not train shared knowledge on private case material without an explicit company decision.

The case page should present one coherent timeline: request, facts gathered, diagnosis, proposed action, approval, execution, verification, response, and handoff. Agents can specialize behind that case; the requester should have one clear support conversation and status.

### Concrete implementation backlog

The following items are additional code work, in build order. The first release target is one support case that diagnoses and fixes a known workstation problem through Paperclip, then records evidence that the symptom is gone. This target does not imply that every device or application is already supported.

| Order | Change to make | Main implementation areas | Acceptance check |
| --- | --- | --- | --- |
| 1 | Finish the secret-backed diagnostic path. Configure a test company and device, verify that the selected secret belongs to that company, and run the existing identity probe from the case page. | Plugin remote access resolver, API route, UI, and host secret handling. | A board user gets the remote identity and audit record; wrong-company secret, wrong target, and stale case review are rejected without exposing the password. |
| 2 | Add a durable `support_actions` record and case API for a proposed repair. Store action kind, exact target, reviewed script or structured operation, content hash, expected effect, preconditions, verification step, recovery notes, proposer, case version, and status. | Plugin migration, action service, manifest routes, and case page. | A proposed action can be reviewed without executing; changing its content or target invalidates approval. |
| 3 | Connect repair approval to Paperclip's governed approval flow. Separate approval from execution and require a fresh authorization check immediately before a write. | Plugin action service and, if the SDK lacks a needed approval operation, a narrow Paperclip host/SDK extension. | A pending or rejected action cannot run; an approved action runs only for its original company, case, target, and content hash. |
| 4 | Add a short-lived write executor using the existing Windows transport selector and Paperclip secret reference. Record a unique attempt before execution, capture bounded/redacted output, exit status, and a durable receipt. Reconcile unknown outcomes before retry. | Plugin remote executor, PowerShell bridge scripts, action state machine, and audit timeline. | One reviewed repair runs on a configured test workstation; duplicate requests do not run it twice, and a timeout is reported as unknown until checked. |
| 5 | Add before/after checks and explicit resolution states. A verification step tests the reported symptom; when remote verification is impossible, seek requester confirmation or technician review. | Action service, case state, UI, and source connector contract. | A command exit code alone cannot mark the case fixed; a failed check keeps the case open and shows the next owner. |
| 6 | Add an agent-facing case tool set: read company-scoped case context, retrieve approved knowledge, request diagnostics, propose an action, and draft a reply or handoff. The agent cannot approve its own write. | Plugin manifest tool registrations, worker handlers, company authorization, knowledge index, and agent instructions. | A representative case produces an evidence-backed diagnosis and a reviewable action or a clear request for missing facts. Cross-company retrieval fails. |
| 7 | Complete source and vendor loops. Implement replies and status sync for the initial source, a Help Scout connector, and reviewed vendor submission with acknowledgement/reference tracking. Keep optional ticketing systems behind the connector contract. | Source adapters, outbox/idempotency records, jobs, settings, and case UI. | A case can receive follow-up messages, send an approved answer, and track a vendor response without duplicate sends. |
| 8 | Expand IT coverage by adding an asset catalog and more action providers for printers, network devices, endpoint management, SSH, and SaaS administration as needed. Each provider supplies its own preflight, execution, and verification contract. | Plugin inventory, provider interface, settings, and provider-specific modules. | An unsupported asset is routed to a technician or vendor; a supported asset uses an exact company/target binding and records verification. |
| 9 | Add evaluation and operations views for missed messages, incorrect diagnoses, failed actions, reopened cases, source lag, and time to verified resolution. | Case event model, dashboard, metrics, and replay fixtures. | Representative answer, repair, escalation, ambiguous-company, and failure cases pass before automation expands. |

Current implementation covers case intake/review, a partial Slack poller, draft escalation, local issue creation, operator-run remote scripts, and a board-triggered read-only identity API. The action record, agent repair proposal tool, board approval gate, one-attempt Windows execution, verification script, interruption state, and a basic per-company communication setup notice are now implemented in the plugin and pass offline tests. The host and SDK now support company-owned secret resolution. A live installed-plugin identity test succeeded using a company-owned Paperclip secret and a DNS-domain access group. Live repair execution and symptom verification remain untested; the local approval gate is not yet integrated with Paperclip's central Approvals queue. Automated diagnosis, source replies, vendor sends, other providers, provider health checks, and evaluation work remain. Credentials in imported source text also need restricted handling before live intake of sensitive threads; preserve authorized source access while keeping those credentials out of prompts, logs, and derived work.

### Dashboard parity

| Surface | Paperclip destination |
| --- | --- |
| Overview | Company counts and portfolio summary linked to underlying cases. |
| Work | Case queue and detail, thread, triage plan, approvals, findings, linked issues and runs, stop, retry, and handoff. |
| Logs | Case event timeline and linked run logs. |
| Fleet | Agents, connector workers, source health, and available host diagnostics. |
| Health | Connection tests, model and agent availability, failed jobs, and source lag. |
| Routines | Intake polling, reconciliation, schedule, last run, and errors. |
| Config | Routes, secret references, target access profiles, policy, and retention. |
| Operator message entry | Internal case or agent conversation with company and source context. |

Each control needs an authorized actor, API/action, loading and error behavior, retry rule, and parity test.

## Build sequence

### 0. Freeze the behavior contract

- Inventory bridge features, dashboard controls, and source differences using private source access.
- Choose two companies and their source routes for a rehearsal; keep deployment names and IDs outside reusable source and plans.
- Validate connector events, company authorization, approvals, attachments, and portfolio UI contracts.
- Set retention, requester wording, approval defaults, and a migration window.

Exit: a reviewed routing diagram, state machine, dashboard parity matrix, and two-company scenario.

### 1. Case foundation

- Build company-scoped case and event storage, intake APIs, page, sidebar, and case timeline.
- Feed it from a connector or signed bridge event in observe mode, with idempotency and lag visibility.
- Link current decisions and tickets where needed without duplicate work or outbound sends.

Exit: two companies' cases remain separate and duplicate deliveries create one case.

### 2. Complete support-to-fix path

- Sync replies and attachment references, classify work, and invoke an appropriate support agent or human owner.
- Handle credentials supplied in source threads through restricted access and a controlled secret handoff.
- Submit reviewed vendor reports through configured external channels, track references, and prepare approved requester updates.
- Build a connection suite for Windows PowerShell/CMD, then add other remote providers through a common target/action contract. Read-only diagnosis is the first check; reviewed configuration, repair, and creation commands are required for the finished product.
- Configure Windows credentials by company and target group with a username and Paperclip password secret reference. Resolve only for the authorized action and pass the password to a short-lived process through standard input. Never place it in a command line, case, activity entry, or plugin source.
- Require exact target and command review, a governed approval for writes, pre-execution rechecks, script hash, idempotency, result audit, and visible recovery when the outcome is unknown.
- Add asset lookup and an action-provider contract so a repair can select a verified target, collect before and after evidence, and report whether the customer's symptom was resolved.
- Add company-scoped knowledge retrieval with cited answers and a reviewed path from verified cases to reusable runbooks.
- Implement source recheck, human takeover, stop/retry, and failure handling in UI and Slack.

Exit: software escalation and local computer or equipment work complete through their distinct paths, with source resolution recorded.

### 3. Additional help desks

- Connect Help Scout through its existing account model and watcher.
- Add legacy ticketing only when an operator requires it, preserving source-specific replies and state.
- Prioritize other providers by actual demand.

Exit: connected sources pass the same core case scenarios and their provider-specific reply tests.

### 4. Dashboard completion and cutover

- Complete the dashboard parity matrix, portfolio summary, settings, and role-filtered views.
- Shadow each source while the existing bridge remains authoritative, then switch one route at a time.
- Reconcile open decisions, approvals, and runs before switching; retain rollback and audit paths.

Exit: multiple companies can operate support in Paperclip without double sends, dropped cases, misrouted work, or lost controls.

## Remote connection evidence and remaining gates

A Windows workstation on a routed network was reachable through DNS, ICMP, SMB, WMI/DCOM, and RDP. WinRM HTTP was intermittent and authenticated attempts timed out; WinRM HTTPS was unavailable in that test. A credential-prompted WMI/DCOM and SMB probe launched a read-only identity command under an authorized domain account, retrieved the result, and cleaned its staging files. A later read-only PowerShell script also succeeded after an explicit process-only execution-policy option; persistent machine policy was not changed. The operator-run connection selector tries WinRM HTTPS, WMI/DCOM plus SMB, then WinRM HTTP. These results validate a manual transport path, not unattended action execution or access to every device.

The plugin now has company remote access groups scoped to an exact target, DNS domain, or office IP range, containing only Paperclip secret references. A board-initiated identity diagnostic passes the resolved password through standard input. The host's secret-reference extraction was extended to nested settings arrays and resolution can require that a secret belong to the case company. The case action proposal, local board approval, one-attempt executor, result receipt, and unknown-outcome state are implemented and tested offline. The installed-plugin identity path passed a live configured test. Live repair execution, central Approvals queue integration, and an asset inventory remain before routine use. Do not pass requester text directly to a shell.

## Verification gates

- State-machine tests for duplicate and out-of-order events, concurrent reviews, stale drafts, restart recovery, and partial send or issue failures.
- Two-company authorization tests for shared sources, routes, secrets, agent tools, case APIs, dashboard queries, and portfolio summaries.
- Connector contract tests with fake provider responses, including unsafe customer instructions.
- Offline rehearsal from software report through vendor response and source reply, plus answer-only, feature, computer repair, and equipment paths.
- Remote-action tests for wrong company or target, wrong identity, secret rotation, approval changes, write retry after unknown outcome, and audit redaction.
- Diagnosis evaluations for incomplete, misleading, and multi-message reports; evidence and knowledge citation checks; action receipt and symptom-verification scenarios; and escalation when no provider can safely complete the work.
- Dashboard parity tests and live shadow comparison before a route switches.
- Targeted checks first; full repository typecheck, tests, and build before a PR-ready handoff.

## Open decisions

1. Which source routes and vendor support channels should each deployment configure?
2. Are the shared-source workflows updated to include a required Company answer?
3. Which actions may run automatically per company after an initial observe period?
4. Which Paperclip board users may approve replies and machine changes, and how are external identities bound to them?
5. What retention and redaction rules apply to source threads, credentials, attachments, and diagnostic output?
6. Which devices and transports belong to each company, and which repair operations may agents run after approval?

## References

- Paperclip: `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`, `packages/plugins/sdk/README.md`.
- Reusable plugin sources: `../paperclip-extensions/plugins/customer-support/`, `../paperclip-extensions/plugins/help-scout/`, `../paperclip-extensions/plugins/slack-tools/`.
