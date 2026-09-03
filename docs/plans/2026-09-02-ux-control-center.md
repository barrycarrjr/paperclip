# Paperclip multi-company operations UX — start here

Created: 2026-09-02. Owner and final acceptance: Barry Carr.

Status: planning package complete and validated; application implementation has not started.
Local development branch: `ux-control-center`.
Baseline: `558f0096faa8fbb1caee01dede0de231568f7ee5` on local `master`.

## Objective

Make this customized Paperclip fork a clear operations/control center for multiple companies and their agent teams. Barry must be able to operate the business himself, delegate work, understand agent progress, and know what needs his attention without learning the internal object model first.

This is an information architecture and interaction project, not a theme-only refresh or a replacement with stock Paperclip. Email is Barry's most-used workspace. Existing functionality, nested menus, and specialized workflows are acceptance requirements.

## Authority and working agreement

- Use provider-neutral names, documents, and handoffs. No AI provider owns the project or is required to continue it.
- This package is the authoritative project record. Conversation history and an agent's private workspace are not prerequisites for continuing.
- Barry specifically requested `docs/plans/` for this project. That project-specific direction overrides the repository's general `doc/plans/` location convention. Do not maintain a competing copy there.
- Develop locally on `ux-control-center`, using the normal checkout at `C:\Users\barry\paperclip`. The intended trial URL remains `http://paperclip.local:3100`.
- Keep `master` untouched. No push, PR, merge, release, or deployment until Barry explicitly authorizes the relevant action. Local commits are not yet made; follow the repository's commit-approval workflow when requested.
- Use the real existing components and services. Mockup forms, fake data, and simulated actions are not production implementations.
- Preserve real company data and operational configuration. A branch isolates code, not a database. Review and obtain approval for live-instance migrations before applying them, including migrations that startup would apply automatically.
- The current request is to prepare these planning files and report completion. Stop after that; the implementation backlog below is not a claim that implementation has begun.

## Reading order for any implementing agent

First read `AGENTS.md` and its required product/development/database documents. Then read:

1. [Scope and design decisions](2026-09-02-ux-control-center-scope.md).
2. [Feature preservation contract](2026-09-02-ux-control-center-preservation.md).
3. [Implementation sequence](2026-09-02-ux-control-center-implementation.md).
4. [Acceptance and verification](2026-09-02-ux-control-center-validation.md).
5. [Local runbook and rollback](2026-09-02-ux-control-center-runbook.md).
6. [Current status and agent handoff](2026-09-02-ux-control-center-handoff.md).
7. The archived audits below, then the relevant actual source before touching each area.

Read the handoff again immediately before starting work: status can change independently of the original plan.

## Centralized evidence and design references

All references are stored in this repository; the originals remain outside the repo but are not needed to continue.

| Reference | Role |
|---|---|
| [Page and feature audit](2026-09-02-ux-control-center-reference/paperclip-ux-audit.md) | Historical inventory of the customized product and all 11 installed plugin families |
| [Expanded interaction audit](2026-09-02-ux-control-center-reference/paperclip-interaction-audit.md) | Hidden menus, nested folders, dialogs, scope failures, and verification limits |
| [Mockup 1](2026-09-02-ux-control-center-reference/paperclip-control-center.html) | Initial visual direction Barry liked; insufficient operational depth |
| [Mockup 2](2026-09-02-ux-control-center-reference/paperclip-operator-workspaces.html) | Email and operational workspaces added; still insufficient expanded-state detail |
| [Mockup 3](2026-09-02-ux-control-center-reference/paperclip-operations-v3.html) | Latest interactive direction with folder pane, Clippy, scope switching, and deeper workspaces |

The audits are dated observations, not a current incident report. Code has advanced; revalidate every reported defect before fixing it. The newer interaction audit qualifies the older healthy-watcher example. The latest mockup has been delivered, but Barry has not signed off on every detail. This package separates agreed requirements from proposed design and gated additions.

The reference HTML is a local, non-networked interaction concept, not an application component. Optional host icon/design helpers are guarded; another provider can read and operate its ordinary HTML/JavaScript without those helpers. Do not copy its simulated behaviors or state architecture into production wholesale.

## Completion and publication gates

1. **Planning complete:** the linked files and reference snapshots exist, links resolve, and handoff accurately states what is and is not done.
2. **Local implementation complete:** preservation and acceptance checks pass on real React/UI code; failures and untested cases are disclosed; no regression is disguised as a design choice.
3. **Barry's local acceptance:** Barry uses the branch for normal operations and explicitly confirms satisfaction. Test success is not a substitute for this decision.
4. **Publication authorized:** only then, and after explicit authorization, push the branch and prepare a PR targeting `master`. PR creation is not permission to merge.

## Documentation maintenance rule

Run the [read-only package checker](2026-09-02-ux-control-center-check.mjs) after editing the package:

```powershell
node docs/plans/2026-09-02-ux-control-center-check.mjs
```

It needs only Node's standard library, validates local links/contracts and parses the archived mockup scripts without executing them. It does not start Paperclip, contact providers, change files, or validate application behavior.

After each meaningful implementation slice, update the handoff, phase status, actual checks/results, and decisions. Use the stable feature IDs and acceptance IDs across files. Record disagreements as decisions to resolve, not as silent changes to scope. Preserve historical references; revise the current scope/decisions instead of rewriting the audits to match new code.

Do not store credentials, cookies, database dumps, customer message bodies, or private operational screenshots in this package.
