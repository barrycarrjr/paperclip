# Security Policy

## Reporting a Vulnerability

This is a private fork. Report security vulnerabilities directly to the
fork owner at **barrycarrjr@gmail.com** rather than opening a public issue.

If you came here from the upstream Paperclip project, please report there
instead — issues found in unmodified upstream code should go to
[paperclipai/paperclip](https://github.com/paperclipai/paperclip/security/advisories/new).

## This repository is public: what never goes in it

Everything in this repository, and everything posted on its issues, pull
requests, discussions and commit messages, is visible to anyone on the
internet, and stays visible in crawls and forks even after it is deleted.

Never post or commit:

- Credentials: API keys, tokens, passwords, session cookies, private keys,
  `.env` contents, connection strings with a real password, webhook URLs
  with a signing secret.
- Customer or end-user data: names, emails, phone numbers, addresses,
  orders, invoices, support conversations, anything from a production
  database.
- Internal business details: pricing, contracts, revenue, vendor terms,
  unreleased plans, internal hostnames and IP addresses, employee personal
  details.
- Anything copied from a private system (Slack, email, Jira, a customer's
  site, a production log) unless its author marked it public.
- Machine-specific paths that reveal a username. Use `~/...`.

Need to share something sensitive to get help? Email the fork owner at the
address above, or post a redacted copy with every secret and personal
detail replaced. The full rules, including the automated checks that enforce
them, are in [`AGENTS.md`](AGENTS.md) section 12.

If a real secret was pushed, even briefly: rotate it first, then remove it.
Rewriting history does not undo a public push.
