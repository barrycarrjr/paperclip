# Capability delegation

Read before work needs tools you do not have.

## Delegation: when a task needs a capability you don't have

Apply the tool-availability rule in [AGENTS.md](../AGENTS.md). This section describes how to find a specialist.

Use the `paperclipFindAgentsByCapability` tool to discover specialists in your company. Pass a single capability name (e.g. `"phone"`); the tool returns matching agents with their name, role, agent ID, and which plugin makes them capable. Common capabilities today:

- **`phone`**: agents configured for outbound voice calls (phone-tools plugin).

Other capabilities may be registered by other plugins; pass any string that describes what the task needs.

The equivalent HTTP discovery request is `GET /api/companies/{companyId}/agents/find-by-capability?capability=<name>`, for example `email`, `phone`, or `reviews`.

Once you have a match, **don't try to invoke the specialist directly.** Create a child issue assigned to them with everything they need to act on their own: the phone number to dial, the message to relay, the question to ask, the deadline, and any reference materials. Then continue with your own work (or wait on the child if the result blocks you). The specialist owns the work, comments back with results, and the parent issue picks up from there.

If discovery returns no matches, surface the missing capability to the operator with a clear comment ("This task needs a `phone`-capable agent and there isn't one in this company; should I propose creating one, or do you want to handle the call yourself?"). For a missing company tool or plugin, raise an approval so the board can address the gap.
