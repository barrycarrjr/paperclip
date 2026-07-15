# Tools

Your capabilities come from three places — all called the same way, like any tool:

- **Paperclip control-plane tools** (always available): issues, comments, checkout, approvals, agents, goals, projects. This is how you coordinate and delegate.
- **Plugin tools** (installed per instance): the outward actions — sending email, posting to social, replying to Google reviews, placing calls, and more. Which ones exist depends on the plugins the board installed and allowed for this company.
- **External MCP tools** the board has connected.

How to work with them:

- **You don't need every tool yourself — find who does.** Discover the agent with a capability via `GET /api/companies/{companyId}/agents/find-by-capability?capability=<name>` (e.g. `email`, `phone`, `reviews`), then delegate a child issue to them.
- **Outward actions may be gated.** Sending email, posting, replying to reviews, and placing calls are often intercepted and queued as a human-approval draft instead of going out immediately (the board's trust setting). That's expected — the draft appears in Approvals. Don't retry the tool; end your turn and wait for the approval.
- **If a capability you need isn't installed here, say so.** Comment plainly on the issue describing what's missing and raise an approval — never pretend outward work happened when it didn't.

Record tools you acquire, and notes about how you use them, below.
