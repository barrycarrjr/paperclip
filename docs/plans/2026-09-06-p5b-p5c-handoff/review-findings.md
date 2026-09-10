## correctness-1 [high] paperclip:server/src/services/issue-thread-interactions.ts:996
**Accept hook fires for every suggest_tasks card on a start_work container, not only the plan card**

Claim: The hand-over at lines 996-1030 keys only on the host issue's originKind. Once the plan is accepted the container is todo and assigned to the lead, who is woken on it; HEARTBEAT.md and AGENTS.md tell agents to propose further work with suggest_tasks on the current issue, so the lead's later cards land on this same container. Accepting any of them re-runs the hand-over: status is forced back to todo (assertTransition at services/issues.ts:59 allows in_progress to todo), checkoutRunId and executionRunId are cleared (issues.ts:2862-2868), the assignee is replaced by the CEO-first pick, and a second '## Accepted plan' section is appended. The same happens if the operator had already assigned or started the container by hand before accepting from the issue page.

Scenario: Plan accepted; container CO-12 is in_progress, assigned to the engineer the CEO delegated to, with a checkoutRunId. The engineer proposes two more subtasks via suggest_tasks on CO-12. The board accepts them. Result: CO-12 drops to todo, loses its execution lock, is reassigned to the CEO, and its description gains a second Accepted plan block, while the engineer's run is still working on it.

Fix: Fire the hand-over only for the plan card itself: select originId in getStartWorkContainer and require claimed.idempotencyKey === startWorkInteractionIdempotencyKey(container.originId) (or claimed.createdByUserId && !claimed.createdByAgentId), and additionally require container.status === 'backlog' && container.assigneeAgentId === null so a container that already left backlog is never handed over again. Add a service test: an agent-created suggest_tasks card on an accepted start_work container leaves the container untouched.

## correctness-2 [high] paperclip:server/src/services/issue-thread-interactions.ts:1111
**Reject hook cancels the whole request when any later suggest_tasks card on the container is rejected**

Claim: rejectSuggestedTasks (lines 1111-1119) cancels the host issue whenever its originKind is start_work, without checking that the rejected card is the plan card or that the container is still an undecided backlog row. After the plan is accepted, the lead agent's own suggest_tasks proposals on the container are ordinary cards; rejecting one sets the container to cancelled (cancelledAt stamped by applyStatusSideEffects), leaving its accepted child tasks running under a cancelled parent and dropping the request from every pending list.

Scenario: Plan accepted, CO-12 todo with three child tasks in progress. The lead proposes 'also refresh the price list' as a suggest_tasks card on CO-12. The board rejects that one idea. Result: CO-12 becomes cancelled; the three children keep running with a cancelled parent and the request disappears from the Brief.

Fix: Apply the same gate as the accept hook: cancel only when the rejected card's idempotencyKey equals startWorkInteractionIdempotencyKey(container.originId) (or it was created by a user, not an agent) and the container is still status backlog with no assignee. Pin with a test that rejecting an agent-created card on an accepted container leaves the container status and cancelledAt unchanged.

## correctness-3 [high] paperclip-extensions:plugins/gbp-reviews/src/reviewQueries.ts:226
**A stale or unknown reply attempt hides the Post button forever; nothing on the page path can ever reconcile it**

Claim: findPendingAttempt returns the newest 'posting' or 'unknown' row of any age (reviewQueries.ts:226-229), review-detail passes it through (worker.ts:697), and canShowPostButton requires pendingAttempt === null (ui/editorState.ts:88). The only code that settles such rows is postReplyGuarded: 'posting' rows are reconciled only when a different key posts after two minutes (replyGuard.ts:233-255), and 'unknown' rows are never found by findInFlight at all (replyStore.ts:169 selects status = 'posting' only) and are only settled by a same-key retry. The idempotency key lives in React reducer state, not localStorage, so a reload loses it. The page therefore has no route back: the button is gone and the person cannot make the different-key attempt that would reconcile the row. reconcileAgainstLive itself also creates permanent 'unknown' rows (replyGuard.ts:181-185).

Scenario: Person clicks 'Yes, post it'; the worker process dies between beginPost and finishPost (row stays 'posting'), or the connection drops after the PUT (row 'unknown') and the person reloads the tab. From then on review-detail shows 'A post was attempted at ... and did not finish. Check the review on Google before trying again.' with no Post button, for that review, permanently. The invariant 'a crashed worker cannot block a review forever' holds only for the agent tool.

Fix: In review-detail, after the live Google read, settle stale rows: any 'unknown' row, and any 'posting' row older than STALE_IN_FLIGHT_MS, is reconciled against the live reply with reconcileAgainstLive (export it from replyGuard.ts), and findPendingAttempt returns only 'posting' rows younger than STALE_IN_FLIGHT_MS plus 'unknown' rows that could not be settled. Also make findInFlight (or a sibling) include 'unknown' rows so the guard's step 7 reconciles them for a different key.

## data-integrity-stale-posting-row-permanent [high] paperclip-extensions:plugins/gbp-reviews/src/replyGuard.ts:225
**A post interrupted by a worker crash leaves a 'posting' row nothing can ever settle from the page**

Claim: The spec promises that a 'posting' row older than two minutes is reconciled before any new attempt so a crashed worker cannot block a review forever. The code only reconciles a stale row when the NEW attempt carries a DIFFERENT key (replyGuard.ts:235, `inFlight.idempotencyKey !== input.idempotencyKey`); a retry with the same key is refused at replyGuard.ts:225-227 with no age check at all. And the page can never send a different key: findPendingAttempt (reviewQueries.ts:225-229) returns any 'posting' row regardless of age, canShowPostButton (editorState.ts:82-90) hides the Post button whenever pendingAttempt is non-null, and the sentence shown instead (editorState.ts:112-114) tells the person to try again, which the page will never offer. The only actors that can clear the row are the agent tool (a run: key) or a manual SQL edit.

Scenario: A person confirms a post; beginPost writes the 'posting' row (replyGuard.ts:302); the worker process is restarted (plugin redeploy, upgrade, crash) before finishPost at replyGuard.ts:331 runs. Same confirm panel, retry: findPost returns status 'posting' and the call is refused [EDUPLICATE_IN_PROGRESS] for ever. Reload the page: review-detail returns pendingAttempt = that row, the Post button is gone, and the text says 'A post was attempted at <time> and did not finish. Check the review on Google before trying again.' Days later it still says that. reply_posts holds a 'posting' row that never settles, and the local reviews row may disagree with Google (the PUT may have landed).

Fix: In step (6) of postReplyGuarded, when own.status is 'posting' and its createdAt is older than STALE_IN_FLIGHT_MS, set staleInFlight = own and fall through instead of refusing (the same reconcile step (7) already runs at line 255 for another key). In findPendingAttempt, exclude 'posting' rows older than STALE_IN_FLIGHT_MS (`AND (status = 'unknown' OR created_at > now() - interval '2 minutes')`) so the page offers the button again and the next post reconciles the row. Add a replyGuard test: an own 'posting' row older than two minutes with no live reply is finished 'failed' and the attempt proceeds to exactly one PUT.

## regressions-bridge-400-breaks-rule-settings-pages [high] paperclip:server/src/routes/plugins.ts:719
**The new 400 on a mismatched params.companyId breaks the email-tools and help-scout rule settings pages**

Claim: stampPluginBridgeHostScope (server/src/routes/plugins.ts:716-719) refuses any bridge call whose params.companyId differs from body.companyId. The host runtime always sends body.companyId = hostContext.companyId (ui/src/plugins/bridge.ts:235 and :259-263 for getData, :326-342 for actions), and for a plugin settings page that context is the sidebar's selected company (ui/src/pages/PluginSettings.tsx:67, :173, :339). Two existing settings pages deliberately send a DIFFERENT company in params: plugins/email-tools/src/ui/RulesSettingsPage.tsx:131-136 (and :168, :194) sends the mailbox's own companyId from email.list-rule-scopes, with the comment at :35-38 saying the screen is instance-level and the mailbox carries its own company rather than the one the operator is viewing; plugins/help-scout/src/ui/RulesSettingsPage.tsx:152-157 (and :186, :202) does the same. Their workers read params.companyId (plugins/email-tools/src/worker.ts:1458-1466, plugins/help-scout/src/worker.ts:2040-2041). The spec's safety claim that the 400 cannot break email-tools because it sends identical values in both places (specs.md line 14) only looked at ui/src/api/emailTools.ts, not at these plugin-rendered pages.

Scenario: Sidebar is on HQ (or any company other than the mailbox's). Open Plugins > Email tools > Settings; the rules panel picks a mailbox filed under company B. The runtime posts body.companyId = HQ and params.companyId = B to /plugins/:id/data/email.list-rules. Before this change the worker got B and listed the rules; now the host answers 400 '"params.companyId" must match "companyId"' before the worker is called, the panel shows that sentence instead of the rules, and Add rule / Remove (email.set-rule, email.delete-rule, helpscout.set-rule, helpscout.delete-rule) fail the same way. Only a mailbox that happens to belong to the currently selected company still works.

Fix: Keep the stamp but replace the refusal with a second access check: in stampPluginBridgeHostScope, when typeof params.companyId === 'string' and it differs from validatedCompanyId, call assertCompanyAccess(req, params.companyId) (403 when the caller has no access to that company) instead of throwing badRequest. That still closes the member-of-A-acts-on-B hole for plugins that read params.companyId, and the instance-level rules pages keep working. Update the two plugin-routes-authz tests that pin the 400 (a mismatch the caller is not entitled to becomes 403; a mismatch the caller may access passes through).

## ux-honesty-01 [high] paperclip-extensions:plugins/gbp-reviews/src/ui/editorState.ts:113
**A dropped connection or a worker crash removes the Post button for that review for good**

Claim: The page hides the Post button whenever the review has a reply_posts row in status posting or unknown (findPendingAttempt, reviewQueries.ts:227) and shows the sentence 'A post was attempted at <time> and did not finish. Check the review on Google before trying again.' Nothing the page can do ever clears such a row: the only code that settles a stale posting row (replyGuard.ts:233-243 and :255) or an unknown row (replyGuard.ts:257-262, same key only) runs inside postReplyGuarded, which the page reaches only through the button it has just hidden; findInFlight returns posting rows only (replyStore.ts:169), so an unknown row is never reconciled by any other caller; the daily sync never touches reply_posts. 'Before trying again' promises a retry that cannot happen.

Scenario: The operator posts, the connection drops after the PUT, the row is marked unknown. He reopens the review: review-detail returns pendingAttempt {status:'unknown'}, canShowPostButton is false, the sentence tells him to check Google before trying again. He checks, comes back, and there is no button, today or next month. Same outcome when the worker dies between beginPost and finishPost (a posting row that never ages out on the page).

Fix: In review-detail (worker.ts:697) settle rows the way the guard does before computing pendingAttempt: for a posting row older than STALE_IN_FLIGHT_MS and for any unknown row, run reconcileAgainstLive (export it from replyGuard.ts and let the store return unknown rows too) using the live review already read at worker.ts:685; hide the button only for a posting row younger than two minutes. If reconciliation cannot run (Google unreachable), keep the sentence but add a 'Check Google now' action that calls it.

## correctness-4 [medium] paperclip-extensions:plugins/gbp-reviews/src/replyGuard.ts:225
**Same-key retry against a stale 'posting' row is refused forever; the two-minute reconcile only runs for a different key**

Claim: Step 6 refuses [EDUPLICATE_IN_PROGRESS] whenever the caller's own row is 'posting', with no age check, before the live read. The stale reconcile in step 7 is explicitly limited to rows whose idempotencyKey differs from the caller's (line 235). The confirm panel deliberately reuses its key on retry (editorState.ts:212-216), so the retry the design relies on is exactly the one that can never reconcile a crashed attempt.

Scenario: beginPost succeeds, the worker is killed before the PUT, usePluginAction rejects with WORKER_UNAVAILABLE, the panel stays open in the failed stage with the same key. Every later click, including ten minutes later, answers 'This reply is already being posted. Wait a moment and check the review.' without reading Google; the row never leaves 'posting'.

Fix: When own.status === 'posting' and now() minus own.createdAt exceeds STALE_IN_FLIGHT_MS, do not refuse; treat the own row like staleInFlight (read the live review, reconcileAgainstLive, then re-read the row: posted returns the stored receipt, failed continues to a fresh attempt). Add a guard test for a stale same-key row.

## correctness-5 [medium] paperclip-extensions:plugins/gbp-reviews/src/replyGuard.ts:331
**A database failure after a successful PUT reports the public post as failed and leaves the row stuck in 'posting'**

Claim: finishPost(key, 'posted', ...) at line 331 is not wrapped, unlike the upsert at 334-347. If it throws, the error propagates out of the guard after the reply is already live on Google: the page shows a failure box, the audit row stays 'posting', the local reviews row is never updated, and the same-key retry is refused by step 6 (correctness-4) while a reload hides the button (correctness-3). The spec invariant says the receipt must never report a public post as failed because of anything after the PUT.

Scenario: Google accepts the reply (200), the plugin database connection drops for a second, finishPost throws 'connection terminated'. The person sees an error under 'Yes, post it', clicks again and is told the reply is already being posted; the review still shows 'Not replied yet' although the reply is public.

Fix: Wrap the finishPost call in try/catch: log at error level, set recordedLocally = false, still attempt the upsert, and return the receipt with postedAt = result.updateTime. Pin with a guard test where finishPost throws once after a successful PUT and the call still returns a receipt.

## correctness-6 [medium] paperclip:server/src/services/start-work.ts:440
**Unknown parentClientKey or a cycle skips the repair round and surfaces internal wording as the 422**

Claim: draftWithModel's repair loop (lines 344-354) only feeds zod issues back to the model; parent existence and cycles are checked later by buildTaskCreationOrder in normalisePlan (line 440), whose unprocessable errors ('Unknown parentClientKey: t9', 'Suggested tasks contain a parentClientKey cycle') propagate as the 422 body. The model never gets the one repair chance the prompt's rule 7 anticipates, and StarterCatalogDialog.tsx:364 renders that message verbatim instead of the contracted 'Could not turn that into a plan ...' sentence. start-work-service.test.ts:554 and :562 pin the current messages.

Scenario: The model returns three tasks and gives t3 parentClientKey 't9' (a typo). Result: 422 'Unknown parentClientKey: t9' shown to the operator, one AI call wasted, no repair attempt, although rule 7 in the system prompt is exactly the instruction a repair round would quote back.

Fix: Move the parent-exists and no-cycle checks into the validation that drives the repair loop (a superRefine on startWorkPlannerOutputSchema, or a post-parse check whose message is fed to the second attempt), and map any HttpError still raised by buildTaskCreationOrder in normalisePlan to UNUSABLE_PLAN_MESSAGE. Update the two pinned test expectations.

## data-integrity-repointed-location-orphans-rows [medium] paperclip-extensions:plugins/gbp-reviews/src/worker.ts:160
**Changing a location's target company makes its stored reviews vanish from every screen, and Sync now cannot bring them back**

Claim: Every read now requires company_id = location.targetCompanyId (reviewQueries.ts:133, 153, 179, 198; the summary at worker.ts review-summary too). But the sync finds an existing row by review_name alone (worker.ts:144-145) and its UPDATE at worker.ts:160 rewrites only reply_text, reply_time, reply_source and updated_at, never location_key or company_id; upsertReview's ON CONFLICT (replyStore.ts:238-242) does the same. So rows written under the old company_id are never re-filed and stay invisible to the new company, to HQ (which also reads with location.targetCompanyId), and to the old company (scopeLocationsForCompany no longer shows it the location).

Scenario: Location main-st is configured with targetCompanyId A (a typo, or a real move); 50 reviews are synced with company_id A. The operator corrects it to B. review-list for B: 0 reviews; opening a review by name: [EREVIEW_NOT_FOUND] 'Press Sync now'; Sync now: every review is `existing`, the UPDATE leaves company_id A, still 0 reviews, dashboard shows 0 unreplied and no average. No error anywhere; the data looks gone. Before this change the summary filtered on location_key only and kept working.

Fix: In the sync's existing-row UPDATE (worker.ts:160) also set location_key = location.key and company_id = location.targetCompanyId, and add the same two columns to the DO UPDATE SET in replyStore.ts:238-242, so one Sync now re-files the rows under the location's current company. Add a reviewQueries/worker test: a row stored under company A for a location now pointing at B is visible to B after one sync.

## data-integrity-unknown-row-never-settled [medium] paperclip-extensions:plugins/gbp-reviews/src/replyGuard.ts:233
**An 'unknown' row whose key was lost hides the Post button for good and is never reconciled**

Claim: An 'unknown' row (written at replyGuard.ts:322 after a dropped connection, or at replyGuard.ts:181-185 by the stale reconcile when Google holds a different reply) is only ever settled by a retry carrying the SAME key (replyGuard.ts:257-262). findInFlight (replyStore.ts:167-173) selects status = 'posting' only, so another key never reconciles it; findPendingAttempt (reviewQueries.ts:227) counts 'unknown' rows of any age and keeps winning even after a newer 'posted' row exists, because it orders only 'posting'/'unknown' rows; canShowPostButton (editorState.ts:88) then never shows the button. The key lives only in React state (editorState.ts:147, 216); localStorage keeps the draft text only (editorState.ts:277-301), so closing the tab loses it.

Scenario: Connection drops after the PUT is sent: row K becomes 'unknown', the panel shows [EPOST_UNCONFIRMED]. The person closes the tab. Reopening the review: pendingAttempt = K, no Post button, for ever. Google actually has the reply, the local reviews row still says 'Not replied yet' until 06:00 (then it is labelled 'google', see the reply-source finding), and reply_posts keeps a permanent 'unknown' row. Second path: an agent attempt reconciles a stale 'posting' row as 'unknown' at line 181-185 and then posts its own reply; the review is locked on the page from that moment.

Fix: Treat 'unknown' like a stale 'posting' row: have findInFlight (or a second store method) return the newest row with status IN ('posting','unknown') and, when it belongs to another key and is older than STALE_IN_FLIGHT_MS, reconcile it against the live review in step (7) (equal text: posted; no reply: failed; different reply: failed with the note, not 'unknown', so it stops being pending). In findPendingAttempt, ignore an 'unknown' row once a newer row for the same review is 'posted', and ignore ones older than the stale window. Pin both with replyGuard tests.

## regressions-ai-rewrite-env-model-now-beats-native [medium] paperclip:server/src/services/chat-providers.ts:1572
**ai-rewrite now lets PAPERCLIP_CHAT_DEFAULT_MODEL override a configured native provider, which the old route deliberately did not**

Claim: pickOneShotModel (server/src/services/chat-providers.ts:1569-1582) checks PAPERCLIP_CHAT_DEFAULT_MODEL first (:1572-1573) and only then walks the native providers (:1575-1579). The code it replaced in server/src/routes/agents.ts (HEAD lines 2301-2317) picked a configured native provider FIRST and reached PAPERCLIP_CHAT_DEFAULT_MODEL only inside pickBestDefaultModel, i.e. only when no native provider was configured; its comment says native is preferred because an SDK call returns in hundreds of milliseconds while an adapter CLI cold-starts in seconds. The route now calls the new function at server/src/routes/agents.ts:2302, and the spec (work item 4) asserts the switch has identical behaviour, which it does not when both the env var and a native key are set. The new test at server/src/__tests__/chat-providers.test.ts:247-254 pins the new precedence, so the tests do not catch it.

Scenario: ANTHROPIC_API_KEY is set and PAPERCLIP_CHAT_DEFAULT_MODEL names an adapter model such as claude_local/... (the usual way to make Clippy sessions use the Claude Pro CLI). An operator presses the inline instructions rewrite. Before: the request went to the native Anthropic SDK and returned in under a second. After: pickOneShotModel returns the adapter model, the route spawns the CLI, and the same rewrite takes tens of seconds. The Start work planner inherits the same choice.

Fix: In pickOneShotModel, move the native-provider loop (chat-providers.ts:1575-1579) above the explicit PAPERCLIP_CHAT_DEFAULT_MODEL check (:1572-1573), so the order is native, then explicit, then discovered, exactly what the old route did. Adjust the test at chat-providers.test.ts:247-254 so the env var is honoured when no native provider is configured, and add a case with both set that expects the native model.

## security-1 [medium] paperclip-extensions:plugins/gbp-reviews/src/replyGuard.ts:252
**In-flight slot is claimed after the live read, so two attempts can both see no reply and the second overwrites the first without a confirm**

Claim: postReplyGuarded reads Google (line 252) and applies the overwrite rules (266-285) before it claims the per-review slot with store.beginPost (line 302). The partial unique index idx_reply_posts_one_in_flight only holds while a row is status 'posting', so once the first attempt has run finishPost('posted') (line 331) a second attempt that did its live read earlier passes beginPost and PUTs with replaceExisting=false, replacing the first reply and recording previous_reply_text = null. The spec's invariant (one PUT per review across tabs, workers and a human-versus-agent race) does not hold in that window; the window is small (the second caller must stall between its getReview return and its beginPost while the first caller's PUT and finishPost complete) but it is the exact case the guard exists for.

Scenario: Human in company A presses Yes, post it (key K1, expectedReplyUpdateTime null) at the same moment an approved gate call for gbp_reply_to_review (key run:R:id) executes for the same review. Both reach line 252 and see reviewReply undefined. K1 inserts its 'posting' row, PUTs, and finishes 'posted'. The agent call now runs beginPost: no 'posting' row exists, the insert succeeds, and postReply at line 310 silently replaces the human's public reply. No EREPLY_EXISTS, no replace tick, and the agent's audit row says there was no previous reply.

Fix: Claim before you look: move store.beginPost (with previousReplyText/previousReplyTime null) to before getOAuthClient/getReview, then after the live read passes the overwrite rules write the two previous_* columns (a small store.update, or pass them to finishPost). On every refusal after the claim call finishPost(key, 'failed', message) before rethrowing so the slot is released. With the slot held from before the read to after the write, the partial unique index serialises read, check and PUT per review.

## security-2 [medium] paperclip:server/src/services/issue-thread-interactions.ts:996
**Start-work hand-over and cancel hooks fire for any suggest_tasks card on the container, not only the plan card, so a later agent card can cancel or re-hand the whole request**

Claim: getStartWorkContainer at lines 996-997 (accept) and 1111-1112 (reject) keys only on issues.originKind === 'start_work'. It does not check that the card being decided is the plan card (idempotencyKey start-work:<requestKey>, created by a user). After the plan is accepted the container is todo and assigned to the lead, who is woken and can create further suggest_tasks cards on it through POST /issues/:id/interactions (server/src/routes/issues.ts:3267, which accepts agent callers). Accepting such a card re-runs the hand-over (status forced back to 'todo', assignee replaced by the current pickAssigneeForCompany result, a second '## Accepted plan' section appended, and issueService.update clears executionRunId/checkoutRunId because the status or assignee changed); rejecting it sets the whole container to 'cancelled' while its child tasks stay live.

Scenario: Operator accepts a plan; the CEO agent is woken on the umbrella, starts it (in_progress) and proposes two follow-up subtasks with a suggest_tasks card. The operator declines those two with Reject. rejectSuggestedTasks reaches line 1112, sees originKind start_work, and cancels the umbrella (cancelledAt set) although the accepted children are still todo/in_progress. If the operator had clicked Accept instead, line 1003 moves the umbrella from in_progress back to todo, reassigns it, and clears the running agent's execution lock.

Fix: Select originId in getStartWorkContainer and run both hooks only when current.idempotencyKey === startWorkInteractionIdempotencyKey(container.originId) (or, equivalently, when current.createdByUserId is set and current.createdByAgentId is null and container.status === 'backlog'); otherwise fall through to touchIssue as for an ordinary issue. Add a service test: a second agent-created suggest_tasks card on an accepted start_work container leaves the container untouched on accept and on reject.

## tests-001 [medium] paperclip-extensions:plugins/gbp-reviews/src/replyGuard.test.ts:521
**Stale in-flight rule reads created_at, which a same-key retry never refreshes; no test covers a restarted row**

Claim: replyGuard.ts:236 measures a rival attempt's age from inFlight.createdAt, but replyStore.ts:187-194 restarts a 'failed' or 'unknown' row in place (ON CONFLICT (idempotency_key) DO UPDATE sets status and updated_at only), so a retried attempt keeps its first attempt's created_at. The stale-row test at replyGuard.test.ts:521-542 seeds createdAt on a brand-new row and never restarts one, so it cannot see this. The MemoryStore already mirrors the real store (line 91 keeps existing.createdAt), so the existing harness can reproduce the hole.

Scenario: key-1 fails at 10:00 (Google 503, row 'failed'). At 10:03 the person retries from the same confirm panel (same key): beginPost restarts the row to 'posting' with created_at still 10:00 and the PUT is in flight. A second tab or an approved agent call (key-2) runs findInFlight, sees key-1 aged 3 minutes, treats it as abandoned, reconciles it as 'failed' (live reply still null), inserts its own 'posting' row and sends a second PUT. Key-1's PUT then lands and its row is marked 'posted'. Two public writes for one review, both audited as posted, the second silently replacing the first, which breaks the one-in-flight-per-review invariant the tests claim to prove.

Fix: In replyGuard.ts:236 measure staleness from inFlight.updatedAt (the restart bumps it at replyStore.ts:193), and add a test: seed a 'failed' row created 3 minutes ago, restart it with the same key while postReply is held open on a pending promise, then post with key-2 and assert [EDUPLICATE_IN_PROGRESS] and exactly one PUT in total.

## tests-002 [medium] paperclip-extensions:plugins/gbp-reviews/src/reviewQueries.test.ts:235
**No test follows an unconfirmed post through a reload; the review stays un-postable once the panel's key is gone**

Claim: findPendingAttempt (reviewQueries.ts:226-228) reports 'unknown' rows as pending with no age limit, canShowPostButton (editorState.ts:82-90) hides the Post button while one exists (pinned at editorState.test.ts:94 with status 'unknown'), and the guard settles an 'unknown' row only under its own key (replyGuard.ts:225-230 and 257-262); findInFlight at 233-243 looks at 'posting' rows only. The idempotency key lives in React state alone (ReviewEditor.tsx:84-88; initialEditorState sets it null at editorState.ts:171), so closing the editor or reloading loses it. No test in editorState.test.ts, replyGuard.test.ts or worker.handlers.test.ts covers what happens after [EPOST_UNCONFIRMED] once that key is gone.

Scenario: The connection drops after a PUT that Google never received (row 'unknown'). The person closes the editor or reloads. review-detail now returns pendingAttempt {status:'unknown'}, the page shows only 'A post was attempted at ... and did not finish', and nothing ever clears the row: a new key is stopped by the page before it reaches the guard, and the old key no longer exists anywhere. That review can never be answered from Paperclip again without editing the database.

Fix: Reconcile 'unknown' rows against the live review whatever key they carry (extend step 7 in replyGuard.ts to include status 'unknown', and let review-detail run the same reconcile once Google has been read), then add the test: force EPOST_UNCONFIRMED, start a fresh editor state, assert review-detail reports pendingAttempt null after the live read and that a new key posts exactly once.

## tests-003 [medium] paperclip-extensions:plugins/gbp-reviews/src/replyGuard.test.ts:207
**The account allow-list is never exercised on the post path or the detail read**

Claim: The guard's getOAuthClient stub (replyGuard.test.ts:207-210) always returns a client, and worker.handlers.test.ts:56 gives the account allowedCompanies [COMPANY_A, COMPANY_B], so no test anywhere makes the fail-closed check in gbpAuth.ts:58-63 fire during a post or a review-detail read. The only evidence is that the stub was called with (accountKey, targetCompanyId) at replyGuard.test.ts:388, which says nothing about what the guard does when it refuses. review-detail's posting.accountAllowed=false branch (worker.ts:709) is also unreached.

Scenario: A location's account lists only company B while the location's targetCompanyId is A. A post from A must be refused with [ECOMPANY_NOT_ALLOWED] before beginPost and before any Google call, and review-detail must answer posting.accountAllowed=false so no Post button renders. If step 8 in replyGuard.ts were moved below the audit insert at step 11, every refused post would leave a 'posting' row behind and the whole suite would stay green.

Fix: Add a guard test whose getOAuthClient throws Error('[ECOMPANY_NOT_ALLOWED] ...') and assert no beginPost, no getReview, no PUT and the error rethrown; add a worker.handlers.test with allowedCompanies [COMPANY_B] for MAIN_ST asserting review-detail returns posting.accountAllowed false and review-post-reply makes no PUT and no reply_posts INSERT.

## tests-004 [medium] paperclip:server/src/__tests__/start-work-service.test.ts:304
**No test proves drafting a plan writes no wake request**

Claim: The hard constraint is that nothing is created or woken until a board user accepts. After plan() the service tests count issues and issue_thread_interactions rows (lines 233, 257, 300-301, 315) but never read agent_wakeup_requests or heartbeat_runs; neither table is imported (lines 4-14). The reject test in issue-thread-interactions-service.test.ts does assert zero wake rows, so the pattern exists, but the plan path itself is unpinned; today issueThreadInteractionService.create writes no wake (issue-thread-interactions.ts only reads heartbeat_runs at 771-774), so the assertion would pass and hold the line.

Scenario: A later change makes issueThreadInteractionService.create or issueService.create queue an assignment or continuation wake for a wake_assignee_on_accept card (the create route already wakes for other kinds). A drafted plan would then wake the lead before anyone accepted, and every start-work-service test would still pass.

Fix: In the 'creates the container' test, and in the concurrent and repeated-key tests, assert after plan() that db.select().from(agentWakeupRequests) and db.select().from(heartbeatRuns) are both empty.

## tests-005 [medium] paperclip:server/src/__tests__/plugin-routes-authz.test.ts:758
**A failing host audit write after a successful action is untested**

Claim: logPluginBridgeAction (server/src/routes/plugins.ts:737-768) swallows a logActivity failure precisely so a public post that already happened is not answered with a 502, and it runs before res.json at plugins.ts:2023 and 2184. The activity tests at 758 and 809 cover only logActivity resolving or the worker rejecting; mockLogActivity is never made to reject, so the try/catch at 751-767 is unproven and its log.error line never observed.

Scenario: Remove the try/catch, or let logActivity throw on a database hiccup: the worker has already made the Google PUT, the route answers 502, the page shows a failure box, the person posts again and is refused with [EREPLY_EXISTS]. Every test in the file still passes.

Fix: Add a test with mockLogActivity.mockRejectedValueOnce(new Error('db down')) on POST /api/plugins/:id/actions/review-post-reply asserting status 200 with the worker's result in the body, and that the failure was logged rather than surfaced.

## ux-honesty-02 [medium] paperclip-extensions:plugins/gbp-reviews/src/ui/replyErrors.ts:29
**The EPOST_UNCONFIRMED sentence sends the person down the one path that cannot recover**

Claim: The mapper replaces the guard's own sentence 'Try again; the retry checks Google first and will not post twice' (replyGuard.ts:326) with 'Open the review again; it checks Google first and will not post twice.' Only a retry from the still-open confirm panel carries the same idempotency key (editorState.ts:212-216 keeps it, :244-245 keeps the panel in the failed stage with Yes, post it enabled) and reaches the reconcile at replyGuard.ts:257-262. Reopening the review remounts the editor with a fresh key (index.tsx:229, key={reviewName}) and lands on the pendingAttempt dead end in ux-honesty-01.

Scenario: The connection drops after the PUT. The panel shows the sentence. The operator does what it says: Close, reopen the review. No Post button, and the reply may or may not be on Google.

Fix: Change the sentence to: 'The connection dropped while posting, so it is not known whether the reply reached Google. Press Yes, post it again: it checks Google first and will not post twice.' The panel already stays open with the same key.

## ux-honesty-03 [medium] paperclip-extensions:plugins/gbp-reviews/src/ui/replyErrors.ts:16
**A viewer is told their role can read reviews on the very screen that refuses to show any**

Claim: Every bridge data read is a POST checked with assertCompanyAccess in its default write mode (server/src/routes/plugins.ts:683, server/src/routes/authz.ts:60 and :126-134), so a viewer gets 403 'Viewer access is read-only' on review-summary and review-list and sees no location and no review. The mapper turns that into 'Your role in this company can read reviews but not post replies.' (rendered at ReviewList.tsx:76 and index.tsx:170), which claims a capability the page has just refused, under the heading 'Open a location to read and reply to its reviews.' (index.tsx:165).

Scenario: A viewer-role member opens GBP Reviews: the intro says open a location to read its reviews; the box below says their role can read reviews; no location card and no review is shown anywhere.

Fix: Say what happened: 'Your role in this company is view-only, and this page needs a role that can create work. Ask an admin to change your role to see or reply to reviews.' Keep a separate sentence for a refused post only if the host ever allows viewer reads.

## ux-honesty-04 [medium] paperclip:ui/src/components/StarterCatalogDialog.tsx:85
**A member who can create work is told they cannot, while the access check is loading or after it fails**

Claim: canWriteCompany returns false when boardAccess is undefined (ui/src/lib/company-access.ts:19). The access query at :79-84 is retry: false and neither isLoading nor isError is read, so on first open (before the call returns) and permanently if it fails, the dialog hides Draft a plan and Turn this on, ignores Enter silently (:143), and shows 'You can browse this company, but only members who can create work can start it.' (:340). No loading or error state exists between 'checking' and 'denied'.

Scenario: An owner opens What do you want done? on a slow connection, or the access call returns 500 once: the panel says they cannot start work here, no button appears, and nothing explains why.

Fix: Read isLoading and isError from that useQuery. While loading render the buttons disabled with 'Checking your access...'; on error render an error box 'Could not check your access. Close and try again.'; show the browse-only sentence only when boardAccess is present and canWriteCompany is false.

## ux-honesty-05 [medium] paperclip:ui/src/components/StarterCatalogDialog.tsx:228
**The accept receipt says the lead 'has been woken' when the wake may have been refused**

Claim: The receipt line 'Handed to <name>, who has been woken' asserts an outcome the server never reports. The accept route queues the wake fire-and-forget (server/src/routes/issues.ts, queueResolvedInteractionContinuationWakeup: void heartbeat.wakeup(...).catch(warn)), and enqueueWakeup throws and writes a skipped request when the agent is budget-blocked (server/src/services/heartbeat.ts:6713-6721), paused or pending approval (:6724-6730), or has wake-on-demand off (:6738-6741). The dialog reads only container.assigneeAgentId (:215-217). The same screen may have shown '<name> is paused by budget. Its task will be created but will not start until the budget is raised.' (:513) moments earlier.

Scenario: The lead is over budget. The header warns. The operator accepts. The receipt says 'Handed to Ops Lead, who has been woken.' Nothing runs, and the receipt gave him no reason to look.

Fix: Say what the server can vouch for: 'Handed to <name>.' plus, when plan.warnings names that agent, '<name> is paused by budget, so it will not start until the budget is raised.'; otherwise 'It will pick this up on its next run.' Or read the wake outcome back (the wake request row) before writing the line.

## correctness-7 [low] paperclip-extensions:plugins/gbp-reviews/src/worker.ts:524
**An agent that corrects its reply after a failed attempt is locked out for the rest of the run**

Claim: The agent idempotency key is run plus review (worker.ts:524). replyGuard.ts:221 refuses any same-key attempt whose text differs, whatever the row's status, with 'This attempt was already started with different text. Start a new one.' An agent cannot mint a new key inside a run, and beginPost's ON CONFLICT clause (replyStore.ts:187-194) never updates reply_text, so allowing the text through would also leave a wrong audit row.

Scenario: Run R posts text A, Google answers 400 (row 'failed'). The agent shortens the text to B and calls the tool again in the same run. Result: [EINVALID_INPUT] refusal, and every further attempt in that run is refused the same way; the review stays unreplied until a new run.

Fix: When own.status === 'failed' (never 'unknown', where the old text may already be live), accept a different text and have beginPost's ON CONFLICT ... WHERE status = 'failed' also set reply_text = EXCLUDED.reply_text; keep the refusal for 'posting', 'posted' and 'unknown' rows.

## correctness-8 [low] paperclip:server/src/services/chat-providers.ts:1573
**pickOneShotModel puts PAPERCLIP_CHAT_DEFAULT_MODEL ahead of native providers, changing which model the ai-rewrite route uses**

Claim: The removed cascade in routes/agents.ts consulted the env override only inside pickBestDefaultModel, after the native anthropic/openai/gemini check, so a native key always won for the inline rewrite. pickOneShotModel checks the env override first (lines 1570-1573). The spec lists the new order but also states agents.ts switches 'with identical behaviour'; the two cannot both hold, and chat-providers.test.ts pins the new order. Not a defect against the written cascade, but a real behaviour change on an existing route that the spec claims is unchanged.

Scenario: Instance has ANTHROPIC_API_KEY and PAPERCLIP_CHAT_DEFAULT_MODEL=adapter:claude_local:claude-opus-4-7 (a Claude Pro user's Clippy default). Before: ai-rewrite ran on the native Anthropic SDK in hundreds of milliseconds. After: it spawns the claude_local CLI per rewrite, taking seconds, and the start-work planner inherits the same choice.

Fix: Either keep the old order for one-shots (native providers first, env override only in the discovered-model pass) or leave the code as is and correct the spec's 'identical behaviour' claim so the change is a deliberate decision the operator has seen.

## data-integrity-idempotency-key-not-bound-to-review [low] paperclip-extensions:plugins/gbp-reviews/src/replyGuard.ts:219
**A reused idempotency key returns another review's receipt and restarts another review's audit row**

Claim: findPost (replyStore.ts:159-165) looks up by idempotency_key with no review_name or company_id filter, and step (6) (replyGuard.ts:219-230) compares only the text. A 'posted' row is returned as a receipt built from the CURRENT input's location and review name (replyGuard.ts:224, storedReceipt), and a 'failed'/'unknown' row is restarted by beginPost's DO UPDATE (replyStore.ts:187-194), which never rewrites review_name, location_key, company_id or the actor columns, so the audit row keeps naming the first review while the PUT goes to the second.

Scenario: Key K was used for review X in company A with text T and is 'failed'. The same board user (or a member of HQ with access to both companies) sends key K, text T, for review Y. Step (6) passes (same text, status failed), the live checks run against Y, beginPost restarts X's row, the PUT goes to Y, finishPost marks X's row 'posted' with Y's Google time. reply_posts now says X was replied to; Y has no audit row. With a 'posted' K the caller gets a receipt saying Y was posted although only X ever was.

Fix: After findPost, refuse with [EINVALID_INPUT] when own.reviewName !== reviewName or own.companyId !== companyId (one sentence, e.g. 'This attempt belongs to a different review. Start a new one.'), or add review_name to the findPost WHERE clause. Pin with a replyGuard test.

## data-integrity-last-synced-is-last-write [low] paperclip-extensions:plugins/gbp-reviews/src/reviewQueries.ts:178
**'Last synced' shows the time of the last human post, and never shows anything for a location with no reviews**

Claim: lastSyncedAtForLocation reads MAX(updated_at) from the reviews table (reviewQueries.ts:177-181). updated_at is also bumped by upsertReview after a human or agent post (replyStore.ts:242, updated_at = now()), and the sync bumps it only on rows it touches (worker.ts:160), so a location whose Google listing has zero reviews has no row and reports null after every Sync now.

Scenario: Sync at 06:00; a person posts a reply at 14:00; the location card says 'Last synced 14:00' although nothing was pulled from Google since 06:00. A brand-new listing with no reviews: press Sync now, it returns lastSyncedAt null, the card keeps saying it was never synced.

Fix: Record the sync time per location in ctx.state (for example stateKey `last-sync:<locationKey>`, scopeKind instance) at the end of syncLocationReviews and read that in review-list and review-sync-location instead of MAX(updated_at).

## data-integrity-reply-source-flips-to-google [low] paperclip-extensions:plugins/gbp-reviews/src/worker.ts:153
**A Paperclip-posted reply is relabelled 'in Google' by the next sync whenever the local row missed it**

Claim: nextReplySource (worker.ts:153-158) decides 'google' purely by comparing the stored reply_text with the live text; it never consults reply_posts. Two paths leave the stored text different from the live one even though Paperclip posted the reply: (a) recordedLocally=false at replyGuard.ts:334-347, where the reviews row keeps its old text while reply_posts has a 'posted' row for the new one; (b) replyGuard.ts:336 stores replyText (what was sent) rather than result.comment (what Google echoed back, gbpClient.ts:73-82), so any server-side normalisation of the text makes the comparison fail.

Scenario: A person posts from the Reviews page; the upsert fails (recordedLocally false, receipt says the dashboard will catch up). At 06:00 the sync sees live text T versus stored NULL, writes reply_source 'google'. The list then says 'Replied in Google' for a reply reply_posts records as source 'human' with the person's user id. The audit table and the list disagree from then on.

Fix: In the sync's existing-row branch, before defaulting to 'google', look up reply_posts for a 'posted' row on this review_name whose reply_text equals the live text and use its source (one extra SELECT per changed row only). In replyGuard.ts:336 store result.comment ?? replyText and compare reconcile text the same way. Pin with a worker handlers test that a synced reply matching a 'posted' human row keeps 'human'.

## data-integrity-restarted-row-keeps-created-at [low] paperclip-extensions:plugins/gbp-reviews/src/replyStore.ts:187
**A retried attempt keeps its original created_at, so a concurrent caller can treat it as abandoned and post over it**

Claim: beginPost's ON CONFLICT DO UPDATE (replyStore.ts:187-194) resets status, error and updated_at but not created_at, while the stale check in replyGuard.ts:236 measures age from createdAt. A retry of a key that first failed more than two minutes ago therefore produces a 'posting' row that is already 'stale' the moment it is written.

Scenario: A person's key K failed ten minutes ago. They press retry: K is restarted to 'posting' with a ten-minute-old created_at and the PUT is in flight. An agent run on the same review one second later: findInFlight returns K, age > 2 minutes, the live read (before the person's PUT lands) shows no reply, reconcileAgainstLive marks K 'failed' ('No reply reached Google'), the agent inserts its own row and PUTs. Two public writes; if the agent's lands second it has replaced the person's reply, which the hard constraint says an agent may never do, and K is then marked 'posted' by the person's own finishPost although Google shows the agent's text.

Fix: Add `created_at = now()` to the DO UPDATE SET in beginPost (or measure the stale window from updated_at in replyGuard.ts:236 and expose updatedAt for that purpose). Pin with a replyGuard test that a row restarted just now is not treated as stale by a different key.

## data-integrity-sync-insert-missing-reply-source [low] paperclip-extensions:plugins/gbp-reviews/src/worker.ts:184
**A reply first seen at sync is stored with no source, so the list says 'Replied' instead of 'Replied in Google'**

Claim: The spec and replySource.ts (header comment, and the test 'first-seen reply becomes google') say a reply the sync sees for the first time is recorded as 'google'. nextReplySource is only called on the existing-row branch (worker.ts:153-158). The INSERT for a new row at worker.ts:184-197 has no reply_source column, so a review that already carries a Google-console reply when first synced gets reply_source NULL and replyStatusLabel (editorState.ts:123-135) shows plain 'Replied'.

Scenario: Sync now runs on a location whose newest review was answered in Google's console yesterday. The row is inserted with reply_text set and reply_source NULL. The list shows 'Replied' with no source, while the same reply edited tomorrow would flip to 'Replied in Google'. Two rows with the same history show two different labels.

Fix: Add reply_source to the INSERT at worker.ts:184 with the value nextReplySource({ replyText: null, replySource: null }, { replyText: review.reviewReply?.comment ?? null }) (that is 'google' when a reply exists, else NULL), and extend the worker handlers test for review-sync-location to assert it.

## regressions-readme-em-dash [low] paperclip-extensions:plugins/gbp-reviews/README.md:146
**A README line rewritten by this change keeps an em dash**

Claim: plugins/gbp-reviews/README.md:146 is a line this change rewrote (git diff hunk @@ -95 +146,3 @@) and it reads '- `ReviewDashboardPage` — full page at route `gbp-reviews`. ...' with a U+2014 em dash. The README is persisted, checked-in text and the spec's own copy rule (no U+2014 or U+2013 in anything this build writes) applies to it; the adjacent untouched line 145 has the same dash, but 146 is the one this diff produced. The scan of every added line in both repos found no other em or en dash outside test regexes and test inputs.

Scenario: Anyone reading the plugin README, or the release notes it feeds, sees an em dash in text the 0.1.10 change wrote, contrary to the house rule; the extension's own pinning tests only cover worker strings and UI sentences, not the README.

Fix: Replace ' — ' with ': ' on plugins/gbp-reviews/README.md:146 (and, while there, the identical pattern on line 145).

## regressions-stale-company-rows-hidden-and-never-repaired [low] paperclip-extensions:plugins/gbp-reviews/src/worker.ts:160
**Rows synced under a location's previous company disappear from the summary, list, detail and digest, and the sync never corrects company_id**

Claim: Every read now adds AND company_id = location.targetCompanyId: the dashboard summary (plugins/gbp-reviews/src/reviewQueries.ts:192-201, called from worker.ts summary handler), the list (:127-140), the detail (:146-158), the last-synced time (:173-183) and the weekly digest (plugins/gbp-reviews/src/worker.ts:386-387). Before this change the summary and the digest read by location_key alone. company_id is written once at insert (worker.ts:184-189) and the existing-row branch of the sync updates only reply_text, reply_time, reply_source and updated_at (worker.ts:160-161); replyStore.upsertReview's ON CONFLICT branch does the same (plugins/gbp-reviews/src/replyStore.ts:238-243). So a row whose company_id no longer equals the location's current targetCompanyId is invisible to every read and no code path ever fixes it.

Scenario: An operator moves a location to another company by editing targetCompanyId in the plugin settings (or first sets it after reviews were already synced). The next dashboard load shows that location with 0 reviews and 0 unreplied, the weekly digest omits its reviews, and opening one of them from the list is impossible; review-detail answers EREVIEW_NOT_FOUND, whose sentence tells the person to press Sync now, which runs the existing-row branch and leaves company_id as it was. Before the change the summary and digest still counted those rows.

Fix: In the sync's existing-row UPDATE (worker.ts:160-161) also set location_key = $n and company_id = location.targetCompanyId, and add the same two columns to the DO UPDATE SET list in replyStore.upsertReview (replyStore.ts:238-243), so one sync (or Sync now) heals a moved location's rows. Add a test in reviewQueries.test.ts or worker.handlers.test.ts that syncs a row under company A, moves the location to B, syncs again and expects the summary to count it.

## security-3 [low] paperclip-extensions:plugins/gbp-reviews/src/replyGuard.ts:219
**Idempotency key is not bound to the review or company, so a reused key returns another review's receipt or restarts another review's audit row**

Claim: Step (6) at lines 219-230 compares only own.replyText to the new text. It never checks own.reviewName === reviewName or own.companyId === companyId. A 'posted' row is returned as the receipt for whatever review the caller named; a 'failed'/'unknown' row is restarted by beginPost, whose ON CONFLICT DO UPDATE (replyStore.ts:187-194) rewrites only status/previous_*/error and leaves review_name, location_key, company_id, source and actor_* from the original attempt, so the partial unique index then guards the wrong review and the audit row describes a post that did not happen.

Scenario: Key K was used for review R1 and finished 'failed'. A caller (same company, or another company that learned K, e.g. an agent key run:<runId>:<reviewId> is predictable from visible run ids) posts to R2 with key K and the same text. The guard passes steps 1-5 for R2, beginPost updates R1's row to 'posting', the PUT goes to R2, finishPost marks R1's row 'posted'. reply_posts now says R1 was replied to by the original actor; a later retry of K for R1 is answered with a 'posted' receipt although R1 has no reply.

Fix: In step (6) refuse with EINVALID_INPUT ('This attempt key belongs to a different review.') when own.reviewName !== reviewName || own.companyId !== companyId, and add the same two predicates to the WHERE clause of the ON CONFLICT DO UPDATE in replyStore.beginPost so the database refuses the restart as well.

## security-4 [low] paperclip:server/src/services/start-work.ts:257
**Usable roster admits pending_approval agents that assertAssignableAgent refuses, so a plan can be undecidable and the dialog then claims someone else decided it**

Claim: usableRoster (start-work.ts:257) and pickAssigneeForCompany (starter-catalog.ts:141) exclude only paused and terminated agents, but issueService.assertAssignableAgent (server/src/services/issues.ts:1548) throws conflict (409) for status pending_approval. A task assigned to such an agent, or a container whose CEO pick is pending approval, makes acceptSuggestedTasks fail after the claim and child creation (rolled back, fail-closed), and StarterCatalogDialog.handleDecisionError (ui/src/components/StarterCatalogDialog.tsx:185-188) maps every 409 to 'Someone already decided this plan', which is false. The spec invariant that assertAssignableAgent never fires at accept time does not hold.

Scenario: A company whose CEO is still pending_approval drafts a plan; the model assigns tasks to that CEO (it is in the roster sent in the prompt). Accept: createChild throws 'Cannot assign work to pending approval agents' (409); the transaction rolls back; the dialog shows 'Someone already decided this plan' and refetches a card that is still pending. The operator cannot tell why and cannot accept until the agent is approved.

Fix: Exclude 'pending_approval' in both filters (start-work.ts:257 and starter-catalog.ts:141), ideally by sharing one predicate with assertAssignableAgent, and in handleDecisionError only treat a 409 as 'already decided' when the message is 'Interaction has already been resolved'; show the server message otherwise.

## security-5 [low] paperclip-extensions:plugins/gbp-reviews/src/worker.ts:538
**Agent tool discards the host-populated runCtx.userId, so a person driving the tool through the tools/execute route is audited as the agent**

Claim: gbp_reply_to_review passes scope { companyId: runCtx.companyId, userId: null } at worker.ts:538. The host stamps runContext.userId for board callers of POST /plugins/tools/execute (server/src/routes/plugins.ts:1063-1066), which any member with company access may call with any agent/run pair of that company. The reply_posts row then has source 'agent', actor_agent_id set and actor_user_id null, and the host activity row for that route does not carry the review either, so the person who actually posted is not recorded anywhere.

Scenario: A member of company A calls POST /api/plugins/tools/execute with tool gbp-reviews:gbp_reply_to_review, runContext { agentId: <any A agent>, runId: <one of its runs>, companyId: A }. The post goes out (subject to the draft gate and allowReplies) and reply_posts attributes it solely to the agent and run; the member's user id is dropped at line 538.

Fix: Pass userId: runCtx.userId ?? null into scope and record it in actor_user_id for agent-source rows too (BeginPostInput already has the column); optionally mention the user in the tool's content line when present.

## security-6 [low] paperclip-extensions:plugins/gbp-reviews/src/worker.ts:576
**gbp_sync_location and gbp_list_reviews still resolve a location by key alone, without the location-owns-company rule the guard and the new page actions apply (pre-existing, adjacent to this change)**

Claim: review-sync-location (worker.ts:772-775) and the guard (replyGuard.ts:129) require location.targetCompanyId to equal the checked company, and gbp_get_review checks it at worker.ts:483, but gbp_sync_location (576-580) and gbp_list_reviews (436-440) find the location by key only. syncLocationReviews then files issues into location.targetCompanyId (worker.ts:116-124) on behalf of an agent from another company, and gbp_list_reviews reads another company's live reviews whenever the shared account's allowedCompanies also lists the caller's company. This code predates the diff (only syncLocationReviews' return type changed), so it is outside the stated scope, but it is the one remaining agent path that ignores the per-location company binding this build otherwise enforces everywhere.

Scenario: Companies A and B share a Google account whose allowedCompanies is ['*']. An agent in A calls gbp_list_reviews with B's locationKey and receives B's unreplied reviews with reviewer names and text; it then calls gbp_sync_location for the same key and new review issues are created in company B by A's agent.

Fix: Add the same check both tools' sibling already has: if (location.targetCompanyId !== runCtx.companyId) return fail('[ECOMPANY_NOT_ALLOWED] ...') before any Google call, with a handler test that an agent of company A gets the refusal for company B's location and fetch is never called.

## security-7 [low] paperclip:server/src/services/start-work.ts:336
**Any member with write access can trigger unlimited planner model calls with no rate limit or budget (spec defers metering)**

Claim: Each POST /companies/:companyId/start-work/plan with a fresh requestKey runs up to two completeOnce calls (draftWithModel, lines 335-342) on the instance's configured provider. The inflight map and the unique index only collapse repeats of the same key; nothing bounds distinct keys per user, per company or per minute, and the call is not charged to any agent budget (by design, per the header line). A viewer cannot reach it, but any non-viewer member can run up the instance's provider bill, and the 2000-character request plus roster, plugin and routine context is sent on every call.

Scenario: A member scripts POST .../start-work/plan in a loop with random UUID requestKeys and 2000-character text. Every call reaches the provider (503 only when no model is configured); each also writes a backlog container and a pending card that appear in the Brief as 'Plan waiting for your decision'.

Fix: Add a cheap per-user and per-company limit on the plan route (for example a small token bucket keyed on actorId and companyId, answering 429 with a plain sentence), and record the call in the activity log before the model call so abuse is visible. Real metering can stay deferred as the spec says.

## tests-006 [low] paperclip-extensions:plugins/gbp-reviews/src/worker.handlers.test.ts:173
**The real reply_posts SQL never runs; the stubs decide every idempotency outcome**

Claim: worker.handlers.test's harness answers every execute with rowCount 1 (line 175) and every unmatched query with [] (line 171), and replyGuard.test's MemoryStore (lines 53-135) re-implements beginPost by hand. So the INSERT ... ON CONFLICT ... WHERE status IN ('failed','unknown') at replyStore.ts:185-194, the rowCount-0-means-duplicate rule at replyStore.ts:214 and the partial unique index at migrations/002_reply_posts.sql:36 are exercised only through the string matcher test at replyGuard.test.ts:606-617. The spec calls that index the one layer that survives two processes, and no test touches it.

Scenario: If Postgres names the index differently in the message, the host wraps the driver message, or the ON CONFLICT statement raises the index violation in a form the regex at replyStore.ts:101 does not match, classifyBeginPostError returns null, beginPost rethrows, and a concurrent second tab gets a raw database error instead of [EDUPLICATE_IN_PROGRESS]. Nothing in either test file changes.

Fix: Add one test that runs createDbReplyStore against a real Postgres (the paperclip repo's embedded-postgres helper, or a throwaway schema on the local 54329 instance) and asserts beginPost returns 'duplicate_key' for a posted key, restarts a failed key, and returns 'review_busy' for a second key while another is 'posting'.

## tests-007 [low] paperclip-extensions:plugins/gbp-reviews/src/worker.handlers.test.ts:474
**No test pins that the agent tool ignores locationKey and derives the location from the review name**

Claim: gbp_reply_to_review discards locationKey (worker.ts:522, 'void locationKey') and lets the guard resolve the location from the review name under runCtx.companyId. Both tool tests (lines 460 and 474) pass the matching MAIN_ST key, so a change that reintroduced config.locations.find((l) => l.key === locationKey) to pick the account or the audit row's location would not be noticed.

Scenario: An agent in company A calls the tool with a reviewName under MAIN_ST (company A) and locationKey 'beta' (company B's location on the same Google account). The post must go to MAIN_ST with company A on the audit row, or be refused; it must never use BETA's targetCompanyId, account or displayName.

Fix: Add a tool test with locationKey BETA.key and MAIN_ST's review asserting the reply_posts INSERT params carry location_key 'main-st' and company_id COMPANY_A, and one with a locationKey that does not exist asserting the same outcome.

## tests-008 [low] paperclip-extensions:plugins/gbp-reviews/src/replyGuard.test.ts:621
**The reconcile branch for a different live reply is untested and its persisted text sits outside the dash sweep**

Claim: reconcileAgainstLive's third branch (replyGuard.ts:181-185, Google holds a different reply, row marked 'unknown') has no test; the stale-row tests cover only the null case (line 521) and the equal-text case (line 544). The dash sweep gathers only thrown messages and three receipt fields (lines 251-266), so the strings written into reply_posts.error at replyGuard.ts:178 and 184 and the logger lines are never checked, although the test name promises every returned string.

Scenario: A crashed worker's 'posting' row carries text X and Google now holds text Y written in the console. A new attempt must mark the old row 'unknown' with the 'Google holds a different reply' reason and then refuse [EREPLY_EXISTS] with zero PUTs. Nothing proves this today, and a long dash added to either error string would ship unnoticed.

Fix: Add that case to replyGuard.test.ts asserting the crashed row's status and error text and zero PUTs, and push every finishPost detail string into producedText from the MemoryStore so the sweep at line 621 covers persisted text as well as thrown text.

## tests-009 [low] paperclip:ui/src/components/StarterCatalogDialog.test.tsx:742
**The viewer test's 'no accept button' assertion is vacuous**

Claim: For a viewer submitDraft returns early (StarterCatalogDialog.tsx:143), so no plan is ever rendered and the card branch that omits onAcceptInteraction and onRejectInteraction for viewers (StarterCatalogDialog.tsx:427-428) never runs. The assertion at line 742 is true because there is no card at all, not because the card hid its button.

Scenario: Change line 427 to always pass acceptPlan; the viewer test still passes. Inside the dialog that branch is unreachable, so the test pretends to cover dead code.

Fix: Either drop the two assertions and the dead ternaries (the server refuses a viewer regardless), or render the card for a viewer through a seeded plan and assert the accept and reject buttons are absent from the card itself.

## tests-010 [low] paperclip:ui/src/components/StarterCatalogDialog.test.tsx:552
**A refetch failure after a successful accept is shown as a failed accept; no test covers it**

Claim: acceptPlan awaits issuesApi.get after acceptInteraction has already succeeded (StarterCatalogDialog.tsx:205-208); a rejection there falls into the same catch (243-245) and setFailure (195) shows the error text with the still-pending card on screen. The accept test at line 552 mocks get resolved; no test makes it reject.

Scenario: Accept succeeds, the container is now todo and its lead has been woken, then issuesApi.get fails (a 500 or a dropped connection). The person sees an error box and a card still offering Accept drafts, presses it, and gets 'Someone already decided this plan'. The receipt rule (never report something that happened as failed) is broken on the browser side.

Fix: After acceptInteraction resolves, treat a failed get as 'accepted, owner unknown' and build the receipt with the 'open PAP-42 and assign it' step; add a test with mockIssuesApi.get.mockRejectedValue asserting 'Plan accepted' is shown and the card is gone.

## tests-011 [low] paperclip-extensions:plugins/gbp-reviews/src/ui/replyErrors.test.ts:43
**The role sentence is pinned for people who have no access at all**

Claim: isAccessRefusal (replyErrors.ts:58-61) treats any message containing 'does not have access' as a viewer, and the test at line 43 pins 'User does not have access to this company' (server/src/routes/authz.ts:123, a non-member) to 'Your role in this company can read reviews but not post replies.' The same match catches 'User does not have active company access' (authz.ts:130, a suspended member). Neither person can read reviews, so the sentence on screen is untrue.

Scenario: A suspended member opens the Reviews page; the host refuses the list read; the page tells them they can read reviews but not post replies, which is false on both counts.

Fix: Map only 'Viewer access is read-only' to the role sentence, and map the two 'does not have access' sentences to 'You do not have access to this company's reviews.'; update the expectation at replyErrors.test.ts:43.

## ux-honesty-06 [low] paperclip-extensions:plugins/gbp-reviews/src/reviewQueries.ts:178
**'Last synced' shows the time of the last row change, not the last sync**

Claim: lastSyncedAtForLocation is MAX(updated_at) over the reviews rows. upsertReview sets updated_at = now() on a human post (replyStore.ts:242), so after a post the header at ReviewList.tsx:85 reads 'Last synced <time of the post>' although no sync ran; and a location with no reviews reads 'Last synced never' right after Sync now reported '0 new reviews pulled in.' (ReviewList.tsx:65).

Scenario: The operator posts a reply at 10:14; the list header says 'Last synced 10:14'; the real sync was 06:00. A new location with no reviews on Google: Sync now says 0 new, header still says never.

Fix: Record the sync itself (a per-location ctx.state key written at the end of syncLocationReviews, or a sync_runs row) and read that for lastSyncedAt; or relabel the current value 'Last updated'.

## ux-honesty-07 [low] paperclip-extensions:plugins/gbp-reviews/src/ui/index.tsx:195
**Location card renders 'no rating yet/5 avg' and a green 'All replied' badge for a location with no reviews**

Claim: The rating span is `{stars} {loc.avgRating?.toFixed(1) ?? "no rating yet"}/5 avg`, so when avgRating is null the fallback is glued to the suffix and reads ' no rating yet/5 avg'. Line 191 shows the green 'All replied ✓' badge whenever unreplied === 0, including totalReviews === 0, so an unsynced location claims everything is replied.

Scenario: A newly configured location before its first sync: 'All replied ✓', ' no rating yet/5 avg', '0 total reviews'.

Fix: Render `avgRating == null ? 'No rating yet' : `${stars} ${avg.toFixed(1)}/5 avg`` and show 'No reviews yet' (neutral colour) when totalReviews === 0.

## ux-honesty-08 [low] paperclip-extensions:plugins/gbp-reviews/src/worker.ts:709
**A missing Google account is reported as 'not allowed for this company' and named as an account**

Claim: When location.accountKey matches no configured account, review-detail sets posting.accountAllowed = false, so whyNoPostButton (editorState.ts:106-108) says 'This location's Google account is not allowed for this company in the plugin settings', naming the wrong cause (the account is absent, not disallowed; the mapper's EACCOUNT_NOT_FOUND sentence at replyErrors.ts:31 is never reached on this path). The Posts as line falls back to the key (draftReply.ts:58) and reads 'using the Google account <key>' as if that were an account.

Scenario: Location config with accountKey 'main' but no account 'main': the editor shows 'Posts as: Main St Store, using the Google account main' and a sentence about the allow-list.

Fix: Return posting: { accountFound: boolean, accountAllowed: boolean } from the worker and have whyNoPostButton say 'This location's Google account (<key>) is not in the plugin settings, so nothing can be posted from here.' before the allow-list sentence.

## ux-honesty-09 [low] paperclip-extensions:plugins/gbp-reviews/src/ui/ReviewEditor.tsx:120
**Toast says 'Reply posted' on a retry that posted nothing**

Claim: On a same-key retry the worker returns alreadyPosted: true (replyGuard.ts:157 and :224) and the panel shows 'Already posted' with 'This attempt had already reached Google, so nothing was sent twice.' (editorState.ts:334-335, ReviewEditor.tsx:343), but the host toast still says title 'Reply posted', body 'Posted as <location>.'

Scenario: Connection drops, the operator presses Yes, post it again, the guard reconciles: a toast announces a fresh post while the panel beside it says nothing was sent.

Fix: toast({ title: receipt.alreadyPosted ? 'Already posted' : 'Reply posted', body: receipt.alreadyPosted ? 'Google already had this reply; nothing was sent twice.' : `Posted as ${receipt.location.displayName}.`, tone: 'success' }).

## ux-honesty-10 [low] paperclip-extensions:plugins/gbp-reviews/src/manifest.ts:6
**Setup instructions shown on the plugin's settings screen keep four em dashes**

Claim: This build edits the SETUP_INSTRUCTIONS template (lines 8, 11, 12) but leaves U+2014 at line 6 ('# Setup — Google Business Profile Reviews') and lines 71, 72, 73 (the three troubleshooting bullets). The template is rendered on screen as the plugin's setup page.

Scenario: Open the GBP Reviews setup instructions: the heading and three troubleshooting lines carry em dashes.

Fix: Line 6: '# Setup: Google Business Profile Reviews'. Lines 71-73: replace ' — ' with ': ' (e.g. '- **`invalid_grant`**: re-run the grant script and update the refresh token secret.').

## ux-honesty-11 [low] paperclip-extensions:plugins/gbp-reviews/README.md:146
**A line this build adds to the README carries an em dash**

Claim: The added line '- `ReviewDashboardPage` — full page at route `gbp-reviews`. ...' contains U+2014, against the build's own rule that every persisted string it writes is dash-free (the new 0.1.10 entry above it is clean).

Scenario: git diff plugins/gbp-reviews/README.md shows the added line with an em dash.

Fix: '- `ReviewDashboardPage`: full page at route `gbp-reviews`. Location cards open ...'

## ux-honesty-12 [low] paperclip:server/src/services/attention-queue.ts:256
**Brief row says 'Nothing is created' while pointing at the issue that was created**

Claim: For a plan a person asked for, the row's consequence is 'Nothing is created until you accept it. Waiting costs nothing.' The row is attached to, and deep-links to, the request container issue that start-work.ts:494-502 created in backlog, and its detail line shows that issue's title. The spec's own container decision says no screen may claim nothing was created after drafting.

Scenario: The operator drafts, closes the dialog, opens the Brief: 'Plan waiting for your decision', 'Request: hire a bookkeeper', 'Nothing is created until you accept it.' He then finds that request issue in the Issues list.

Fix: 'No tasks are created until you accept it. Waiting costs nothing.'

## ux-honesty-13 [low] paperclip:ui/src/components/StarterCatalogDialog.tsx:257
**Reject cancels an issue on the server and tells the person nothing**

Claim: rejectPlan awaits issuesApi.rejectInteraction, which cancels the request container (issue-thread-interactions.ts reject hook), then calls clearPlan() and returns to the empty box with no notice or receipt, while accept, activation and a 409 each produce a visible result.

Scenario: The operator clicks Reject. The panel silently resets. Later he finds a cancelled 'Request: ...' issue and does not know what happened to it.

Fix: Before clearPlan(): setReceipt({ title: 'Plan rejected', steps: [{ step: 'cancelled', ok: true, detail: 'Request ', link: { to: `/issues/${plan.issue.identifier}`, label: plan.issue.identifier }, after: ' was cancelled. Nothing was started.' }] }).

## ux-honesty-14 [low] paperclip:server/src/services/start-work.ts:309
**A retried request drops the 'Left out, and why' list and the Routines note from the header**

Claim: findExisting returns leftOut: [] and notes.soundsRecurring: false (lines 309-313), so when the same requestKey is re-sent (the retry after a client timeout that the idempotency layers exist for) the header rendered at StarterCatalogDialog.tsx:516-544 loses the left-out list and the recurring note the first response carried; only the card's summary sentence still names the left-out titles. The code comment at :278-279 acknowledges the loss.

Scenario: The first draft times out in the browser after 30 seconds; the retry returns the stored plan; the header says 'Creates 3 tasks' with no 'Left out, and why' although two tasks were dropped for a missing plugin.

Fix: Persist leftOut and the recurring note with the plan (for example in the interaction's summary structure or a details JSON written in the same transaction) and return them from findExisting.

## ux-honesty-15 [low] paperclip-extensions:plugins/gbp-reviews/src/ui/index.tsx:37
**Dashboard widget prints the bracketed error code on screen**

Claim: ReviewSummaryWidget renders `GBP Reviews: {error.message}` raw, so the new [ESCOPE] refusal (hostScope.ts:53) and every other coded worker error appear with the code in brackets, while every other surface in this build routes through describeReplyError.

Scenario: An instance admin places the widget where host.companyId is null: 'GBP Reviews: [ESCOPE] This page must be opened inside a company.'

Fix: Render `<ErrorNote>{describeReplyError(error)}</ErrorNote>`; the file already imports both for the page.

