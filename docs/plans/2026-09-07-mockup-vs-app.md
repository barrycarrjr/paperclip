# What is different between the mockup and the app

Written 2026-09-07, on branch `ux-mockup-shell`.

Compares `docs/plans/2026-09-02-ux-control-center-reference/paperclip-operations-v3.html`, a
standalone concept page that is not application code, against the app as it stands. Both are read
against the agreed direction in `docs/plans/2026-09-02-ux-control-center-scope.md`, which says
plainly that the mockup is not a sign-off on every label or pixel.

No application code was changed to produce this. This file is the only file created.

Words used below. "The rail" is the narrow strip of company icons down the far left. "The sidebar"
is the wider menu next to it. "The top bar" is the thin strip across the top of the page that shows
where you are. "A plugin" is an add-on that installs extra pages and tools into the app; several
things in this comparison, including Phone, Reviews, company notes and private to-dos, are add-ons
that live in a separate code repository called `paperclip-extensions`.

## 1. How far apart are they

Mostly a repaint, with two real restructures and one genuinely new piece of behaviour. Almost
everything the mockup shows already exists in the app as a working page, and a large slice of the
agreed direction has already been built on this branch: pinned shortcuts, Calendar beside Email, an
"Everything" page listing every workspace, a scope label in the top bar, Email on mobile, and a
search box that already finds Email, Clippy and add-on pages. Calendar in particular is effectively
finished already, month and list views, an agent-schedule layer you can switch off, timezone,
repeats and notifications all present. The two real restructures are folding five separate Work
entries into one page with tabs, and folding three separate Team entries into one page that leads
with what each agent is doing right now. The one piece of new behaviour is an email staying visible
while an agent owns it, with its progress and a way to take it back, and that is written up and
waiting on a decision rather than waiting on typing.

## 2. Concrete differences

Sizes: small means a label or a single control. Medium means one page's layout, or one new page
built on data that already exists. Large means new behaviour, new stored data, or several pages
changing together.

### 1. The sidebar is far shorter in the mockup. Size: medium.

Mockup: two headings only. "Your workspaces" holds Email, Calendar and whatever the person has
pinned. "Control center" holds Overview, Attention, Team and Work. Below that sit All workspaces,
My to-dos, Administration and the person's own name. Eight main entries.

App today: an ungrouped block of Brief, Inbox, Clippy, Email, Calendar and pins, then a "Work"
heading with six or seven entries, then "Records" with three, then "Team" with three, then any
entries add-ons have contributed, then Everything. On HQ there is also a "Portfolio" heading with
eleven or twelve more entries stacked above all of it. See
`ui/src/components/SidebarMenu.tsx`.

This is what a person would notice first and every day, because it is on screen the whole time.

### 2. Most main destinations have different names. Size: small each, medium as a set.

Mockup: Overview, Attention, and a Work page whose tabs read Tasks, Automations and Intake queues.

App today: Brief, Inbox, Issues, Routines, Work queues. See
`ui/src/lib/workspace-catalog.ts`, which already carries a written warning
that these renames are a decision nobody has taken yet, and that if taken they have to change in
the sidebar, the catalog and each page's own heading at the same time rather than one screen at a
time.

### 3. Work is one page with tabs in the mockup, five menu lines in the app. Size: medium.

Mockup: a single Work page with tabs reading Tasks, Projects, Goals, Automations, Intake queues,
Broadcasts.

App today: Issues, Routines, Goals, Projects and Work queues are five separate lines in the
sidebar, with Memories as a sixth in the same group. The pages themselves are unchanged either way.
This is only about where you click to reach them.

### 4. The top bar carries the scope, the search and a Start work button. Size: medium.

Mockup: across the top of every page is a button showing the current company with a plain second
line under it saying what that scope actually means, for example "All accessible companies, not the
HQ team", "HQ's own agents and work", or "Company workspace". Beside it are a search icon and a
highlighted "Start work" button.

App today: the top bar holds a menu toggle, a small uppercase label such as "PORTFOLIO, 4
COMPANIES" or the company name, then the page title. See
`ui/src/components/BreadcrumbBar.tsx`. That label is not clickable. Search
and the "What do you want done?" button live at the top of the sidebar instead, and the company
name at the top of the sidebar opens a settings menu, not a scope picker. See
`ui/src/components/Sidebar.tsx` and `SidebarCompanyMenu.tsx`.

The plain-English sentence explaining the current scope does not exist today in any form.

### 5. Email has no way to see what an agent is holding. Size: large.

Mockup: the message list has three tabs reading All mail, Unread and With agents. A message an
agent owns shows a panel naming the agent, its stage, a "Linked work" button and a "Take over"
button. The mockup itself labels that panel "Proposed, persistent ownership and handback".

App today: the mail list has no tabs at all, only a single eye icon toggling "all" against "unread
only". Handing an email to an agent creates a piece of work and the message drops out of the unread
list. The tracking underneath is real and was built on this branch: there are proper delegation
states from delegated through to handed back, and a panel showing progress on the resulting issue's
own page (`ui/src/components/EmailHandoffPanel.tsx`). What is missing is
any of it appearing in Email. The mail list never reads that state, there is no list of everything
agents currently hold, and there is no operator "take over" control anywhere in the app. The panel
offers "hand back", which is the agent giving it back, not you taking it.

This is the only item on this list that is genuinely new behaviour rather than rearrangement, and
it is already specified in `docs/plans/2026-09-03-p5a-email-delegation-spec.md`.

### 6. Portfolio is something you can pick in the mockup. Size: medium.

Mockup: the rail has a "PF" button above HQ, and the scope picker lists "Portfolio, all accessible
companies" first, with HQ separate below it and described as "HQ's own team, not the portfolio
aggregate". Picking Portfolio keeps you on the page you were on.

App today: no Portfolio button anywhere. You click HQ, and only then does the sidebar grow a
Portfolio section holding eleven or twelve separate pages. The portfolio pages are even filed under
HQ's own web address. The top bar label does already say "Portfolio" when you land on one of them,
which was added for exactly this reason, but it reports where you ended up rather than letting you
choose it.

### 7. Switching company keeps you where you were. Size: medium.

Mockup: switching company leaves you on the same page, clears the previous company's selected
records, and prints a line at the bottom saying so.

App today: switching company sends you to the last page you had open in that company, falling back
to the Brief if there is none. See `ui/src/hooks/useCompanyPageMemory.ts`.
Much of the supporting work is already done: a shortcut you click explicitly now beats the
remembered page, and typed searches, selected mailboxes, drafts, dialogs and open Clippy chats are
each cleared on a switch by the pages that own them. There is no single rule doing it, and requests
already in flight are not cancelled; instead every page reads the company from the web address so a
late answer cannot land in the wrong place.

The scope document allows resuming the remembered page as an explicit alternative, so this is a
choice to make rather than a fault to fix.

### 8. Team is one page that leads with what each agent is doing. Size: medium.

Mockup: a single Team page. Each agent is one line with its name and a plain sentence about its
current work, tagged Working, Watching or Needs review, with a toggle to an org chart.

App today: three separate sidebar lines, Org chart, All agents and Assistants. There is no page
whose first view is what everyone is doing. On a desktop the All agents page even opens on the org
tree by default rather than the list. The only "right now" signal is a small live badge on a row.
See `ui/src/pages/Agents.tsx` and `OrgChart.tsx`.

### 9. Selecting several messages at once. Size: medium.

Mockup: a "Select" button turns on checkboxes, with "Select visible messages", "Move selected" and
"Mark read".

App today: there are no checkboxes in the mail list. You can act on a whole sender's mail at once
when grouping by sender is switched on, which gives mark all read, keep always, auto-triage and
move all, but you cannot tick four unrelated messages and move those.

### 10. Phone's sub-menu sits in a different place. Size: small.

Mockup: inside the Phone page there is a second menu down the left with four folding groups, Live,
History, Directory and AI calls.

App today: the same four groups exist with almost the same contents, but they are folding sections
in the main app sidebar, contributed by the two phone add-ons, and each entry is its own full page.
So the grouping the mockup asks for is already real; it is in the outer menu rather than inside the
Phone page.

**Decided 2026-09-08: do not build this.** Looked at again after the main menu was cut to eight
entries, in case that made the phone groups too large a share of it. It does not.

What the two add-ons really contribute: 3cx-tools gives one folding "Phone" item holding Live,
History and Directory, 11 real pages; phone-tools gives a second folding "AI Calls" item holding 5
more. Fully open that is 21 lines, but both groups remember whether you left them shut, per browser,
so on this machine they currently cost 2 lines out of about 11. Both groups appear together in only
two companies anyway, because each add-on allows a different set.

Three reasons not to move them. Nobody can own the page: there is no Phone page today, neither
add-on can host the other, and a company with only one of them would have pages with nowhere to
live, while making the app own it would mean the core product learning what a phone is and which
add-ons fill it, which is the coupling the add-on system exists to avoid. It would make the pages
harder to reach, not easier: Recordings is two clicks today and would become three, and all 15
addresses would still have to work, so it adds a hub and a second menu without removing anything.
And the shipping risk is one sided: add-ons release on their own tag, so an older copy of the app
would show a broken Phone entry while those pages vanished from the menu, with nothing gained to
offset it.

The scope document also asks for those groups to survive, not to move: "Live, History, Directory,
and AI calls with their existing subviews", and "maintain distinct scope/permission semantics even
when two plugins share one navigation group".

One real but separate thing was found while looking: the two phone groups are not next to each
other, because the host sorts contributed menu items by the add-on's display name when no order is
set, so Backups sits between 3CX and Phone Tools. The fix is an explicit order in the two add-on
manifests. That is an add-on change and should ride along with the next release rather than being
cut on its own.

### 11. The agent's own page has slightly different tabs. Size: small.

Mockup: Current work, Instructions, Skills, Runs, Configuration, Budget, Channels.

App today: Dashboard, Instructions, Skills, Configuration, Runs, Budget, plus any tabs an add-on
contributes. See `ui/src/pages/AgentDetail.tsx`. So the set is nearly
identical; the first tab is called Dashboard rather than Current work, and Channels is provided by
add-ons rather than being a fixed tab.

### 12. The hover shortcut on the rail. Size: small.

Mockup: hovering a company icon shows its full name, a one-line note such as "Keep your current
workspace", and five buttons for Email, Calendar, Team, Work and Phone.

App today: hovering a company icon shows its name and then that company's entire sidebar menu. See
`ui/src/components/CompanyRail.tsx`. Richer, and slower to scan.

### 13. A line along the bottom saying what just happened. Size: small.

Mockup: a permanent strip at the bottom narrating the last action, for example "Now in Personal.
Workspace preserved, previous company records cleared."

App today: no strip. Confirmations appear as pop-up messages that fade. Read the mockup's wording
carefully before copying any of it, because most of those sentences exist only to admit the concept
cannot really do anything.

### 14. The search box still describes itself too narrowly. Size: small.

Mockup: the search dialog is called "Find a workspace or start work" and its box says "Email,
agents, backups, notes".

App today: the search already finds Email, Clippy, Calendar, Assistants, Org chart, Memories,
Skills, Approvals, Receipts, Costs, Activity, Work queues, every add-on page and the portfolio
pages, which is exactly what the scope document asked for. But the box itself still reads "Search
issues, agents, projects", so it undersells what it can do. See
`ui/src/components/CommandPalette.tsx`.

### 15. Administration and Knowledge as standing menu entries. Size: small.

Mockup: Administration is a sidebar line opening a page with tabs reading Company, System,
Integrations and Backups, and Knowledge is a single line covering memories and the company skill
library.

App today: instance settings are reached from the account menu and company settings from the
company menu, with no sidebar line. Memories sits in the Work group and Skills sits in the company
dropdown, so what the mockup calls Knowledge is two separate entries in two different places.

**Decided 2026-09-08, and they are two different questions.**

**Knowledge: nothing to build.** The scope document asks for Knowledge to be "discoverable through
stable entries/catalog paths", and it already is. Memories and Skills are both entries in
`ui/src/lib/workspace-catalog.ts`, so both are already on the Everything page and both are already
found by the search box. Checked live on 2026-09-08 against the running app: the Everything page
lists them, and typing "skill" into the search box returns Skills under Pages. A Knowledge page
with two tabs would be a new page whose only content is two pages that already exist and already
have their own addresses, and it would need a new menu line to be worth having, which works against
the 2026-09-07 decision to cut the main menu to eight entries. Work and Team each folded several
menu lines into one; a Knowledge page would fold none and add one.

**Administration: no page and no menu line, but the catalog half was genuinely missing.** The
mockup's Administration page is a list of section names whose Inspect buttons open stub dialogs, so
there is nothing there to copy, and a hub page that only holds links to screens that already have
their own navigation is the "manufactured page" the scope document rules out. The two stable
entries were already in place: the company menu offers Company settings and the account menu offers
Instance settings.

What was missing is the other half of the same sentence, the catalog paths. The Everything page
promises "every workspace this company can reach" and the search box finds every other page in the
app, and neither of them knew a single settings page existed. Typing "plugins", "secrets",
"invites" or "MCP" found nothing. So the settings destinations now have their own small list,
`ui/src/lib/settings-catalog.ts`, which the Everything page and the search box both read. Sixteen
real screens, each reached directly. No new page, no new menu line, and nothing moved.

They are shown as two groups, never merged into one Administration heap, because the scope document
says a system wide setting must not look like it applies only to the company you are in. Each group
carries its own sentence and each row carries the short version, "This company" or "Every company".
Both scopes have a page called Access, which is exactly why the note is on the row rather than only
in the heading. Settings entries are deliberately not pinnable: pins resolve against core workspace
ids and plugin routes, so a star there would look like it worked and quietly do nothing.

### Things the mockup shows that the app already matches

Worth stating so nobody rebuilds them: Calendar's month and list views, the switch that hides agent
schedules, timezone, repeats and notification lead time are all already there. So are the pinned
shortcuts, the Everything page, Email's collapsible and draggable folder pane, its full-size reader,
its search and group-by-sender, its sender rules, compose, reply, reply all, forward and AI draft,
and the private to-dos and company notes pages, which are add-ons with their own sidebar entries
rather than missing.

## 3. Things in the mockup that should not be built

### The Agent tools page

The mockup has a page listing Slack Tools, Print Tools and Code Scanner as three cards whose only
action is "Discuss an action". Those add-ons deliberately have no page, and the scope document's own
wording is to keep tool-only add-ons findable "without manufacturing empty pages". A page of cards
that does nothing is exactly the manufactured page that rule exists to prevent. Confirmed: no such
page exists in the app today. There is a real but smaller gap underneath it, which is that nothing
in the app lists what a tool-only add-on can actually do beyond its one-line description. Fix that
where add-on settings already live, not with a new page.

### A human review reply editor, on the basis that one is missing

The mockup marks its Reviews reply editor "proposed" and stamps the preview "Not posted", and the
scope document's table describes today's Reviews surface as a location summary with agent-tool
workflows. **That description is out of date.** The Reviews add-on already ships a real human reply
editor: an editable box with a length limit, saved drafts, a "Posts as" line showing the exact
public identity, an AI suggestion the person can accept or edit, and a confirmation step that posts
to Google. See `paperclip-extensions/plugins/gbp-reviews/src/ui/ReviewEditor.tsx`. So there is
nothing to build here, and the scope document's row should be corrected rather than acted on. This
is worth Barry knowing, because that row currently reads as authorising design work on something
that exists.

### The mockup's new names, adopted one screen at a time

Tasks, Automations, Intake queues, Attention and Overview all read better than Issues, Routines,
Work queues, Inbox and Brief. But the non-goals section rules out renaming the underlying `issues`
and `routines` contracts just because a label changed, and the catalog file records that a first
attempt at this was caught in review for renaming in one place while every other screen still said
the old word. If this happens it is one decision applied everywhere at once, never a side effect of
a shell change.

### Anything the mockup only pretends to do

Every button in the mockup ends in a preview that does nothing, and it says so out loud: "Nothing
was sent, saved, posted, called, scheduled, or executed", "Approve, simulate", "No agent or model
was invoked", "Illustrative data". Specifically, do not read any of these as design:

- The companies, mailboxes, customers, calls and reviews are invented placeholder content.
- The month grid on the mockup's Calendar page is thirty-five boxes numbered one to thirty with no
  weekday alignment whatsoever. It is filler, not a layout, and the real Calendar is better.
- Administration's "Inspect" buttons open stub dialogs. The scope document says outright that the
  real screens are preserved and these are navigation examples only.
- The budget, cost, usage and daily-cap figures are typed-in numbers.
- The Clippy panel's "Approve, simulate" button and its permission states are drawings of a
  permission gate, not one. The real gates stay authoritative.

### External calendar sync

Not shown as a feature here, but worth restating because it is easy to infer from the Calendar
page's styling: the scope document records that source styling is not proof of a live connector, and
that any Google or Outlook sync needs its own scope review before anything is added or promised.

## 4. What I could not check, honestly

- I read the mockup's JavaScript rather than clicking through it. Behaviour that only appears at a
  particular window width, and the drag-to-resize on its folder pane, I inferred from the code and
  did not watch happen.
- **Email on a narrow screen is unchecked on both sides.** The mockup shows three buttons reading
  Folders, Messages and Read for moving between panes one at a time. I did not establish what the
  app's Email page does at narrow widths, so I have left that out of the numbered list rather than
  guess. The project's own audit from 2026-09-02 notes that even at desktop width the rail, sidebar,
  folder tree, list and reader compete for room, so it is worth a look.
- **The Inbox page is unchecked.** The mockup's Attention page has tabs reading All, My decisions,
  Approvals, Failures and Access requests. The app's Inbox covers the same ground according to its
  own help text, and it is known to group items and remember per-company filters, but I did not read
  the page, so I cannot say whether it splits them the same way.
- **The Clippy panel is unchecked in detail.** The mockup shows recent chats, a pop-out, a
  resizable width, and model, effort and permission pickers. The app has both a Clippy drawer and a
  full Clippy page, and its chat is already cleared correctly on a company switch, but I did not
  compare the controls one by one.
- Phone and Reviews live in the separate `paperclip-extensions` repository. Their menus and editors
  were confirmed to exist, but changing anything there needs its own branch and coordination, per
  this project's own rule.
- I did not run the app. Nothing here is a live check; it is all from reading files.
