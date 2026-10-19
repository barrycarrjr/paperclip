# Manual comment redaction

1. Choose **Redact** on a comment and paste the exact text to hide.
2. Check the comment preview and choose last-four or full replacement.
3. Click **Preview stored copies** and review estimated record counts by category.
4. Confirm **Redact**, or select a named company agent and confirm **Authorize agent**.
5. For delegation, start or mention that agent in this issue before the 30-minute expiry.
6. Read the result or activity entry. Incomplete cleanup requires separate operator action.

This is permanent application-level replacement, not physical erasure from database
pages or disks. No automatic scanner or future-write policy is installed. Targets
are exact and case-sensitive, including whitespace, quotes, backslashes and line
breaks. Select 4 to 2000 characters, with at least four non-padding characters,
up to 20 distinct selections through the API. The UI selects one at a time.
Four characters supports short PINs while refusing individual characters and
very short common fragments. For a shorter secret, include distinguishing surrounding
text. With last-four enabled, selections with eight or fewer letters or digits get
full replacement. Longer selections retain their last four letters or digits.
Adding a label does not guarantee a short secret is hidden: check exactly what
the preview retains, or choose full replacement. Common words can still affect
many records: review the impact before confirming. Targets must contain valid
Unicode characters; unpaired UTF-16 surrogates return 400.

## Preview and confirmation

The impact preview counts matching records in supported database text fields, not
individual occurrences. Counts are estimates observed while the database is changing;
local files are checked only during cleanup. The token binds the selection, replacement
mode, company and observed affected database content. The current comment must match
the displayed body, and confirmation checks the token against another observation.
A changed observed record requires another preview. Concurrent inserts or updates
after that observation can affect final counts. There is no global write freeze.
An agent executes the same confirmed selection later, so its counts can differ.

With username masking enabled, unchanged masked comment bodies can be confirmed,
and returned comment bodies remain masked. A masked username or home-path selection
is refused explicitly instead of pretending its raw value was cleaned. Disable
username masking and reopen the dialog if the exact stored value must be selected.

## Agent authorization

Only a board request with company write access can issue permission. Tool sessions
cannot issue it. A board-authored instruction in the same issue names the agent,
comment and endpoint. The permit stores positions for every distinct target, including
overlapping selections, and a comment-version digest, never the selected strings.
Permission lasts 30 minutes, can be consumed once, and does not start a run.
The success message tells the board to start or mention the named agent.

Email, agent prose, copied instructions and general destructive-action permissions
cannot grant this access. Execution validates company, issue, agent, source board
author, current board access, expiry, comment version and unused permission. The
agent cannot override the selection or mode. Comment changes require a new permit.
There is currently no board revoke action; do not rely on deleting an instruction
to withdraw permission. Wait for expiry or apply a newly confirmed direct redaction,
which invalidates remaining unused permits for that comment. Used permit timestamps
are preserved. Removing an agent removes its permits but retains counts-only audits.

These checks assume agents use their own agent credentials. In `local_trusted` mode,
credential-free local requests are board requests. On authenticated installations,
a local agent with filesystem access may be able to read the CLI board credential at
`~/.paperclip/auth.json`. Isolate that credential and board session from agents when
the distinction must be an enforceable security boundary.

## API

- `POST /api/issues/:id/comments/:commentId/redaction-preview`, board-only, accepts
  `{ targets: string[], keepLast4: boolean, expectedBody: string }` and returns
  `counts`, `impactToken`, `estimated: true`, `oversizedFields`, `skippedFields`, `residualMatches` and `cutoffCheckComplete`.
- `POST /api/issues/:id/comments/:commentId/redact`, board-only, accepts the same
  selection plus `impactToken` from the preview.
- `POST /api/issues/:id/comments/:commentId/redaction-authorizations`, board-only,
  accepts that confirmed selection plus `agentId`; returns `authorizationId`,
  `instructionComment` and `expiresAt`.
- `POST /api/issues/:id/comments/:commentId/redact-delegated`, agent-only,
  accepts only `{ authorizationId: string }`.

Redaction responses contain `comment`, `replaced`, `placesChanged` (record counts),
`otherCommentsWithText`, `notReachable`, `fileCleanup`, `auditFinalized`,
`cleanupStatus`, `residualMatches`, `cutoffCheckComplete`, `oversizedFields`, `skippedFields` and `activeRunCount` (null if its final check failed). Missing or stale impact tokens return 409;
nonmatching or masked selections return 422; invalid lengths return 400. Missing,
expired or consumed delegated permission returns 403. Audit details use `permitId`
to connect the requesting user and executing agent without storing selected text,
comment excerpts, titles or digests. Request logs and errors omit request contents,
including failed or malformed preview requests.

## Covered text fields

Within the selected company, cleanup covers the selected comment and these columns:

- Activity: human text in `details`.
- Runs: human text in `contextSnapshot` and `resultJson`, plus `stdoutExcerpt`,
  `stderrExcerpt`, `error`, `nextAction`, `livenessReason` and `modelReason`.
- Run events: `message` and human text in `payload`.
- Wake requests: `error` and human text in `payload`.
- Review decisions: `body`.
- Board chat: message human text in `content`, session `title` and `pageContext`.
- Runtime state: `lastError` and human text in `stateJson`.
- Task sessions: `lastError` only; session configuration is deliberately preserved.
- Thread interactions: `title`, `summary`, and human text in `payload` and `result`.
- Local NDJSON run logs: stdout, stderr and system chunk text, including matches
  split across chunks and JSON-escaped forms at one or two inner encoding levels.
  Non-ASCII Unicode escapes, either hex case and surrogate pairs are supported.

Operational JSON cleanup covers every string value except identifiers, configuration,
session settings, paths, folders, URLs, types, statuses, timestamps, usage and accounting
fields. Structural containers exclude their descendants. Unknown provider content is
covered, including task markdown, Codex aggregated output, Claude thinking, commands
and tool stdout. JSON keys and numeric tokens retain their exact bytes, including
integers above JavaScript's numeric range. Plain text columns and decoded content
strings stay content even when they contain JSON, including a pasted JSON-shaped
comment. Only recognized adapter frames in log chunks preserve inner operational
metadata; outer NDJSON transport metadata is always retained byte-for-byte.

Known activity snippets and wake comment bodies with this exact comment id are
rebuilt from the redacted source body, including nested run-event context copies.
Activity snippets keep their 120-character limit; inline wake comments keep their
4000-character or smaller shared limit. Already clipped fields never grow beyond
their stored length. A cut that would split an emoji drops the unfinished UTF-16
half so rebuilt JSON remains valid. Other comment identities are not used for this rebuilding.

Every rewritten candidate field and log stream is checked again for raw, once-escaped
and twice-escaped selections, including preserved structural values and keys.
A field that starts with an end piece or ends with a start piece of a selection
(at least four Unicode characters) also counts as a possible cut-off copy.
Paperclip's fixed run-event and run-log truncation markers also act as edges,
including within encoded provider strings. These markers only affect counting;
they never direct replacement of a partial selection. SQL
filtering checks these fragments in a separate read-only pass. Only exact encoded
forms, the source comment identity in JSON, and this selection's full mixed
literal/Unicode-escaped spellings enter modification candidates, row locks and the
impact token. A cheap precheck recognizes only this selection's own escaped
UTF-16 units, in either hex case, before evaluating full spellings. Unrelated
terminal colour escapes and escaped paths do not enable full spelling checks.
Encoding forms share one program where the compiler-work bounds allow it.
Long regex programs use bounded contiguous pieces, all of which
must match before the lossless matcher checks the complete selection. Sharing one
escaped letter does not make an unrelated row a modification candidate. Escaped
cut-off fragments stay in the separate read-only observation. Adding an
unrelated edge-only row cannot invalidate confirmation. These unidentified pieces
are counted, never deleted by guessing. The count is conservative and can include ordinary text.
Copies cut off inside the selection can still keep part of the text, especially
pieces shorter than four characters or pieces away from field edges. A zero count
does not establish that all partial copies are gone.
`residualMatches` reports remaining matches and possible cut-off pieces in the requesting board user's visible
coverage, without retaining their contents. Oversized fields and skipped files cannot
be counted exactly. The separate cut-off check processes at most 5000 candidate
rows, reading one extra row to detect overflow, in batches of at most 16. It has
its own 30-second budget and the transaction's statement timeout. Exhaustion or an oversized observation reports `cutoffCheckComplete: false`
in preview, result and audit, with a UI warning; it never refuses source redaction
or changes the impact token. This field covers visible database observations only,
not hidden chats or the separate file pass. Files are checked during cleanup rather than during preview.
Remaining copies require separate operator cleanup because the source comment may
already have been replaced.

Private chats are owned by their exact board user id, including local trusted users
and instance administrators. Preview counts, impact tokens and stale-preview checks
include only the requesting board user's chat sessions. Result and activity counts,
oversized counts and residual counts use that same scope. Delegated execution uses
the board requester's ownership, never the executing agent's identity. Other users'
company-scoped chats still receive a separate bounded best-effort cleanup. Their
contents, quantities, changes, skips and outcomes are never returned or audited.
Overall `cleanupStatus` therefore always reports `incomplete`, even when every visible
copy was cleaned: varying that bit with private cleanup results would reveal whether
someone else's chat contained a guessed phrase. `fileCleanup` still reports the file
pass result. Other companies remain unchanged.

## Availability, partial cleanup and exclusions

SQL filters candidate rows; batches select at most 16 records and only covered text
columns. Fields larger than 256 KiB are skipped and counted in `oversizedFields`.
JSON fields nested beyond 128 levels are skipped individually and counted in
`skippedFields`; other fields and the source comment still receive cleanup. Hidden
private-chat skips are never included in either public count. A
pass stops after 5000 candidate records or a 30-second processing budget; an over-broad selection fails and rolls back, requiring more distinguishing text. The
transaction uses a two-second lock timeout and 15-second statement timeout. Matching
rows are locked before replacement, and the comment, database copies and initial
audit commit together. Log work starts after commit, using one file lock at a time.
Matching data is prepared once per request and reused across fields, chunks and
residual checks. Each table discovers at most the remaining 5000 candidate ids
plus an overflow sentinel in one query, then loads batches by id without searching
history again. Board confirmation reuses its impact recheck's candidate ids for
replacement. Delegated execution first discovers ids without reading or
fingerprinting their contents. Both paths also discover hidden private-chat ids
in a separate best-effort savepoint before the first operational row lock.
Hidden discovery failures skip that private pass without affecting public counts,
tokens or errors. Its discovery and rewrite share one deadline. No operational
history search runs after the first operational row lock in that transaction.
Each discovery query converts and decompresses a covered value once per row,
then reuses that text for its predicates. SQL escape filters deliberately accept
extra backslashes introduced by JSON-column serialization; the exact JS matcher
still decides every replacement. Company and ownership scope is reapplied on every load. Database work
yields between batches. Appending to another file never waits for a company's database redaction. No database
work runs under a file lock, avoiding an append/finalize lock-order deadlock.

Active run files are skipped and reported as incomplete to avoid racing their
append/finalize metadata writes. Completed file rewrites preserve mode and refresh
byte counts and hashes. Symlinks, hard links, unreadable or malformed files and
files larger than 8 MiB or 20,000 events are skipped with incomplete file cleanup.
The file pass first selects a bounded list of this company's completed run refs,
newest first (using creation time when finish time is unknown), whose finish time is unknown or at least the source comment's creation
time. Active/queued runs are excluded. Refs must identify their canonical company,
agent and run file; absolute, escaping, mismatched or linked paths are refused.
Any remaining budget walks directory entries incrementally without revisiting those
paths. The pass yields between files and stops
after 30 seconds, 1000 log files, 5000 directory entries or 64 directory levels.
Waiting for a file lock also respects the deadline. An exhausted budget reports
incomplete file cleanup; it does not roll back the saved database replacement. Independent processes writing directly to files are outside the lock.
If final metadata/audit updates fail, `auditFinalized` is false and the durable initial
audit remains pending. Database replacement and permit consumption remain saved.

Active runs and chats can retain old text in memory and persist it after cleanup.
This implementation does not scrub their in-memory buffers or install future filters.
Delegated execution always reports `cleanupStatus: incomplete`, including its audit
and activity row, because its executing run can write the text again on completion.
Board execution also always reports incomplete to protect private chat outcomes;
active company runs are an additional reason copies may remain.
Stop relevant runs before direct redaction when practical. A consumed permit cannot
be retried, and the original text must still exist in the selected comment to create
a new preview. Separate cleanup is needed for any remaining copies.

Earlier backups and recovery history, external provider or tool sessions, plugin
storage, other issue comments, issue titles and descriptions, approval payloads and
comments, memories, work product summaries, rule proposals, documents, attachments,
exports, server diagnostic logs and browser caches are outside this action. HQ agents
may have read this company's comments into HQ's own runs; company isolation deliberately
leaves those copies unchanged. A complete file pass covers supported point-in-time
files only, subject to these exclusions, not every copy anywhere. Unidentified cut-off copies can retain part of the selected text. Overall cleanup
remains incomplete because private chat outcomes cannot be disclosed.

The source comment can exceed one million characters. `expectedBody` accepts up to
30 MiB of UTF-8 text; the complete JSON request, including JSON escaping, selections
and other fields, must fit the server's 30 MiB body limit. Oversized requests receive
413 with a body-size error. The dialog displays at most 16,000 preview characters
around the first match while counting and applying every exact match.

The conservative cut-off observation runs after the database replacement commits,
in its own read-only transaction with no company, comment or exact-copy row locks.
Each table's observation selects at most 5001 matching ids once, then reads bounded
fields in batches of 16. Preview uses the same bounded observation. The initial audit
records the cut-off check as pending. The final audit and response record
`cutoffCheckComplete` and observed residuals. A failed or timed-out post-commit check
reports unfinished observation; it cannot roll back the saved source replacement.
If audit finalization also fails, the durable initial audit stays pending.

A provider JSON line deeper than 128 levels is left unchanged, including structural
metadata, and makes file cleanup incomplete. Other lines in that file still receive
cleanup. Ordinary process output uses exact text replacement. This does not remove
the nesting bound or promise cleanup of a skipped provider frame.
