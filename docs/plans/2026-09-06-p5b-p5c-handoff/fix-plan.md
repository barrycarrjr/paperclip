# Review fixes for P5b and P5c (drafted while the verify stage runs; refuted items are struck before launch)

Ground rules for every item: edit the real working tree (no worktree), keep the existing uncommitted P5b/P5c work intact, ship tests with the change, no em or en dashes in anything persisted or on screen, plain words on screen, read back any scripted multi-line edit, run the package's own tests for the files touched before returning. Do not commit. Report exactly which files changed and which tests you ran with their result line.

## HOST paperclip (~/paperclip, branch ux-control-center) - items run in parallel, each owns distinct files

### H1 issue-thread-interactions.ts: hand-over and cancel hooks fire only for the plan card
Findings: correctness-1, correctness-2, security-2.
Files: server/src/services/issue-thread-interactions.ts, server/src/__tests__/issue-thread-interactions-service.test.ts.
Fix: getStartWorkContainer also selects originId. In both hooks (accept ~996, reject ~1111) fire only when the card being decided is the plan card: its idempotencyKey === startWorkInteractionIdempotencyKey(container.originId) (import from @paperclipai/shared), AND container.status === "backlog" AND container.assigneeAgentId === null. Otherwise fall through to touchIssue exactly as an ordinary issue does. Tests: a second, agent-created suggest_tasks card on an already accepted start_work container leaves the container untouched on accept (status, assignee, description unchanged, no second "## Accepted plan") and on reject (not cancelled).

### H2 plugins.ts: a mismatched params.companyId is an access check, not a 400
Findings: regressions-bridge-400-breaks-rule-settings-pages (email-tools RulesSettingsPage and help-scout RulesSettingsPage deliberately send the mailbox's own companyId in params while the runtime sends the selected company in body), tests-005.
Files: server/src/routes/plugins.ts (stampPluginBridgeHostScope), server/src/__tests__/plugin-routes-authz.test.ts.
Fix: keep the stamp (hostScope.companyId stays the validated body company). When params.companyId is a non-empty string different from validatedCompanyId, call assertCompanyAccess(req, params.companyId) (403 when the caller has no access to that company) instead of throwing badRequest. Update the doc comment. Tests: the test pinning the 400 becomes: mismatch to a company the caller cannot access -> 403; mismatch to a company the caller can access -> passes through to the worker with params.companyId unchanged and hostScope.companyId = the body company. Add tests-005: mockLogActivity rejects once on POST /api/plugins/:id/actions/review-post-reply -> 200 with the worker result, failure logged.

### H3 chat-providers.ts: one-shot model order is native, then explicit, then discovered
Findings: regressions-ai-rewrite-env-model-now-beats-native, correctness-8. The HEAD ai-rewrite route picked a configured native provider first and only reached PAPERCLIP_CHAT_DEFAULT_MODEL inside pickBestDefaultModel.
Files: server/src/services/chat-providers.ts (pickOneShotModel), server/src/__tests__/chat-providers.test.ts.
Fix: move the native loop above the explicit env check. Tests: env var honoured when no native provider is configured; with ANTHROPIC_API_KEY and PAPERCLIP_CHAT_DEFAULT_MODEL=gpt-4.1 both set the pick is the anthropic default model; the unconfigured-explicit case still falls through.

### H4 start-work.ts and starter-catalog.ts: repair round, roster, wording, rate limit, retry header
Findings: correctness-6, security-4, security-7, ux-honesty-12, ux-honesty-14, tests-004.
Files: server/src/services/start-work.ts, server/src/services/starter-catalog.ts, server/src/services/attention-queue.ts, server/src/__tests__/start-work-service.test.ts, server/src/__tests__/attention-queue-start-work.test.ts, server/src/__tests__/starter-catalog*.test.ts (whatever exists), server/src/routes/start-work.ts if the limit lives there.
Fix:
- correctness-6: run the unknown-parent and cycle checks (buildTaskCreationOrder's rules) inside draftWithModel's validation so the model gets its one repair round with that problem quoted back; any HttpError still raised by buildTaskCreationOrder inside normalisePlan maps to UNUSABLE_PLAN_MESSAGE. Update the two pinned expectations (they now expect the repair call to happen and the 422 text to be UNUSABLE_PLAN_MESSAGE when the repair also fails).
- security-4: exclude status "pending_approval" in usableRoster and in pickAssigneeForCompany (one shared predicate, ideally the same one assertAssignableAgent uses). Test: a pending_approval CEO is never picked and never proposed.
- security-7: a cheap in-memory limit on the plan route or service: at most 10 plan drafts per user per company per 10 minutes, answering 429 with "You have asked for a lot of plans in a short time. Wait a few minutes and try again. Nothing was created." Test it. Record the draft in the activity log (action "issue.start_work.planned" or similar) before the model call so use is visible.
- ux-honesty-12: attention-queue consequence for a person-created plan becomes "No tasks are created until you accept it. Waiting costs nothing." (the request issue itself does exist). Update its test.
- ux-honesty-14: findExisting must return the same leftOut list and notes (soundsRecurring, recurringNote, portfolio note) the first response carried. Persist them with the plan in the same transaction. Pick the least invasive home: an existing jsonb column on issue_thread_interactions that is not pinned by suggestTasksPayloadSchema or the accept path; if none is safe, a small JSON block is not acceptable inside the operator's description, so use the container issue's existing jsonb metadata column if one exists; explain the choice in a code comment. Test: re-sending the same requestKey returns identical leftOut and notes.
- tests-004: in the "creates the container", concurrent and repeated-key tests assert agent_wakeup_requests and heartbeat_runs are both empty after plan().

### H5 StarterCatalogDialog.tsx: honest access state, honest receipts
Findings: ux-honesty-04, ux-honesty-05, ux-honesty-13, tests-009, tests-010, security-4 (client half).
Files: ui/src/components/StarterCatalogDialog.tsx, ui/src/components/StarterCatalogDialog.test.tsx.
Fix:
- ux-honesty-04: read isLoading and isError from the board-access query. While loading, buttons disabled with "Checking your access..."; on error an error box "Could not check your access. Close and try again."; the browse-only sentence only when boardAccess is present and says viewer.
- ux-honesty-05: the owner receipt step says "Handed to <name>." plus, when plan.warnings names that agent as paused by budget, "<name> is paused by budget, so it will not start until the budget is raised."; otherwise "It will pick this up on its next run." Never "has been woken".
- ux-honesty-13: Reject shows a receipt: title "Plan rejected", one step "Request <identifier> was cancelled. Nothing was started." with the link, before clearPlan().
- tests-010: if issuesApi.get fails after acceptInteraction succeeded, still show "Plan accepted" with the owner step "Nobody could be confirmed; open <identifier> to check who has it" (ok:false); test it.
- tests-009: render the plan card for a viewer through a seeded plan and assert the accept and reject buttons are absent from the card; or delete the dead ternaries and the vacuous assertions. Pick the first.
- security-4 client half: handleDecisionError treats a 409 as "Someone already decided this plan" only when the message is "Interaction has already been resolved"; any other 409 is shown as its own sentence.

## EXT paperclip-extensions (~/paperclip-extensions, branch master, plugins/gbp-reviews) - items run in sequence E1 -> E2 -> E3 because they share worker.ts

### E1 replyGuard.ts, replyStore.ts, reviewQueries.ts, worker.ts review-detail: no review can be blocked forever, and the slot is claimed before the live read
Findings: security-1, correctness-3, correctness-4, correctness-5, data-integrity-stale-posting-row-permanent, data-integrity-unknown-row-never-settled, data-integrity-restarted-row-keeps-created-at, tests-001, tests-002, tests-003, tests-008, security-3, data-integrity-idempotency-key-not-bound-to-review, correctness-7.
Files: src/replyGuard.ts, src/replyStore.ts, src/reviewQueries.ts, src/worker.ts (review-detail handler only), src/replyGuard.test.ts, src/reviewQueries.test.ts, src/worker.handlers.test.ts.
Fix, in this order inside postReplyGuarded:
1. Step 6 (own key): refuse EINVALID_INPUT "This attempt key belongs to a different review. Start a new one." when own.reviewName !== reviewName or own.companyId !== companyId (and add both predicates to the WHERE of beginPost's ON CONFLICT DO UPDATE). Different text: allowed only when own.status === "failed" (beginPost's DO UPDATE then also sets reply_text = EXCLUDED.reply_text); still refused for "unknown" and "posted" and "posting". An own "posting" row older than STALE_IN_FLIGHT_MS (measured from updatedAt, not createdAt) is marked "unknown" with error "Abandoned: the worker that started this attempt did not finish." and treated as unknown from here; a young one is still EDUPLICATE_IN_PROGRESS.
2. Step 7 (another key): findInFlight returns the newest row with status IN ('posting','unknown') for the review. A "posting" row younger than STALE_IN_FLIGHT_MS (by updatedAt) refuses as today. A stale "posting" row is first marked "unknown" (same sentence) so the partial unique index frees the slot; any "unknown" row of another key is remembered for reconcile after the live read.
3. Claim before you look: beginPost(previous_* = null) BEFORE getOAuthClient and getReview. "duplicate" -> EDUPLICATE_IN_PROGRESS. From this point every refusal or thrown error before the PUT calls finishPost(key, "failed", message) and rethrows, so the slot is released (wrap in try/catch/finally logic; the allow-list throw from getOAuthClient is the tests-003 case: row failed, zero Google calls).
4. After the live read: reconcile the remembered other-key row against live (exported reconcileAgainstLive); own-unknown reconcile as today (live text equals ours -> posted receipt); overwrite rules as today; then store.recordPrevious(key, liveReply?.comment ?? null, liveReply?.updateTime ?? null) (new small store method) before the PUT.
5. finishPost(key, "posted") wrapped in try/catch: on failure log at error, recordedLocally = false, still attempt upsertReview, still return the receipt with postedAt = result.updateTime.
6. beginPost's DO UPDATE also sets created_at = now() is NOT wanted (keep created_at as the first attempt time); staleness everywhere uses updated_at. Expose updatedAt on ReplyPostRow (it is already selected).
7. Page path: export settlePendingAttempts(deps, reviewName, live) from replyGuard.ts that reconciles every row of that review with status "unknown", or "posting" older than STALE_IN_FLIGHT_MS, against the live review; review-detail in worker.ts calls it after a successful live read (skips when Google could not be read). findPendingAttempt then returns only "posting" rows whose updated_at is within STALE_IN_FLIGHT_MS (pass the window in, do not hardcode a second copy), so a crashed or dropped attempt can never hide the Post button for good.
Tests (replyGuard.test.ts MemoryStore must implement the new methods faithfully, including the WHERE rules): stale own posting row -> abandoned, reconciled, exactly one PUT; stale other-key posting row -> reconciled then our post proceeds; other-key unknown row with live text equal to its text -> marked posted, our post refused EREPLY_EXISTS without replace; getOAuthClient throws ECOMPANY_NOT_ALLOWED after the claim -> row failed, zero getReview and zero PUT; finishPost throws after a successful PUT -> receipt returned with recordedLocally false; reused key for another review -> refused, nothing restarted; agent retry with new text on a failed row -> allowed, one PUT; reconcile third branch (Google holds a different reply) -> row unknown with its sentence, zero PUTs; every finishPost detail sentence goes through the dash sweep. reviewQueries.test: findPendingAttempt ignores a posting row older than the window and ignores unknown rows. worker.handlers.test: review-detail with a stale posting row returns pendingAttempt null and the row settled.

### E2 worker.ts sync and tools, replyStore upsert: rows follow their location, sources are honest, tools scope like the guard
Findings: data-integrity-repointed-location-orphans-rows, regressions-stale-company-rows-hidden-and-never-repaired, data-integrity-sync-insert-missing-reply-source, data-integrity-reply-source-flips-to-google, data-integrity-last-synced-is-last-write, ux-honesty-06, security-5, security-6, tests-007, ux-honesty-08 (worker half), tests-006.
Files: src/worker.ts, src/replyStore.ts (upsertReview ON CONFLICT only), src/reviewQueries.ts (lastSyncedAtForLocation), src/worker.handlers.test.ts, src/replySource.ts if needed, a new src/replyStore.pg.test.ts.
Fix:
- Sync existing-row UPDATE also sets location_key and company_id from the location; upsertReview's ON CONFLICT DO UPDATE sets the same two columns. Test: a row stored under company A for a location now pointing at B is visible to B after one sync.
- Sync INSERT includes reply_source = nextReplySource({replyText:null, replySource:null}, {replyText: live reply or null}) ("google" when a reply exists, else null).
- Before defaulting a changed reply to "google", look up reply_posts for a "posted" row on this review whose reply_text equals the live text and keep its source (one SELECT only when the text changed).
- Last synced: record the sync time per location in ctx.state (stateKey "last-sync:<locationKey>", scopeKind instance) at the end of syncLocationReviews and read it in review-list and review-sync-location; a location never synced returns null and the page says "Not synced yet".
- security-5: the agent tool passes userId: runCtx.userId ?? null in scope; beginPost records actor_user_id for agent rows too.
- security-6: gbp_sync_location and gbp_list_reviews refuse with fail("[ECOMPANY_NOT_ALLOWED] ...") when location.targetCompanyId !== runCtx.companyId, before any Google call. Handler tests for both.
- tests-007: tool test with locationKey of another location and MAIN_ST's review asserts the reply_posts INSERT carries main-st and COMPANY_A; and a nonexistent locationKey still resolves from the review name.
- ux-honesty-08: review-detail returns posting: { accountFound, accountAllowed }.
- tests-006: one test file that runs createDbReplyStore against a real Postgres when GBP_REVIEWS_TEST_DATABASE_URL is set (skips with a printed reason when unset), asserting beginPost returns "duplicate_key" for a posted key, restarts a failed key, refuses a second key while one is posting (the partial unique index), and the new WHERE predicates hold.

### E3 Reviews page copy and small UI truths
Findings: ux-honesty-02, ux-honesty-03, tests-011, ux-honesty-07, ux-honesty-09, ux-honesty-10, ux-honesty-11, regressions-readme-em-dash, ux-honesty-15, ux-honesty-08 (page half).
Files: src/ui/replyErrors.ts, src/ui/replyErrors.test.ts, src/ui/editorState.ts, src/ui/editorState.test.ts, src/ui/ReviewEditor.tsx, src/ui/index.tsx, src/manifest.ts, README.md.
Fix:
- EPOST_UNCONFIRMED sentence: "The connection dropped while posting, so it is not known whether the reply reached Google. Press Yes, post it again: it checks Google first and will not post twice." (the panel keeps its key on failure, confirmed in ReviewEditor.post).
- Access sentences: map only "Viewer access is read-only" to "Your role in this company is view-only, and this page needs a role that can create work. Ask an admin to change your role to see or reply to reviews."; map "does not have access" to "You do not have access to this company's reviews."; update the test.
- Location card: "No rating yet" when avgRating is null (no "/5 avg" glued on), and "No reviews yet" in a neutral colour when totalReviews === 0 instead of the green All replied badge.
- Toast on alreadyPosted: title "Already posted", body "Google already had this reply; nothing was sent twice."
- manifest.ts SETUP_INSTRUCTIONS: remove the four em dashes (line 6 title and the three troubleshooting bullets) with ":".
- README.md line 145-146: replace " — " with ": ".
- Dashboard widget error: render describeReplyError(error) inside ErrorNote instead of the raw message.
- whyNoPostButton: when posting.accountFound is false say "This location's Google account (<key>) is not in the plugin settings, so nothing can be posted from here." before the allow-list sentence; tests.
- Re-run the whole plugin test suite and the build (npm run build) at the end and report the bundle builds.

## Not fixed in this batch, recorded for the handoff doc
- security-7 metering beyond the cheap limit (real per-call cost accounting) stays deferred, as the spec said.
