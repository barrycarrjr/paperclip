# Trial run results (agent-run portion), 2026-09-08

Ran against the live app at paperclip.local:3100, logged in as Barry, against the real
8-company instance. Covers the highest-risk items from
`2026-09-06-p6-trial-checklist.md`, not the full 71 steps (see "What I did not run" below).

## Passed

**Part 1, steps 1/2/4 — company scoping while switching company on Email.** This is the
check the checklist itself calls the most important one in the whole list.

- Opened Email in Industry Bureau LLC: showed its own mailboxes
  (`barry.c@printinginabox.com`, Help Scout `support@printinginabox.com`) and its own
  folder tree.
- Switched to Carr Rock Holdings by clicking its logo: stayed on the Email page
  (`/CAR/email`), and correctly showed "Email is not available here. No mailbox in this
  company has been set up yet." — not Industry Bureau's mailboxes, not a blank/broken
  page. Confirmed by text search: no trace of `printinginabox` anywhere on the page.
- Switched to M3 Media LLC: stayed on `/MME/email`, showed M3's own mailbox
  (`barry.c@m3printing.com`). Again, no leftover Industry Bureau or Carr Rock content.

No cross-company data leak in any of the three switches. This is the property the whole
checklist calls the one that matters most, and it holds.

**Part 2, layout/naming — confirmed passively.** Every page loaded during the above
checks already showed: two sidebar headings ("Your workspaces", "Control center"), the
five renamed entries (Overview, Attention — reached via Work's tabs — Team, Work),
Everything at the bottom, and the scope button correctly reading "Industry Bureau LLC" /
"Carr Rock Holdings" / "M3 Media LLC" as the company changed. Consistent with what P1
already confirmed when the HQ rail change shipped this session.

## More checks, second pass

**Step 35 — settings pages findable by search. Passed, both halves.** Searching "plugins"
returned an "Instance settings" group with a "Plugins" row marked "Every company".
Searching "secrets" returned a "Company settings" group with a "Secrets" row marked "This
company". Both matched the checklist exactly.

**Step 48 — GBP review dashboard, core leak check. Passed; one separate inconsistency
found.** Opened the GBP Review Dashboard from M3 Media LLC, Industry Bureau LLC, and HQ.
The core thing this step guards against — a non-HQ company showing another company's
locations — did not happen anywhere. M3 and Industry Bureau each correctly said "Locations
belonging to the company you are viewing" (with no locations configured on either), and HQ
correctly said "Every location across the portfolio, because you are viewing from HQ."

Found something else, unrelated to the leak this step is checking for: HQ's portfolio view
lists a location called "M3 Printing", but M3 Media LLC's own GBP dashboard says "No GBP
locations configured yet" — reproduced twice. Not a data leak (HQ is allowed to see it), but
the two views disagree about whether M3 actually has a configured location. Possibly related
to a real issue already on M3's board, `MME-428: GBP OAuth token expired - review monitoring
blocked` — worth a look, not urgent.

**Step 9 — goal dialog keeping its target company across a switch. Could not run as
written; found something else instead.** Opened Work > Goals on M3 Media LLC, clicked Add
Goal, typed a title. The checklist's next instruction is to switch company by clicking its
logo on the rail while the dialog stays open. That click does nothing: the New Goal dialog
has a full-screen backdrop (`fixed inset-0` overlay, confirmed by checking exactly what
receives the click at that screen position) that swallows clicks anywhere outside the
dialog, including the company rail. So the specific scenario this step wants to test —
does the in-progress goal correctly stay tied to the company you started it in when you
switch company mid-edit — cannot actually happen today, because you cannot switch company
while this dialog is open at all. That may be exactly right (the dialog is meant to hold you
in place until you finish or cancel) or it may be the gap the checklist was written to catch;
either way it's a product call, not something I should decide.

## Not run

Everything else in the 71-step list: the rest of Part 1 (goal/project company-leak dialog,
keyboard access to the rail flyout), Parts 3–10 (Work/Team tabs in detail, email
triage/handoff, GBP reviews, Start-work AI plan drafting, the real Google post). Two
reasons:

1. Cost. Each full page check in this environment costs a very large, slow browser
   snapshot — the browser automation tool itself failed outright several times this
   session before recovering. Running all 71 steps this way would take a long time for
   comparatively low additional confidence, once the one property that actually gates
   everything else (Part 1's company scoping) is confirmed clean.
2. Real side effects. Parts 4, 6, and 9 tick, move, and reply to real mail in the real
   inbox, hand real messages to real agents, and would spin up real agent work — not
   something to do unsupervised as a "test" on live business data. Part 10 step 71 is an
   actual public post to Google and the checklist itself says only Barry can do that one.

## If continuing this later

Worth doing next, roughly in priority order: step 9 (goal/project dialog keeping its
target company across a switch — this is the same class of bug as what Part 1 already
checks), step 48 (GBP dashboard company leak — same class of check, different plugin),
step 35 (settings pages findable by search), step 53 (error messages stay on screen).
