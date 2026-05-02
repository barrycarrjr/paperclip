---
title: Managing Secrets
summary: How the secrets vault works and how to wire values into agents, plugins, environments, and scheduled tasks
---

API keys, tokens, and other sensitive values live in your company's **secrets vault**. Storing a value in the vault is only step 1 — each thing that needs to read it (an agent, a plugin, an environment, a scheduled task) needs its own *binding* that maps an env var name to a vault entry.

This is the part that trips most new operators: a secret can be sitting in the vault and still not reach the consumer that needs it.

## The two-step model

```
┌─────────────────────────┐
│   Secrets vault         │   ← VALUE lives here, encrypted, once
│   (Company → Secrets)   │     e.g. WORKSNAPS_API_TOKEN = "..."
└──────────┬──────────────┘
           │ referenced by name or id
   ┌───────┴────────────────────────────┐
   ▼            ▼            ▼          ▼
 Agent       Plugin     Environment   Scheduled
 binding     binding    binding       task binding
```

**Step 1 — store the value in the vault.** The value is encrypted at rest. The vault is company-scoped: every secret belongs to one company and can only be read by consumers in that company.

**Step 2 — bind it on each consumer.** A binding says "when you run *me*, inject vault secret X as env var Y." Without a binding, the value never reaches the running process.

A consumer can bind multiple secrets, the same secret can be bound by multiple consumers, and the env-var name on the consumer side doesn't have to match the vault name (though by convention it usually does).

## Step 1 — Create a secret in the vault

1. **Company → Settings → Secrets.**
2. Click **Add secret**.
3. Fill in:
   - **Name** — the canonical name, e.g. `WORKSNAPS_API_TOKEN`. Use uppercase + underscores; this is what consumers will refer to.
   - **Value** — the actual API key or token. This is encrypted on save and never displayed back in plain text.
   - **Description** *(optional)* — short note on what it's for and which consumers use it.
4. Save.

The secret now appears in the list with a creation date and a list of agents currently bound to it (empty when you first create one).

To rotate a value: click the rotate icon, paste the new value, save. A new version is created. Consumers bound with `version: "latest"` (the default) pick up the new value on their next run; no other action needed.

## Step 2 — Bind the secret to a consumer

The binding location depends on what's consuming it.

### Agent

1. **Agents → click the agent → Settings → Environment variables.**
2. Add a row.
3. **KEY** — the env var name the agent's code or skills will read (e.g. `WORKSNAPS_API_TOKEN`).
4. **Source** — choose **Secret**.
5. **Secret picker** — choose the vault entry by name.
6. Save.

The runtime resolves and decrypts the binding at process start and injects the value into the agent's environment as that env var.

### Plugin

1. **Plugin Manager → click the plugin → Environment config.**
2. Add a binding the same way as for an agent.
3. Save.

Plugin bindings only apply to that plugin's worker process — they don't leak into agents.

### Environment (SSH / sandbox)

For SSH and sandbox environment drivers, sensitive fields like `privateKey` are themselves stored as secret refs in the environment's config. Open the environment, edit the relevant field, and pick the vault secret.

### Scheduled task / routine

Routines that run their own command (rather than waking an existing agent) can carry an `env` block with secret bindings — same shape as the agent form. Open the routine, edit env, save.

## `secretId` vs `secretName`

Bindings can refer to a vault entry two ways. Both work; pick by intent.

| Form | When to use |
|---|---|
| `secretId` (UUID) | Pinned to one specific secret entry. Survives renames. The UI uses this by default when you pick from the dropdown. |
| `secretName` (string) | Looked up by name at save time. Useful when an agent autonomously sets up its own bindings (it doesn't have to discover UUIDs first). The server resolves the name to an ID on save. |

For day-to-day UI use, `secretId` (the dropdown) is fine. `secretName` is mostly an autonomy convenience.

## Why a binding can fail silently

A common surprise: a skill or script reads `$SOME_VAR` with a default fallback like `${SOME_VAR:-https://default.example.com}`. If the binding is missing, the fallback kicks in — the consumer keeps working but uses the default value, not the one in your vault. There's no loud error.

How to spot it:

- The vault row for the secret shows an empty list under "Bound to" (no agent references).
- The consumer's Environment variables editor has no row for that key.
- Logs show the consumer hitting whatever the code's default URL/value is, not yours.

The fix is always the same: add the missing binding on the consumer.

## Permissions

- Creating, rotating, and deleting vault secrets is **board-only** — agents can't add or read raw values.
- An agent *can* autonomously add a binding on itself (or on agents it's permitted to manage) referring to a vault entry by name — useful when an agent provisions its own configuration. But it still can't see decrypted values; only the runtime sees those, briefly, at process start.

## Related

- [Secrets deployment guide](../../deploy/secrets.md) — master-key file, encryption details, strict mode, migration from inline plain values.
- [Secrets API reference](../../api/secrets.md) — REST CRUD on the vault.
- [Managing Agents](managing-agents.md) — agent settings and configuration.
