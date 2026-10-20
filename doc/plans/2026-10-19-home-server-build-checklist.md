# Home server build checklist

## Run sheet

1. Record build authorization and the choices below privately. STOP execution while required choices remain blank.
2. Inventory all seven components below. STOP if any required part or recovery material is unaccounted for.
3. Write the chosen system's install, dormant restore, cutover and recovery commands. STOP until reviewed.
4. Prepare an independent, dormant trial and restore a trusted backup. STOP if execution or external effects cannot be prevented.
5. Check the dormant copy's data and files, then stop it. STOP on missing data, keys or unresolved privacy/isolation requirements.
6. At authorized cutover, finish or cancel and reconcile work; pause agents/routines and disable plugins, then stop execution and automatic starts. STOP while queued, running or retry work remains; only then take the final consistent backup and file set.
7. Restore the final set on the server, still dormant; repeat data checks. STOP if the laptop or its agent processes still run.
8. Decide whether to proceed before new operational activity. Before that boundary, recovery can stop the server and resume the preserved laptop copy.
9. After approval to proceed, keep individual items paused/disabled while turning the instance-wide scheduler and plugin runtime on. Resume or enable one item with its bounded acceptance check; STOP and follow step 10 on failure. Keep the laptop off.
10. After any new activity, recovery must stop execution and reconcile both data and external actions before either copy resumes; never replay blindly.

## Scope and private build record

Issue #133 requests this reusable parts checklist, for use during the later home server phase. No box is marked complete. This document does not authorize buying, installing, signing in, exposing a service, moving data or changing a live instance. It chooses no machine, operating system, model, account or subscription. Literal commands depend on those choices and belong in the private build record, not an invented operating system recipe here.

This repository is public. Keep the filled inventory, chosen-machine details and execution results in an operator-controlled private record **outside this repository**. Do not fill this public file with account names, identities, actual folder paths, instance IDs, addresses, logs, secrets or business details. Store secret material separately in protected storage; the private record should reference it rather than duplicate it. Public examples and placeholders must remain synthetic. See [repository sensitive-data rules](../../AGENTS.md#12-sensitive-data-never-commit-never-post).

Create these blank fields in that private record, and resolve them only when the build is authorized:

- Machine and operating system: ____; install method and fork revision: ____.
- Database engine/version, backup scope, restore method and recovery point: ____.
- Instance identity, protected key source, file/storage mapping and backup destination off the server: ____.
- Server account, agent account boundaries, allowed files/tools and network destinations: ____.
- Local model purpose, model, serving location, memory/storage capacity and measured speed: ____.
- Cloud fallback owner, allowed data, spending limit and manual switch procedure: ____.
- Access mode, listening interface, authentication, TLS if required and permitted clients: ____.
- Start after reboot, clock/timezone, reminder delivery, monitoring and old laptop role: ____.
- Trial containment, acceptance scope, cutover approval and post-activity reconciliation owner: ____.

Recheck #131 (knowledge base plugin, including its open decision on restricted notes in saved run logs) and #132 (machine isolation and per-agent credentials, including inheritance) before building. Both remain pending dependencies here; unmerged work is not an available safeguard. A local launcher running agents as the server account is not operating system isolation. An unsupported choice blocks the affected build step, not completion of this generic checklist.

## Dormant restore and recovery boundary

A dormant trial may coexist with the laptop only as a contained restored copy, never as a second active instance. Before its first start:

- [ ] Give it independent database/data directories, storage copies, application/database ports and configuration. Confirm it cannot connect to or modify the live database, shared folders or storage bucket.
- [ ] Bind to isolated loopback with no proxy, forwarding or other clients. Apply operator-controlled process, filesystem and network restrictions that prevent agent launch, tool subprocesses, outbound calls and access to live resources. Deny manual wakes, chat runs, webhook callbacks and tool invocation; do not expose restored credentials to an executing runtime.
- [ ] Set the existing `HEARTBEAT_SCHEDULER_ENABLED=false` and `PAPERCLIP_PLUGIN_RUNTIME_ENABLED=false` for every trial start. These disable scheduled/startup heartbeat recovery and plugin startup, including external MCP warm-up; routes remain mounted. They are **not a global no-execution switch**. The additional restrictions above are prerequisites, not a claimed Paperclip feature. See [startup scheduling](../../server/src/index.ts) and [plugin startup control](../../server/src/plugin-runtime-startup.ts).
- [ ] Also set `PAPERCLIP_MODEL_CLI_DISCOVERY=off` and `PAPERCLIP_MODEL_CATALOG_URL=off` to stop model discovery from spawning provider commands or fetching the catalog. These settings do not replace containment. After the trial, stop and protect its copies of data, keys and sign-ins until their approved disposal.
- [ ] Restore only a trusted operator-produced SQL backup using a reviewed, version-compatible procedure. Verify included schemas and matching protected key/file material before starting. If an optional restore wizard would require live plugins or network access, use a separately reviewed contained restore procedure instead; do not relax dormancy to use the wizard.
- [ ] Limit checks to local health, restored records/counts, attachment copies and instruction/memory files. Record any trial-local changes privately and discard them from the final migration set. Do not run a secret-backed agent, provider sign-in test, model discovery or live tool acceptance while the laptop remains active. If containment cannot be demonstrated, STOP the trial.

The final migration uses a new consistent backup and file set after laptop execution is stopped, not the earlier trial's modified data. Preserve the laptop recovery copy and record both backup identity and checksums privately. Startup and restore may write the target database even with scheduling off; validate the final dormant state before permitting operational activity.

The recovery boundary is the first new operational write or external action after that preserved recovery point. Agent health runs, chat, sign-ins and tool checks can write state, spend money or act externally, so treat them as crossing the boundary. Before it, stopping the server and resuming the preserved laptop copy is possible only if that copy still represents all operational work. After it, keep both copies stopped, preserve new records and action receipts, reconcile completed or uncertain actions and select one authoritative recovery state. Restarting the stale laptop or repeating a send is not automatic rollback.

## 1. Harness (agent runtimes)

Paperclip uses an adapter to invoke a runtime, such as an installed command-line agent. Start with the [adapter overview](../../docs/adapters/overview.md) and the relevant adapter's documentation; install Paperclip from the [fork installation guide](../FORK-INSTALL-AND-SECURITY.md) or the conditional [container guide](../DOCKER.md).

- [ ] Preconditions: privately list every adapter, executable/version, instruction bundle, working directory, required desktop feature and credential source. Choose the server/agent account layout before installing or signing in. Install only the inventoried requirements under that layout.
- [ ] Account for runtime-owned sign-ins and session files as well as Paperclip-managed accounts. Do not copy the operator's entire personal CLI home. Preserve needed instruction companions; a saved session may need a fresh start if its runtime files or paths do not move. Review [workspace and managed runtime homes](../DEVELOPING.md#default-agent-workspaces).
- [ ] If using SSH execution, verify the chosen adapter and a POSIX target shell are supported by the current implementation; the [SSH transport](../../packages/adapter-utils/src/ssh.ts) uses Unix shell commands. Do not assume a Windows target or a launcher provides the isolation required by #132. Optional sandbox plugins require their own compatibility and acceptance work.
- [ ] Success check, after cutover authorization: each required runtime completes one bounded synthetic task under the intended account, reads its required instructions and stops cleanly. Measure timeout/turn limits using [run-limit guidance](../DEVELOPING.md#new-agent-run-limits); record desktop-dependent features that remain unavailable.

## 2. Local model

The [Ollama adapter configuration](../../packages/adapters/ollama-local/src/index.ts) describes `ollama_local` as reply-only inference, without tool use or file editing. The [Aider adapter](../../docs/adapters/aider-local.md) supplies coding through an installed runtime. These are different capabilities, not interchangeable replacements.

- [ ] Preconditions: decide whether a local model is needed, its task and quality requirements, then size memory, compute and storage for that model. Record its serving location, permitted clients and reachable address privately. The adapters describe unauthenticated Ollama access; do not expose that endpoint without separately reviewed access controls.
- [ ] Prepare the chosen model before live acceptance. Check actual context capacity and latency against the task and run limits. For attached company procedures, follow the extra running-model/context requirements in [procedure guidance](../DEVELOPING.md#attached-company-procedures); do not assume Paperclip loads a cold model or enlarges its memory.
- [ ] Success check, after cutover authorization: complete a synthetic reply task and, if required, a coding task in a disposable workspace. Check resource use and timeout behavior. Safely simulate model unavailability on a disposable model service by stopping it, not by deleting a live model or naming an absent tag that the adapter may download. Confirm visible failure or applicable unavailable-model pause, not an assumed cloud switch. See [model lists](../../docs/adapters/overview.md#model-lists).

## 3. MCP tools

MCP is the protocol through which an agent calls connected tools. Privately inventory Paperclip plugins, registered external MCP servers and each runtime's own tool configuration. Current [external server settings](../../packages/db/src/schema/external_mcp_servers.ts) include company allowlists, tool lists and separate mutation controls; stdio servers execute commands on the Paperclip host outside the plugin sandbox.

- [ ] Preconditions: identify each tool's executable or endpoint, required files, secret references, company scope and read/write permissions. Install or repoint local-folder plugins and stdio commands on the chosen host. Permit only required tools and approved destinations; verify external service access only during authorized acceptance.
- [ ] For Claude, review the [strict MCP configuration and temporary bridge file](../../packages/adapters/claude-local/src/server/execute.ts). It excludes personal MCP configuration. For other runtimes, inspect what they load rather than assuming the same behavior.
- [ ] If agents execute over SSH, verify that they can read the intended bridge configuration and reach the Paperclip host. The [heartbeat bridge URL](../../server/src/services/heartbeat.ts) uses host loopback and Claude writes its configuration in host temporary storage. This is a static compatibility concern, not a reproduced failure or a promised remote fix. STOP affected tool acceptance until resolved.
- [ ] Success check, after cutover authorization: one permitted synthetic read per required tool connection, plus a harmless approval/refusal check for a write. Confirm company boundaries and activity records; do not send real messages or change external records just to prove connectivity.

## 4. Files and memory

Use the [database/secrets guide](../DATABASE.md#secret-storage), [backup settings](../DEVELOPING.md#automatic-db-backups) and [instance path definitions](../../server/src/home-paths.ts). A database backup alone does not include filesystem workspaces, local attachments, external memory folders, runtime sign-ins or the encryption key.

- [ ] Preconditions: privately map configuration and instance identity, database, matching master key, local/object storage, workspaces/projects, agent instructions, memory folders, locally sourced skills/plugins, MCP command paths and runtime/session homes. Include [encrypted account stores](../../server/src/services/adapter-accounts.ts) outside the instance directory and their matching encryption material. Do not start against encrypted data with a newly generated replacement key.
- [ ] Use a tested logical SQL backup/restore route. The [backup library](../../packages/db/src/backup-lib.ts) writes SQL; the CLI has a backup command but no general restore command. Write and rehearse the actual restore procedure for the selected versions, permissions and compression format, targeting a compatible PostgreSQL major version that is the same or newer. Do not assume the container example's database version accepts a newer source dump. Do not substitute an unverified raw database-directory copy across machines, systems or versions. PostgreSQL documents the [SQL dump method and restore prerequisites](https://www.postgresql.org/docs/18/backup-dump.html).
- [ ] Verify backup scope explicitly: the built-in database backup targets the public schema, while [system snapshots](../../server/src/routes/system-snapshot.ts) also enumerate included and excluded plugin namespaces. Account for every required plugin schema and any opted-out data. These backups omit the migration journal; the restore procedure must preserve or supply the matching journal, for example by starting with a database initialized at the matching fork revision. Rehearse the exact procedure and verify startup accepts it. An optional [backup plugin restore wizard](https://github.com/barrycarrjr/paperclip-extensions/blob/76a86c257f3362fde0cdde605aaf09ab1f727302/plugins/backup-tools/README.md) does not replace separately backing up files/keys; its archive key must be recoverable on the destination. Restore only archives you trust, because SQL restore can execute commands.
- [ ] Rewrite stored host paths when locations change; handle path-bound runtime configuration and sessions deliberately. Verify memory folder permissions and run the [memory checks](../DEVELOPING.md#memory-folder-checks) only against the intended copied folder. Configure retention and a protected backup copy off the server.
- [ ] Success check: in the dormant trial and final dormant restore, compare expected core/plugin data counts, open a copied attachment and verify instruction/memory files. After cutover authorization, separately verify secret-backed execution and a newly created recoverable backup. Treat saved logs as sensitive pending #131 and #132; do not publish their contents or assume filtering is shipped.

## 5. Scheduler

Schedules run within the server. Review the [scheduler contract](../SPEC-implementation.md#115-scheduler-rules), [routine catch-up implementation](../../server/src/services/routines.ts) and startup controls above. After downtime, the default `skip_missed` still permits one overdue run; `enqueue_missed_with_cap` can enqueue up to 25.

- [ ] Preconditions: inventory timers, routines, plugin jobs, webhooks and reminders privately, including their prior enabled states. Let active work finish, or cancel it and reconcile completed or uncertain external actions. Pause agents and routines and disable plugins using supported controls before the final backup; pausing an agent cancels its queued, running and scheduled-retry runs. Verify no such run remains, stop runtime services and detached workers, and disable old automatic starts. Never run two active copies of the same instance.
- [ ] Turning the scheduler on starts recovery: old running records may be failed and retried, due retries and queued runs resume, and stranded assignments can be dispatched. Stored process IDs belong to the old machine; matching IDs on another host can signal unrelated processes or make work appear alive. Turning the plugin runtime on starts every enabled plugin and its due jobs together. Before either flag is enabled, on the server or a resumed laptop, verify reconciled terminal run records, paused agents/routines and disabled plugins. Review [heartbeat recovery](../../server/src/services/heartbeat.ts); stopping the server alone does not finalize its runs.
- [ ] Choose and test unattended start/stop/recovery for the actual system. Source launchers provide desktop/login behavior; this checklist supplies no source-install boot service. The container guide's Podman Quadlet units are a separate conditional route, not proof that a chosen machine will restart successfully.
- [ ] Success check, after cutover authorization: with agents/routines paused and plugins disabled, turn the instance-wide runtime flags on, then resume or enable one reviewed item at a time and run its bounded acceptance check. Review queued/retry state again before waking an acceptance agent so old work cannot run first. Observe one timed task and reviewed catch-up work, and check recent scheduler status at `/api/instance/scheduler-heartbeats`. STOP and reconcile on failure. Test a real reboot with the laptop still off, verify one intended instance resumes, and confirm reminders reach an attended channel.

## 6. Cloud fallback

The [model-selection contract](../SPEC-implementation.md#78-heartbeat_runs) chooses a model by task rules; its fallback covers an unmatched rule, not recovery from failed inference. [Stored-account failover](../../server/src/services/adapter-accounts.ts) retries eligible accounts on the same adapter. Neither supplies automatic failed-local-to-cloud switching.

- [ ] Preconditions: privately choose whether fallback is allowed, who authorizes it, which tasks/data may leave the server and its spending limit. Document a manual stop, inspect and switch procedure, or explicitly choose to leave the failed work stopped. Automatic cross-runtime failover would require separate product work.
- [ ] Inventory required cloud authentication without selecting a new account or subscription here. Check scope and protected credential delivery under the #132 outcome before live use.
- [ ] Success check, after cutover authorization: simulate a local failure with synthetic input, confirm it remains visible without an unexpected retry elsewhere, then test the approved manual cloud path once. Check for duplicate work, recorded provider/cost and respected limits.

## 7. Guardrails

The [action checkpoint](../SPEC-implementation.md#124-agent-action-checkpoint) governs brokered tool actions. Shell, browser and filesystem activity outside it needs runtime isolation. [Budget enforcement](../SPEC-implementation.md#132-enforcement-rules) stops work on reported spend; the Aider local adapter reports zero cost, so money limits alone do not bound local compute.

- [ ] Preconditions: resolve the #132 account/isolation layout for this build. Keep personal files/sign-ins outside agent access; verify allowed folders, credentials, subprocesses and network destinations. Do not treat credential-inheritance changes, optional sandbox plugins or company scoping as proven machine isolation.
- [ ] Review [deployment mode, binding and authentication](../DEPLOYMENT-MODES.md#2-canonical-model) before any non-loopback access. Resolve any TLS/private-access requirements explicitly. Keep trial loopback restrictions until the approved access configuration is ready.
- [ ] Review inherited [permission defaults](../../packages/shared/src/agent-permission-defaults.ts) at instance, company and agent levels. The code defaults for `claude_local`, `codex_local` and `opencode_local` skip runtime permission prompts; Codex also bypasses its sandbox. A restored instance retains the laptop's settings. Keep an agent on such a default only by explicit build-time decision; require scoped access and governed actions, rather than automatically enabling bypasses. Verify effective runtime flags as well as board settings.
- [ ] Review secret references and [strict mode](../DEVELOPING.md#secrets-in-dev), budgets, action approvals, timeout/turn/concurrency caps and cancellation. Strict mode blocks new sensitive inline environment values; it is not a promise that old saved logs are private or credentials isolated.
- [ ] Success check, after cutover authorization: synthetic denied-file, denied-tool, approval-required and cancellation cases fail safely; limits and company boundaries remain effective. Keep acceptance bounded and inspect private activity/error records. STOP unattended use if required isolation, privacy, approval or recovery checks remain unresolved.

Completion of this document establishes the parts list only. Actual installation, dormant restore, migration, SSH tool compatibility, isolation, reboot behavior and live acceptance remain unverified until the authorized build records their results privately.
