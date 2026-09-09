# Plugin Authoring Guide

This guide describes the current, implemented way to create a Paperclip plugin in this repo.

It is intentionally narrower than [PLUGIN_SPEC.md](./PLUGIN_SPEC.md). The spec includes future ideas; this guide only covers the alpha surface that exists now.

## Current reality

- Treat plugin workers and plugin UI as trusted code.
- Plugin UI runs as same-origin JavaScript inside the main Paperclip app.
- Worker-side host APIs are capability-gated.
- Plugin UI is not sandboxed by manifest capabilities.
- Plugin database migrations are restricted to a host-derived plugin namespace.
- Plugin-owned JSON API routes must be declared in the manifest and are mounted
  only under `/api/plugins/:pluginId/api/*`.
- There is no host-provided shared React component kit for plugins yet.
- `ctx.assets` is not supported in the current runtime.

## Scaffold a plugin

Use the scaffold package:

```bash
pnpm --filter @paperclipai/create-paperclip-plugin build
node packages/plugins/create-paperclip-plugin/dist/index.js @yourscope/plugin-name --output ./packages/plugins/examples
```

For a plugin that lives outside the Paperclip repo:

```bash
pnpm --filter @paperclipai/create-paperclip-plugin build
node packages/plugins/create-paperclip-plugin/dist/index.js @yourscope/plugin-name \
  --output /absolute/path/to/plugin-repos \
  --sdk-path /absolute/path/to/paperclip/packages/plugins/sdk
```

That creates a package with:

- `src/manifest.ts`
- `src/worker.ts`
- `src/ui/index.tsx`
- `tests/plugin.spec.ts`
- `esbuild.config.mjs`
- `rollup.config.mjs`

Inside this monorepo, the scaffold uses `workspace:*` for `@paperclipai/plugin-sdk`.

Outside this monorepo, the scaffold snapshots `@paperclipai/plugin-sdk` from the local Paperclip checkout into a `.paperclip-sdk/` tarball so you can build and test a plugin without publishing anything to npm first.

## Recommended local workflow

From the generated plugin folder:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

For local development, install it into Paperclip from an absolute local path through the plugin manager or API. The server supports local filesystem installs and watches local-path plugins for file changes so worker restarts happen automatically after rebuilds.

Example:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/your-plugin","isLocalPath":true}'
```

## Supported alpha surface

Worker:

- config
- events
- jobs
- launchers
- http
- secrets
- activity
- state
- database namespace via `ctx.db`
- scoped JSON API routes declared with `apiRoutes`
- entities
- projects and project workspaces
- companies
- issues, comments, namespaced `plugin:<pluginKey>` origins, blocker relations, checkout assertions, assignment wakeups, and orchestration summaries
- agents and agent sessions
- goals
- data/actions
- streams
- tools
- operations (one declaration reaching both agents and people — prefer these over a tool plus a matching action)
- metrics
- logger

### Operations: reach agents and people with one declaration

Declare the thing once in the manifest:

```ts
operations: [{
  key: "resync",
  displayName: "Resync now",
  description: "Pull the latest records from the connected account.",
  parametersSchema: { type: "object", properties: { since: { type: "string" } } },
  // audience defaults to "both"; use "agents" or "users" to publish one lane
}]
```

Register the handler once:

```ts
ctx.operations.register("resync", async (params, opCtx) => {
  const count = await resync(opCtx.companyId);
  return { content: `Resynced ${count} records.`, data: { count } };
});
```

An agent now calls `<pluginId>:resync`, and the plugin's own screen calls the
same key through the action bridge. `opCtx.invokedBy` tells the handler which
one it is serving.

Do NOT register the same work as a `tools[]` entry and an `actions` key. That
is the pattern operations replaces, and it is how a plugin ends up with things
a person can do that no agent can.

Capabilities: `agent.tools.register` for an audience reaching agents,
`ui.action.register` for one reaching people. Both, for the default.

The test harness drives both lanes against the one handler:

```ts
await harness.executeTool("resync", { since }); // invokedBy: "agent"
await harness.performAction("resync", { since }); // invokedBy: "user"
```

### Say when an operation writes something

If running it twice is not the same as running it once — it sends an email,
files a ticket, charges a card — mark it:

```ts
operations: [{ key: "send-invoice", /* ... */ writes: true }]
```

The host then stops a retried agent call from doing the work twice: it replays
the first result instead. The key comes from the caller when it supplies one,
and otherwise from the run plus the arguments.

Pass `opCtx.idempotencyKey` on to any outside system that accepts one of its
own (Stripe and most messaging APIs do), so the protection reaches past
Paperclip.

The cost of marking a read-only operation by mistake is one database row. The
cost of missing a writing one is a duplicate email, so err towards marking it.

### Return a failure code, not just a message

```ts
import { operationFailure, OperationFailed } from "@paperclipai/plugin-sdk";

if (res.status === 401) {
  return operationFailure("needs_reconnect", "Help Scout rejected the stored credentials.");
}
if (res.status === 429) {
  return operationFailure("unavailable", "Help Scout is rate-limiting us.", { retryAfterMs: 30_000 });
}
```

Codes: `invalid_input`, `not_found`, `not_authorized`, `needs_reconnect`,
`unavailable`, `timeout`, `failed`.

Why it matters: an agent reading only prose cannot tell "try again in a
minute" from "a person has to reconnect the account", so it retries what can
never succeed. The host turns the code into one plain instruction the agent
reads alongside your message.

`throw new OperationFailed(code, message)` does the same from deep inside a
helper. Any other exception propagates as before — the host does not guess
whether an unrecognised crash is retryable.

### Plugin database declarations

First-party or otherwise trusted orchestration plugins can declare:

```ts
database: {
  migrationsDir: "migrations",
  coreReadTables: ["issues"],
}
```

Required capabilities are `database.namespace.migrate` and
`database.namespace.read`; add `database.namespace.write` for runtime mutations.
The host derives `ctx.db.namespace`, runs SQL files in filename order before the
worker starts, records checksums in `plugin_migrations`, and rejects changed
already-applied migrations.

Migration SQL may create or alter objects only inside `ctx.db.namespace`. It may
reference whitelisted `public` core tables for foreign keys or read-only views,
but may not mutate/alter/drop/truncate public tables, create extensions,
triggers, untrusted languages, or runtime multi-statement SQL. Runtime
`ctx.db.query()` is restricted to `SELECT`; runtime `ctx.db.execute()` is
restricted to namespace-local `INSERT`, `UPDATE`, and `DELETE`.

### Scoped plugin API routes

Plugins can expose JSON-only routes under their own namespace:

```ts
apiRoutes: [
  {
    routeKey: "initialize",
    method: "POST",
    path: "/issues/:issueId/smoke",
    auth: "board-or-agent",
    capability: "api.routes.register",
    checkoutPolicy: "required-for-agent-in-progress",
    companyResolution: { from: "issue", param: "issueId" },
  },
]
```

The host resolves the plugin, checks that it is ready, enforces
`api.routes.register`, matches the declared method/path, resolves company access,
and applies checkout policy before dispatching to the worker's `onApiRequest`
handler. The worker receives sanitized headers, route params, query, parsed JSON
body, actor context, and company id. Do not use plugin routes to claim core
paths; they always remain under `/api/plugins/:pluginId/api/*`.

UI:

- `usePluginData`
- `usePluginAction`
- `usePluginStream`
- `usePluginToast`
- `useHostContext`
- typed slot props from `@paperclipai/plugin-sdk/ui`

Mount surfaces currently wired in the host include:

- `page`
- `settingsPage`
- `dashboardWidget`
- `sidebar`
- `sidebarPanel`
- `detailTab`
- `taskDetailView`
- `projectSidebarItem`
- `globalToolbarButton`
- `toolbarButton`
- `contextMenuItem`
- `commentAnnotation`
- `commentContextMenuItem`

## Company routes

Plugins may declare a `page` slot with `routePath` to own a company route like:

```text
/:companyPrefix/<routePath>
```

Rules:

- `routePath` must be a single lowercase slug
- it cannot collide with reserved host routes
- it cannot duplicate another installed plugin page route

## Publishing guidance

- Use npm packages as the deployment artifact.
- Treat repo-local example installs as a development workflow only.
- Prefer keeping plugin UI self-contained inside the package.
- Do not rely on host design-system components or undocumented app internals.
- GitHub repository installs are not a first-class workflow today. For local development, use a checked-out local path. For production, publish to npm or a private npm-compatible registry.

## Verification before handoff

At minimum:

```bash
pnpm --filter <your-plugin-package> typecheck
pnpm --filter <your-plugin-package> test
pnpm --filter <your-plugin-package> build
```

If you changed host integration too, also run:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```
