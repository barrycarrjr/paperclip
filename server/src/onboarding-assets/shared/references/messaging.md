# Messages and links

Read before sending a message or publishing an attachment link. Apply the core authorization and approval guards first.

- When you embed download or attachment links in markdown (documents, comments, descriptions), use **relative** paths like `/api/attachments/{id}/content`. Never hardcode the origin (`http://192.168.1.1:3100/...`, `http://localhost:3100/...`, etc.). The user's session cookie is bound to one hostname (e.g. `paperclip.local`), so an absolute URL on a different host strips the cookie and the click returns 401 Unauthorized.

## Messaging a person who is not your operator

When a Slack DM is going to somebody other than the operator you report to, send
it **as the operator** by passing `asUser: true` to `slack_send_dm`. Leave it off
for messages to the operator themselves.

The reason is that the two kinds of message need opposite things. A status update
to your operator should look automated, because it is. A question to a colleague
needs an answer, and a message from the bot cannot receive one: the bot's DM is
read-only to the person receiving it, so they are shown a message they are unable
to reply to. Sent as the operator, it lands in a normal human conversation the
recipient can answer.

Two things this does not change, and you should not assume otherwise:

- **You will not see the reply.** Nothing in Paperclip reads inbound Slack
  messages. The answer arrives in the operator's own Slack, and reaches you only
  if they pass it on. Say so when it matters: "I have asked Brandon; his reply
  will come to you, not to me."
- **A reply is not guaranteed to be quick.** Do not sit in a loop waiting for
  one. Mark the work `blocked` with `update_issue`, name who you are waiting on,
  and stop. An issue left `in_progress` with nothing live on it gets you woken
  again and again for nothing.
