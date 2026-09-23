# Model availability: every model list shows what is actually available

Date: 2026-09-23. Status: built and tested on branch `feat/model-availability`, not yet committed. Results, decisions and open items are at the end.

## Problem

Paperclip shows AI models in about a dozen places (agent config, new agent, onboarding,
issue override, instance Agent Defaults, Clippy chat, email drafts) and picks models by itself
in several more (chat default, one-shot calls, vision calls, new Codex/Gemini/Cursor agents).
Most of those read hand-maintained lists that drift:

- Claude subscription installs only ever see the curated list, which is missing
  Claude Fable 5.1 and Claude Opus 5.5.
- Codex subscription installs only see a curated list (gpt-5.4, gpt-5.3-codex, ...). The
  account actually offers gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-*, gpt-5.5, and new
  Codex agents get pinned to `gpt-5.3-codex`, which the account no longer offers.
- Clippy's Anthropic/OpenAI/Gemini lists are literals; default picks are literals
  (`claude-opus-4-7`, `gpt-4.1`, `gemini-2.0-flash`).
- Vision detection only recognises `claude-*-4*`, so every Claude 5 model is treated as
  text-only. Best-model ranking does not know Fable and has no notion of "newer".
- Retired models are never flagged in the UI (a saved model missing from the list shows a
  green "current" badge), and nothing tells anyone when a new model arrives.

## How T3 Code does it (researched 2026-09-23)

- Claude: a JSON manifest in T3's GitHub repo, edited by hand by T3's maintainers, fetched
  hourly. The "legacy" flags, "new" badge and default are manual edits. The CLI is only used
  to check its version (models needing a newer CLI are hidden).
- Codex: live `model/list` from `codex app-server`. T3 ignores the retirement data it returns.
- A version advisory compares each CLI with the npm registry.
- A saved model that no longer exists silently switches to the default, with no warning.

## Approach

Three layers, cheapest and most authoritative first.

1. Live lists from each provider's own tool, per signed-in account, at no usage cost:
   - Claude Code CLI: the stream-json `initialize` control request returns the models the CLI
     offers this account (value, resolvedModel, effort levels). About 1 second, no prompt sent.
   - Codex CLI: `codex app-server` `model/list` returns every model the account can use,
     `isDefault`, `hidden`, and for retiring models `upgrade` plus
     `upgradeInfo.retirementAt` / `migrationMarkdown`.
   - Existing sources stay for the rest (Anthropic and OpenAI and Gemini APIs when a key is
     set, `agent models`, `opencode models`, Ollama tags, `pi --list-models`).
2. A public catalog for lifecycle facts, refreshed daily with an ETag and cached on disk:
   models.dev (`https://models.dev/api.json`, the catalog OpenCode uses). It has release
   dates, model families, a `deprecated` status, image input, effort values. It listed
   Claude Opus 5.5 on its release day. Override or disable with `PAPERCLIP_MODEL_CATALOG_URL`
   (`off` disables). Offline installs keep working on the last good copy, then the curated
   lists.
3. Curated lists in the adapter packages stay as the last-resort fallback only.

## Lifecycle rules (pure, server-side, unit tested)

Each model gets optional fields: `status` (`current` | `legacy` | `deprecated`), `isDefault`,
`isNew`, `releasedAt`, `retiresAt`, `replacementId`, `notice`, `aliases`, `effortLevels`,
`supportsImages`.

- `deprecated`: the provider announced a retirement (Codex `upgradeInfo`) or the catalog says
  `deprecated`. Shown with its retirement date and replacement.
- `legacy`: still served, but a newer release exists in the same catalog family in the same
  list (for Claude: anything the CLI no longer offers in its picker). Grouped under
  "Older models".
- `current`: everything else.
- `isNew`: released in the last 30 days (catalog date), never on legacy or deprecated.
- Order: current (newest release first), then deprecated, then legacy.
- Claude catalog models newer than anything the installed CLI offers in that family are left
  out, because the CLI needs an update before it can run them.
- Saved model ids are matched loosely: exact, alias, `[1m]` suffix removed, dots as dashes,
  dated snapshot to its undated alias.

## Where it is used

- `GET /api/companies/:companyId/adapters/:type/models` keeps returning an array, now with the
  lifecycle fields. `?refresh=1` forces a live re-read (and a catalog check, at most hourly).
- `GET /api/chat/models` entries gain `label` and the lifecycle fields.
- Default picks (chat, one-shot, vision) rank by family tier, then status, then newest version,
  so a new model is preferred the day it appears and legacy models are never picked by default.
- Vision capability comes from the catalog or the provider, with a prefix fallback that
  recognises Claude 3+ and GPT-4o/4.1/5/6.
- New Codex/Gemini/Cursor agents with no model get the live list's default, not a literal.

## Keeping people informed

The daily refresh (already scheduled once per UTC day) also:

- refreshes the catalog first;
- records each adapter's list in `<instance root>/data/model-availability.json`;
- when a model appears that was not in the previous snapshot, logs `model.available` on every
  company that has agents on that adapter;
- when a model an agent uses is newly retiring, logs `agent.model_retiring` for that agent with
  the date and the provider's suggested replacement;
- keeps the existing pause-and-flag for models that vanished from an exact list, now also for
  Codex (its list is exact per account). Claude on a subscription is flag-only, because its
  list is not exhaustive.

Nobody is ever moved to another model automatically.

## UI

- Pickers show current models first with "New" and "Default" tags, retiring models with their
  date, and older models folded under "Older models" (opened when the selected model is one).
- A saved model that is no longer offered shows "No longer available" instead of "current",
  and retiring or unavailable selections show one line with a "Switch to X" action.
- Every adapter gets a refresh button that really re-reads (`?refresh=1`).
- Activity entries for the new events say which model and why.

## Out of scope for this change

- CLI version advisories (T3 compares CLIs with npm). Worth doing next: a new model only
  appears in the Claude list once the installed CLI knows it.
- Ollama and Aider behaviour is unchanged: an agent whose Ollama model is not pulled is still
  paused by the daily check, even though a run would pull it.

## Results (2026-09-23)

### What changed, by area

- Claude: `packages/adapters/claude-local/src/server/cli-models.ts` reads the CLI's own list through the
  `initialize` handshake (about 1 second, no prompt, no MCP servers, run as the account agents use).
  `server/src/adapters/claude-models.ts` combines it with the catalog (older models) or the Anthropic API
  (with a key), and falls back to the catalog, then the built-in list.
- Codex: `packages/adapters/codex-local/src/server/app-server-models.ts` pages through `codex app-server`
  `model/list`, hidden models included for the daily check. New Codex agents with no model get Codex's own
  default (bounded to 5 seconds, then the old constant).
- Catalog: `server/src/services/model-catalog.ts` (models.dev, daily, ETag, disk copy at
  `<instance>/data/model-catalog.json`). Image, speech and video generators are dropped from every list.
- Rules: `server/src/services/model-lifecycle.ts` (statuses, new flags, successors, ranking) and
  `packages/shared/src/model-lifecycle.ts` (matching, saved-model state, successor chains).
- Clippy, one-shot calls, email drafts and vision: `server/src/services/chat-model-lists.ts` plus
  `chat-providers.ts`. No model id literals remain in the chat providers.
- Daily check: `server/src/services/adapter-model-refresh.ts` and `model-availability-state.ts`
  (`<instance>/data/model-availability.json`).
- UI: one shared `ModelPicker`, `ModelLifecycleBadge` and `SavedModelNotice` used by every picker.

### How it was checked

- Server: full suite 2,416 passed; two unrelated tests (heartbeat local environment, plugin repeat
  protection) failed once under full-suite load and passed on rerun. Model-related files: 162 tests after
  the review fixes.
- UI: full suite 2,128 passed. Packages (shared, adapter-utils, claude-local, codex-local, gemini-local)
  all pass. `pnpm -r typecheck` and `pnpm build` pass.
- The two CLI readers were run against the real Claude Code 2.1.281 and Codex 0.156.1 on this machine,
  and against stand-in CLIs in tests (Windows `.cmd` shims included).
- A separate test copy of Paperclip (port 3197, empty database) confirmed: the models endpoints return
  the marked lists; a new Codex agent gets `gpt-6-astra`; the daily check flagged an agent on Claude Opus 5
  ("replaced by Claude Opus 5.5") and one on GPT-5.5 ("retiring on 2026-10-14"), left an agent on the
  alias `opus` alone, paused nothing, and did not repeat its notices after a restart; the agent settings
  page shows the notice with a "Switch to Claude Opus 5.5" button and the grouped picker.
- An independent review found eight problems, all fixed with tests: image models counted as the newest
  text model, OpenAI dated snapshots read as version numbers, Responses-only `-pro` models chosen as
  defaults, Codex agents with their own sign-in at risk of a false pause, hidden Codex models and Claude
  aliases reported as unlisted, adapter lists overriding image support, and a catalog download that could
  delay every list for seconds while offline.

### Decisions worth a second look

- The catalog is a daily outbound request to models.dev (public, read-only, about 5 MB the first time,
  then ETag checks). `PAPERCLIP_MODEL_CATALOG_URL=off` turns it off.
- Defaults rank Opus ahead of Fable (Fable costs about twice as much per token), then Sonnet, then Haiku.
- A saved model the provider replaced gets one activity entry per agent; nothing is switched
  automatically. Codex agents on a model Codex no longer accepts are paused (only when they use the
  shared sign-in); Claude agents are never paused, only flagged.
- Clippy and email drafts now use the same popup picker as everywhere else, and onboarding resets the
  model when the adapter changes.

### Not done

- Agents on an Ollama model that is not pulled are still paused by the daily check (existing behaviour),
  although a run would pull the model.
- The Adapters page model count still comes from the built-in lists (`server/src/routes/adapters.ts`).
- The issue thread and Team page still say "paused by the system" without the reason; the agent record
  has no field for it.
- Gemini without an API key shows the built-in (older) list: there is no way to ask the Gemini CLI.
- Cursor, OpenCode and Ollama still show built-in suggestions when their CLI is not installed, and Clippy
  lists those too.
- No CLI version advisory yet. A new Claude model appears once the installed CLI knows it (the native
  installer updates itself); Codex installed through npm does not update itself.
- Found on the way, not fixed: Codex quota reading starts `codex app-server` with `-a untrusted`, which
  Codex 0.156 rejects, so that quota path probably fails on current Codex.
