# Email handoffs

This fork exposes email handoffs through `paperclipListEmailHandoffs`,
`paperclipAcknowledgeEmailHandoff`, `paperclipResolveEmailHandoff`, and
`paperclipHandBackEmailHandoff`. List handoffs for the current company, then
acknowledge a handoff before acting on it. Resolve it after completing the
requested work, or hand it back with a reason when another agent must act.
Use the host's company and agent identity; never substitute another company's
IDs. These aliases are traced to this fork's guidance, rather than claiming
coverage from an upstream evaluation that does not exercise email handoffs.

Email Tools routing can create the same tracked handoffs through its trusted
worker. An empty handed-over-by user means the plugin routed the mail
automatically; the issue and activity retain the initiating agent and run.
Retries return the existing issue, including after the handoff is closed, and
never reopen it. Manual re-delegation remains an explicit separate action.

Resolution reports replies separately from completed work. Returned tool errors
and unconfirmed or partial delivery never count as sent. Unknown delivery uses
the existing failed reply state with a note to verify delivery before retrying.
Queued means an approval draft was created. Installed Email Tools must advertise
`messageId` and accept a reply without a required `uid` before the host attempts
a Message-ID reply; older UID-only versions resolve the work without attempting
that reply. No setting or approval policy is changed by routing.
