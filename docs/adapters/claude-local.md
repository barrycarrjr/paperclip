---
title: Claude Local
summary: Claude Code local adapter setup and configuration
---

The `claude_local` adapter runs Anthropic's Claude Code CLI locally. It supports session persistence, skills injection, and structured output parsing.

## Prerequisites

- Claude Code CLI installed (`claude` command available)
- An authentication method configured (see [Authentication](#authentication))

## Authentication

`claude_local` spawns the host `claude` CLI, so it authenticates with whatever credential that CLI sees. Three options, ordered by durability for headless/agent use:

| Method | How | Billing | Notes |
|--------|-----|---------|-------|
| **Long-lived token** (recommended) | Run `claude setup-token` on the host, then bind its `sk-ant-oat01-…` output to `CLAUDE_CODE_OAUTH_TOKEN` in the adapter `env` (via a secret ref) | Subscription | Valid ~1 year; survives the short-lived OAuth session expiry. Must be set via the adapter `env` — see note. |
| **API key** | Set `ANTHROPIC_API_KEY` in the adapter `env` | Metered API ($) | Never expires, but bills off the API account instead of the subscription. |
| **Subscription login** | Run `claude auth login` on the host (writes `~/.claude/.credentials.json`) | Subscription | Short-lived access token + refresh token. If the refresh token is revoked or rotated by another login surface, the session silently dies and only an interactive re-login recovers it. |

> **Why the long-lived token must be set via the adapter `env`:** Paperclip strips an *inherited* `CLAUDE_CODE_OAUTH_TOKEN` from the spawned `claude` process — Claude Desktop injects a session-scoped token that is rejected with `401 Invalid authentication credentials` when used by an out-of-process child. A `CLAUDE_CODE_OAUTH_TOKEN` set explicitly in the adapter `env` is preserved and used; only the inherited desktop token is dropped. A failed run surfaces `errorCode: claude_auth_required` with re-auth guidance in the agent run view.

### Token setup (paste a `setup-token`)

A server-spawned interactive sign-in can't reliably complete the browser/device OAuth flow headless (it polls Anthropic and the approval often never reaches the operator). So the reliable, durable path is to mint the token in a terminal and paste it:

1. On the host, run `claude setup-token` **in a terminal** — the browser sign-in works there — and copy the printed `sk-ant-oat01-…` token.
2. Paste it into Paperclip and save.

Where to paste:

- **Per-agent** — the agent run view shows a token field when a run fails with `claude_auth_required`. `POST /agents/:id/claude-setup-token` (board-only) stores the token as the company secret `CLAUDE_CODE_OAUTH_TOKEN` and binds it into that agent's adapter `env`. Restart-proof, company-isolated; effective on the next run; re-pasting rotates the secret. Expiry (~1 yr) is stamped in `CLAUDE_CODE_OAUTH_TOKEN_EXPIRES`.
- **Instance** — Instance Settings → Adapters → sign-in. `POST /adapters/claude_local/submit-token` (instance-admin) applies it host-wide: sets it in the running server's `process.env` and persists it to the host user environment, so every claude_local agent across all companies inherits it. This rides the inherited-env path, so it can be re-stripped if the server is relaunched from a Claude Code / desktop context — prefer the per-agent secret for production agents.

The token never appears in logs or API responses, and the submit is synchronous (no server-spawned sign-in).

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Claude model to use (e.g. `claude-opus-4-6`) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `maxTurnsPerRun` | number | No | Max agentic turns per heartbeat (defaults to `300`) |
| `dangerouslySkipPermissions` | boolean | No | Skip permission prompts (default: `true`); required for headless runs where interactive approval is impossible |

## Prompt Templates

Templates support `{{variable}}` substitution:

| Variable | Value |
|----------|-------|
| `{{agentId}}` | Agent's ID |
| `{{companyId}}` | Company ID |
| `{{runId}}` | Current run ID |
| `{{agent.name}}` | Agent's name |
| `{{company.name}}` | Company name |

## Session Persistence

The adapter persists Claude Code session IDs between heartbeats. On the next wake, it resumes the existing conversation so the agent retains full context.

Session resume is cwd-aware: if the agent's working directory changed since the last run, a fresh session starts instead.

If resume fails with an unknown session error, the adapter automatically retries with a fresh session.

## Skills Injection

The adapter creates a temporary directory with symlinks to Paperclip skills and passes it via `--add-dir`. This makes skills discoverable without polluting the agent's working directory.

For manual local CLI usage outside heartbeat runs (for example running as `claudecoder` directly), use:

```sh
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

This installs Paperclip skills in `~/.claude/skills`, creates an agent API key, and prints shell exports to run as that agent.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Claude CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- API key/auth mode hints (`ANTHROPIC_API_KEY` vs subscription login)
- A live hello probe (`claude --print - --output-format stream-json --verbose` with prompt `Respond with hello.`) to verify CLI readiness
