# Handoff: the mockup was built, on a branch, and nothing is pushed

Written 2026-09-08 for whoever picks this up next, including the operator. Everything
named here is committed on `ux-mockup-shell` and none of it is pushed.

Read the run sheet first. The reasoning is below it.

## Run sheet

### Before you touch anything

1. `cd ~/paperclip && git status --short`. Only three untracked files should
   appear: `.server-out.log`, `.server-err.log` and
   `scripts/_run-with-clean-env.mjs`. **Never commit any of the three.**
2. `git log --oneline ux-control-center..HEAD` should show 27 commits.
3. The app runs from source. Start it with:
```bash
node cli/node_modules/tsx/dist/cli.mjs scripts/_run-with-clean-env.mjs
```
   Start it detached, or it dies with your session. It serves the browser code
   straight from `ui/src`, so a refresh picks up an edit; a change under
   `server/src` needs a restart.
4. Do not press Update or Rebuild in the account menu on this machine. Rebuild
   force kills the embedded Postgres holding the live data and relaunches
   through a launcher that does not use the wrapper above. Both pills are now
   correctly hidden on a source copy, but the buttons behind them still work.

### The two decisions that are open

5. **Keep this branch or throw it away.** To throw it away:
   `git checkout ux-control-center`. Nothing is pushed, so that is the whole
   undo. To keep it, push it and merge it into `ux-control-center`.
6. **Run the trial.** `docs/plans/2026-09-06-p6-trial-checklist.md`, 71 steps in
   ten parts, rewritten on 2026-09-08 to match this branch. Parts 2, 3 and 4 are
   entirely new. Step 71 is the only step that reaches the public internet.

### If something looks wrong

7. Two reports explain most of what is here and why:
   `docs/plans/2026-09-07-mockup-vs-app.md`, the comparison this work was built
   from, and `docs/plans/2026-09-08-narrow-and-keyboard-audit.md`, sixteen
   findings from a narrow width and keyboard pass.
8. Every commit message says what was decided and what was deliberately not
   built. Read the message before assuming something was missed.

### The plugin repo

9. `~/paperclip-extensions` is pushed and released. `master` is clean and
   `v0.78.0` is live, carrying `gbp-reviews-0.1.11`.
10. One plugin fix is written up but not made, in
    `docs/plans/2026-09-08-narrow-and-keyboard-audit.md` finding 16: five 3cx
    pages force a phone to scroll sideways. The app now holds itself steady, but
    content past the right edge is cut off rather than reachable until the
    add-on fixes its own widths.

## What is on the branch

27 commits. Twelve of the fifteen differences in the mockup comparison were
built, two were decided against with the reasoning recorded, and one was already
true. Sixteen audit findings were fixed. Three older flagged items were closed.
Four defects were found along the way that nobody was looking for.

**The layout.** The menu is eight entries under two headings instead of about a
dozen under four, with everything demoted still on the Everything page and in
search. Brief, Inbox, Issues, Routines and Work queues are now Overview,
Attention, Tasks, Automations and Intake queues; labels only, every address
unchanged. Search and Start work moved to the top bar, where the scope label
became a button that explains what you are looking at and lets you move between
scopes. Work and Team are single pages with tabs, each tab still its own
address. Switching company keeps you on the same page.

**Email.** Three tabs, a way to see what an agent is holding and take it back, a
way to tick several messages and act on them together, and a phone layout, which
it had never had.

**The things that were decided against.** The Phone menu stays in the main menu
rather than moving inside a Phone page: no add-on can own that page without
stranding the other's pages, and it would add a click rather than remove one. The
mockup's bottom status strip was not built: ten of its sixteen sentences exist
only to admit the mockup cannot do anything, and one was already built and better.
Both are written up where the decision was made.

**Four defects found by accident, all of which mattered more than the work that
found them.**

- New Goal and New Project, left open across a company switch, saved into the
  wrong company.
- The update check compared two commits for difference rather than direction, so
  a copy ahead of the remote was offered an update backwards.
- The reviews page had been blank since v0.77.0 shipped, because a plugin's
  browser code is handed React through a hand written list of names and it used
  one that was not on it. The list now forwards everything, and a page that
  fails to load now says so instead of looking empty. That silence is why it got
  through a release.
- A hidden sidebar left about two hundred controls in the keyboard's path.

## Things to know that are not in the code

- Migration 0097 is applied on this instance. No migration is pending.
- The instance is shared with other agent sessions and holds real business data
  across eight real companies. Two sessions worked in this checkout on
  2026-09-08; commit with an explicit file list, never a bare `git commit`,
  because another session's staged work would ride along.
- The Start work panel, the Email hand off and the broadcast preview all show
  the same set of facts before you commit to anything, on purpose. If you change
  the wording in one, change it in all three.
- What was flagged and left, with reasons, in the audit report: the per row email
  actions still overflow at tablet width, eleven other tab strips have the double
  back press fault that Work and Team had, the light theme focus ring is still
  below contrast, and the add-on list page still does not say what an add-on can
  do until you open it.
