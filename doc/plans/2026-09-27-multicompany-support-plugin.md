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

The plugin now has company remote access groups scoped to an exact target, DNS domain, or office IP range, containing only Paperclip secret references. A board-initiated identity diagnostic passes the resolved password through standard input. The host's secret-reference extraction was extended to nested settings arrays and resolution can require that a secret belong to the case company. The case action proposal, local board approval, one-attempt executor, result receipt, and unknown-outcome state are implemented and tested offline. The installed-plugin identity path passed a live configured test. Live repair execution and central Approvals queue integration remain before routine use; authenticated asset inventory was added in the dated milestone below. Do not pass requester text directly to a shell.

## Verification gates

### Interactive Clippy support (2026-09-29)

Live discovery correction: adapter sessions can defer MCP tool schemas, so installing a support tool alone does not ensure Clippy selects it. The host now supplies a compact directory of current plugin capabilities on every turn and directs Clippy to discover the matching plugin before shell fallbacks or credential requests. Support's entry-point description explicitly covers workstation investigations with saved company access and no pre-existing ticket. The directory comes from installed tools and contains no deployment credentials or company-specific targets.

A live read-only Clippy rehearsal now opened an internal case and completed connectivity, performance, storage and services checks through saved company access. This exposed and corrected case/action mutations sent through the host's read-only query API; tests now enforce the read/write contract. Diagnostic summaries must describe their limited snapshot rather than declare the entire computer healthy. No live repair was performed in this rehearsal.

### Expanded IT toolkit (2026-09-29)

Implemented: 16 bounded diagnostic checks covering inventory/capabilities, performance samples, storage/services, events, networking, printing, applied computer policy, domain/account metadata, applications, updates, tasks, certificates and shares. Diagnostic option values are encoded as data; secondary network probes must resolve inside the same company's access groups. Missing modules and partial results are explicit. Inventory stores a company snapshot without network-wide scanning.

Seven structured repair recipes prepare scripts for the existing inline/delegated execution path: start/restart service, restart spooler, flush DNS, refresh computer policy, restart/cancel an exact print job. They include verification, disruption and recovery notes; preparation cannot execute. Print jobs bind to observed submission times to reject recycled IDs. Broader custom PowerShell repairs retain the existing confirmation and durable attempt rules.

Live rehearsal exposed the default 30-second worker RPC limit on the repeated performance check. Tools now declare a validated bounded execution timeout, clamped by the host to five minutes and never controlled by tool parameters. The remote runner serializes tasks per computer with a 30-second queue-wait limit; timed-out waiters cannot execute later or allow another request to overtake the active task. A timeout still does not cancel an already-started remote action.

Verification: 42 plugin tests, plugin/SDK/server builds and server/plugin typechecks passed, together with targeted host timeout and permission tests. Live read-only rehearsals completed the additional Windows checks, article retrieval, device/knowledge lookup and repair preparation. The final repeated-performance/share request completed without worker errors or retries. The dashboard's data endpoint returned the current catalogs and inventory. Browser automation was unavailable, so visual layout was not checked. No live write repair was performed.

Reference discovery searches a curated directory of 20 official sources locally and retrieves current article excerpts with source URLs and timestamps. Reference downloads have host/redirect, timeout and size limits; text cannot grant execution authority. Company support knowledge publication requires inline confirmation. A verified fix must link to successful action verification in the person's own case; cross-company knowledge and inventory access is rejected. The dashboard displays the catalogs, snapshots, notes and recorded diagnostic findings.

Remaining connector-dependent expansion: Linux/SSH, cloud/email administration, vendor hardware/software APIs, interactive remote desktop, full domain replication analysis, domain-wide GPO administration with finer permission scope, long-running maintenance jobs and central Approvals integration. Knowledge entries are append-only initially; versioned editing/retirement and configurable retention remain future work. Recovery still requires actual prior-state capture or backups for changes that need it.

### Repair workflow reliability and symptom outcomes (2026-09-29)

Repair and verification now hold one target slot for their entire sequence, including outcome recording. Delegation and case review are rechecked after the wait. A unique database index also prevents two running actions on the same normalized hostname across worker restarts. Unknown outcomes block new cases on that hostname until an operator inspects and reviews the original case. DNS aliases and alternate IPs are not automatically identified as the same device. Existing overlapping running attempts must be reconciled before installing the new index.

Failed proposals release their pending case claim but retain the exact request fingerprint, so a lost response cannot silently replay a change. Clippy history returns repair/verification exit codes, script hashes and recovery notes. The new confirmed outcome tool records resolved, still present or needs-follow-up, with observed or requester-confirmed symptom evidence. It advances the case review and ends delegation; it cannot close/reopen a currently unknown or running attempt to bypass inspection. Board re-review clears stale symptom evidence.

Verification includes a Windows PowerShell rehearsal using an injected local executor and an isolated temporary file: write, separate verification, recovery/removal, and a lost response after a real write with replay prevention. This validates the action workflow without changing staff computers; it does not establish remote repair execution on production devices. Live Clippy rehearsal denied both repair and outcome confirmations and then confirmed no action started and the case remained open. Company permission, stale review, outcome evidence, cross-case sequence ordering, restart state and delegation revocation during a queue wait have offline coverage.

The approved human workflow keeps consent in the conversation. An authorized person can name a computer without an incoming ticket, see diagnostic results, review the proposed repair and confirm it with a button or a short reply. Emergency delegation is limited to one case, person, conversation and target for one hour. It does not grant extra permissions. Automatic intake continues through the reviewed case workflow; central Approvals queue integration remains future work.

Implemented in the current development changes: host-issued tool permission and inline-consent context for native and MCP Clippy, company `support:diagnose` and `support:repair` grants, fixed Windows diagnostics, conversation-owned internal cases, exact repair/verification scripts with recovery notes, delegation/revocation, and durable repair retry protection. External communication routes are optional for direct Clippy requests. Credentials and allowed device groups remain deployment settings. The plugin fails closed when the host cannot attest a person's grant or consent.

Offline tests cover company/person/conversation boundaries, permission changes while waiting, consent spoofing, delegation expiry, stale review versions, concurrent repairs and unknown outcomes. Live Clippy repair rehearsal remains required. Audit records describe changes; actual recovery needs captured state or backups where supported. Stopping a conversation does not guarantee cancellation of a command already running. Domain-admin scripts are not an operating-system sandbox, and a connection target alone cannot constrain every downstream effect.

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

## 2026-09-29: Reviewed outbound communication

Implemented saved Slack reply and vendor email drafts, person-confirmed delivery in Clippy or the case dashboard, the company permission `support:respond`, pinned source accounts, provider receipt tracking and metadata-only connector ledgers. The host plugin event API connects Support Desk to Slack Tools and Email Tools without sharing channel credentials. Exact channels/recipients are opt-in on the connector; each send rechecks company access. Approvals expire after ten minutes. A claimed ID never automatically replays; only a confirmed not-sent result can prepare a freshly approved retry. Slack SDK retries are disabled for this path. Pending/unknown states must never be described as sent. Provider acceptance does not establish recipient delivery/read status or case resolution.

Help Scout/source-email/WHMCS replies and automatic Jira form submission remain future adapters. Jira escalation uses the configured public form. This stage does not automatically mark the separate manual escalation record submitted. Tests use isolated databases and fake senders; no live message is sent as part of validation. Empty connector destination lists leave the new sending capability disabled.

Verification for this stage: Support Desk 56 tests, Email Tools 126 tests and Slack Tools 14 tests pass with type checks and builds. The host/UI permission and presentation tests pass (31 targeted tests); shared/SDK/server/UI checks and builds pass. All three updated local plugins report ready; the live case data includes outbound history and the tool registry includes all four communication tools. Destination opt-in lists remain empty. No external messages or office repair were sent/run. Browser visual validation and the full repository suite were not rerun for this stage.

Checkpoint policy: save each completed milestone in a separate commit after checking the pending content for credentials, company identifiers and private paths. Push reviewed checkpoints to the fork's main branch for host changes and the support feature branch for extension changes. Deployment settings, secret values and local agent configuration stay out of these commits.

Checkpoint verification: 69 targeted host/UI tests pass and the host pre-commit hook passes the full workspace type check. The IT toolkit snapshot passes 48 tests, type check and build independently of the communication milestone. The combined plugin checks above remain applicable; Email Tools' 126 tests pass after replacing a real mailbox fixture with generic examples. The pending source content and both SDK archives were scanned, and each staged milestone was checked again before committing.

## 2026-09-29: Setup checklist and connection evidence

The company Support page now separates Windows access, the signed-in person's diagnostic/repair/reply permissions and optional communication setup. Host-gated read-only permission probes confirm each grant without starting any command. Secret metadata checks establish company ownership of a reference without resolving its value; a reference alone is never described as a tested password. Routes/plugin availability remain distinct from verified intake or delivery, with links to the relevant settings.

Identity tests accept an unambiguous short computer name using the same company access rules as Clippy. Results have a plain-language summary and expandable technical details. Company-scoped state retains the latest target/time/transport/outcome and an access-settings fingerprint, without passwords, account values or raw output. Changed settings invalidate the match; password value rotation and later network changes still require a new test. Failed connection tests replace prior success; bookkeeping failures must not turn an observed successful connection into a failed authentication finding.

Verification: 60 plugin tests, plugin type check and build pass. An installed read-only test using saved company credentials succeeded over WMI/DCOM/SMB and its current-settings observation was returned by the setup data endpoint. All three host permission probes returned an authorized grant for the test operator. The pilot company currently has no incoming communication or vendor routes; setup reports those gaps while keeping direct computer support available. No repair or outbound message was run. Browser visual validation remains unavailable; no core source or schema changed for this milestone.

## 2026-09-30: Live office device discovery

Clippy's previous device lookup returned historical inventory only. Support Desk now exposes `support_discover_devices` for a live, company-scoped office scan without a ticket or named computer. A guided **Discover office devices** form saves a company's IPv4 networks separately from Windows administration profiles. Each call selects one saved /24–/32 network, permits at most 16 concurrent addresses, checks ICMP and 11 fixed service ports, and has a 30-second deadline. Concurrent calls for the same company are rejected. Observations retain timestamps, checked/total counts, partial results and explicit reachability limitations in company state and activity history. Historical device lookup includes these saved scans.

OS DNS runs in a bounded isolated child so Windows name-resolution configuration works without leaving uncancellable native lookups in the plugin worker. Forward-checked names from currently permitted company inventory and exact access rules provide a fallback. An observed name is suggested for deeper Windows investigation only when current forward DNS returns the observed IP and saved company remote access permits the target. Discovery resolves no passwords, grants no new administration access, and runs no repair. Device names and open ports do not establish health or device type; firewalls, sleeping devices and UDP-only services can be missed.

Verification: 68 Support Desk tests, type check and build pass. Installed Clippy discovery checked all 254 addresses in the authorized deployment network in about 17 seconds, observing 50 devices and eight names, including a previously investigated workstation. Clippy used the new tool from an ordinary scan request and reported the limits instead of claiming healthy devices. Scan configuration and observed addresses/names remain deployment data outside the repositories. No production repair or outbound message was run. Browser visual validation and the main repository suite were not rerun; core source and schema did not change.

## 2026-09-30: Fleet health checks and authenticated inventory

Clippy can now discover a saved office network, plan a bounded Windows health check, investigate one permitted computer per continuation, and resume or stop the recorded job. Each diagnostic creates a conversation-owned case and samples inventory, CPU/memory, disk space, services, recent System event metadata, restart indicators and Windows print queues. Missing sections, failed calls, skipped devices and interrupted work remain explicit. Jobs are durable; commands run only while tools are called. Cancellation stops subsequent diagnostics, including devices saved during planning; an already-running remote command may finish. This stage performs no repairs.

Successful authenticated inventory records company-scoped asset identities using both Windows MachineGuid and hardware UUID. Missing identifiers fall back to the exact target; serial numbers alone never merge computers. Recorded aliases include their provenance and observation dates. Conflicting computer names require review for cloning or renaming. Aliases do not grant access or change the existing hostname-based repair lock; cross-alias repair coordination remains future work. Device snapshots and fleet progress are visible in the Support toolkit.

Verification: 77 Support Desk tests, type check and build pass, including actual Windows PowerShell parsing, company/person/conversation boundaries, permission revocation, concurrent continuation, cancellation during planning, worker loss and durable resumption. Installed Clippy completed an authenticated workstation health assessment with a stable asset record and dashboard progress reporting. Live testing corrected literal PowerShell script assembly and an SQL expression incompatible with the host namespace validator. Findings identify observations for investigation, not an established root cause or a complete health guarantee. Deployment identities and findings remain outside committed sources. No production repair or outbound message was performed. Browser visual validation and the main repository suite were not rerun; the main repository changes are documentation only.
