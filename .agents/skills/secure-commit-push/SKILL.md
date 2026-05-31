---
name: secure-commit-push
description: Scan the pending changes for leaked secrets, then commit AND push. Use whenever the user wants work committed and pushed together — "commit and push", "push these changes", "ship it", "commit/push the work" — or asks to check for secrets / sensitive data / credentials before committing ("make sure there's nothing sensitive then commit and push", "safe commit", "scan and push"). This is the push-capable, secret-gated counterpart to commit-review (which only commits locally and never scans); prefer this one whenever a push is wanted OR a secret check is requested. The secret scan is a hard gate — a real credential blocks the commit.
---

# Secure commit & push

Scan → commit → push. The scan is the whole point: a leaked key that reaches git history is expensive to walk back (you have to rotate the credential *and* rewrite history, and on a shared remote it may already be cloned). Catching it in the pending diff costs seconds. This is the complement to `commit-review`, which commits locally only and never scans — reach for this skill when the user wants a push and/or a secret check.

## Guardrails (read first)

- **Concurrent agents.** If the user has mentioned other agents/sessions are active on this repo, do NOT commit/push/tag without explicit per-action OK. "Do everything except X" never auto-grants git mutations.
- **Confirm the remote before pushing.** Verify with `git remote -v` rather than assuming — see the repo note below.
- **The secret scan is a hard gate.** A real credential in the pending content blocks the commit until resolved.
- **Never bypass hooks or signing** (`--no-verify`, `--no-gpg-sign`). If a hook fails, fix the underlying issue and re-commit.

## In this repo (paperclip)

This skill is scoped to the paperclip fork; bake in its conventions:

- **Remote:** push to `origin` = `barrycarrjr/paperclip` (the only active remote). `upstream` (paperclipai/paperclip) is NOT synced — never push there. Note `gh pr create` defaults to upstream, so pass `--repo barrycarrjr/paperclip` if a PR is ever needed.
- **Branch:** work happens on `master` (personal fork, no feature branches). `master` has a branch-protection rule ("changes must be made through a pull request") that an owner push **bypasses** — the push succeeds and prints a "Bypassed rule violations" notice. Surface that notice; it's expected, not an error.
- **Pre-commit hook:** runs the **full workspace typecheck** (all packages + server + ui + cli via `pnpm -r typecheck`) — it takes a minute and is normal. Let it run; never `--no-verify`. If it fails, fix the cause and re-commit.
- **Co-Authored-By:** use the model identity from the current system prompt's git section — don't hardcode a model that isn't yours (a future session may run this on a different model).

## Workflow

### 1. Survey

One message, parallel Bash calls:

- `git rev-parse --abbrev-ref HEAD` — current branch.
- `git status --porcelain=v1 -uall` — staged, modified, AND untracked.
- `git log --oneline -6` — confirm the commit-message style; also reveals if a hook/auto-commit already committed this work.
- `git remote -v` — confirm the push target.

If `git status` errors with "not a git repository", ask for the repo path — don't guess. On Windows bash: forward slashes, quote paths containing spaces or `!`.

### 2. Secret pre-flight — the core

Scan **what will be committed**, not the whole repo. That's the tracked changes plus any untracked files you intend to add.

- Pull the candidate content: `git diff HEAD` for tracked changes, and read each untracked file you plan to stage.
- Grep it (ripgrep / the Grep tool) for the patterns below.
- **Also scan for any secret *value* that appeared in this session** — a token, password, or key the user pasted into chat. Pattern lists miss these, and they're the highest-risk thing to leak. Search the changed files for distinctive substrings of it.
- **Triage every hit.** Benign: the matcher/regex itself, a `***REDACTED***`-style placeholder, docs shorthand (`sk-...…`), or a clearly-synthetic test fixture (short, labeled "example"/"fake"/"test"). Real: a full-length, live-looking credential.
- **Hard gate.** If real secret material is in the pending content, STOP. Do not commit. Show `file:line` and ask how to handle it (remove, parameterize via env/secret store, or `.gitignore` the file). If you find a real secret that is *already in history*, say so plainly — that needs rotation + history rewrite, not just "leave it out of this commit."
- Exclude build artifacts and noise (`dist/`, `*.tsbuildinfo`, `coverage/`, `node_modules/`). If `status` shows untracked junk, stage intended paths explicitly instead of `git add -A`.

Starting pattern set — extend for the repo's ecosystem:

```
sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}     # Anthropic (incl. sk-ant-oat01- setup-tokens)
sk-[A-Za-z0-9]{20,}                      # OpenAI & generic "sk-" keys
AKIA[0-9A-Z]{16}                         # AWS access key id
AIza[0-9A-Za-z_\-]{35}                   # Google API key
gh[pousr]_[A-Za-z0-9]{36,}               # GitHub tokens
xox[baprs]-[A-Za-z0-9-]{10,}             # Slack tokens
-----BEGIN [A-Z ]*PRIVATE KEY-----       # PEM private keys
eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.   # JWTs
(?i)(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{6,}['"]   # inline creds
[a-z]+://[^\s/:@]+:[^\s/:@]+@            # URL with user:password@ (DB/conn strings)
https://hooks\.slack\.com/services/      # Slack webhook URLs
```

### 3. Stage

Stage the intended files explicitly, or `git add -u` for tracked modifications/deletions. Avoid `git add -A` unless `status` confirms the only changes are the ones you mean to ship — don't sweep in unrelated in-progress work.

### 4. Commit

Use a HEREDOC to preserve formatting. Match the repo's prevailing style (`git log --oneline`); paperclip uses conventional-commit prefixes (`feat:`, `fix:`, scope in parens). Title states what changed; body adds why when non-obvious. End with the Co-Authored-By footer using the model identity from the current system prompt:

```bash
git commit -F - <<'EOF'
<title>

<body>

Co-Authored-By: <your model line from the system prompt>
EOF
```

If a pre-commit hook fails, fix the cause, re-stage, and make a NEW commit (no `--amend` unless asked).

### 5. Push

`git push origin <branch>` to the confirmed target. Then verify it landed: `git status -sb` should show the branch in sync, and note the pushed range (`<old>..<new>`). Surface any remote notes the push prints (e.g. the branch-protection bypass notice) so the user knows what the remote enforced.

### 6. Report

Tell the user: the secret-audit result (clean, or what was triaged and why it's benign), the commit hash, the hook outcome, the push result + range, and any remote notes.

## Notes

- Git CRLF warnings on Windows checkouts are harmless — don't try to "fix" them here.
- This skill pushes. If the user only wants a reviewed local commit with no push, that's `commit-review`.
- The pattern set is a net, not a proof. The session-value scan (step 2) and human judgment on each hit matter more than matching every regex.
