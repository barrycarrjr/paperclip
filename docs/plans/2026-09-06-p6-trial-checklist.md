# P6 trial: what to click, in order

Created: 2026-09-06. Brought back in line with the app on 2026-09-08. For:
Barry. Purpose: the daily-use trial that only you can run. Each line is one
thing to do and what you should see. Tick it or say what you saw instead.
Nothing below needs the internal object model.

Log in at `http://paperclip.local:3100` (or `http://localhost:3100`) first.

## If you have already done this once

The layout changed a lot after the first version was written, so most of the
old steps have been re-checked against the running app and now quote what the
screen actually says.

Parts 2, 3 and 4 are entirely new. Steps 3, 4, 8, 9, 35 and 53 are new as
well, sitting inside older parts because that is where they belong. If you
did the first version and only want the new ground, do Parts 2, 3 and 4 and
those six steps, then jump to Part 10 for the one real post.

Everything else has been corrected, not added to. The main corrections: five
places have new names (Brief is Overview, Inbox is Attention, Issues is
Tasks, Routines is Automations, Work queues is Intake queues), search and
"What do you want done?" now live in the top bar, and the rail's hover panel
is a short list of shortcuts rather than the whole menu.

## Run sheet

### Part 1: switching companies (about 8 minutes)

1. Open **Email** in one company. Note the mailbox name in the left panel.
2. Switch to a different company by clicking its logo on the rail. You should
   stay in Email, and the mailbox list should be the new company's. Nothing
   from the old company should remain visible, not even for a moment. A short
   message appears saying "Now in <company>" and what it did with the page.
3. Open **Work** (it lands on Tasks) and switch company again. The message
   should read "Kept you on Tasks." with a **Go to where you left off** link.
   Click that link: it takes you to the page you last had open in this
   company.
4. Open one task, then switch company. You should land on the new company's
   Tasks list, and the message should read "Opened Tasks. The task you had
   open belongs to <the company you left>."
   STOP if step 2 or 4 shows the wrong company's data. That is the most
   important thing in this whole list.
5. Look at the button on the left of the top bar. It says the company you are
   in, in capitals. Switch to HQ and open **Portfolio Brief** (in HQ it is one
   of the pinned pages under YOUR WORKSPACES). The button should read
   "PORTFOLIO · 8 COMPANIES", not "HQ".
6. Collapse the sidebar with the button at its bottom edge. Rest the pointer
   on a different company's logo on the rail for half a second. A small panel
   opens: the company's name, one line saying what that company is, a **WHERE
   YOU LEFT OFF** row, and a short list of shortcut buttons (Email, Calendar,
   Team, Work, Phone, only the ones that lead somewhere). Click **Work**. You
   should land on that company's Tasks, with a single company code in the
   address, not two.
7. Press the browser back button. You should return to where you were, in the
   right company.
8. Still with the sidebar collapsed: press Tab until a company logo on the
   rail has the focus outline, then press the right arrow key. The panel opens
   and the focus moves into it, Tab walks the shortcut buttons, Enter opens
   one, and Escape closes it and puts the focus back on the logo. The logo's
   own tooltip says "Right arrow key for shortcuts".
   STOP if the panel opens but Tab skips straight past its buttons. Until this
   week nobody using a keyboard could reach any of them. Open the sidebar
   again afterwards.
9. Open **Work**, go to the **Goals** tab and click **New Goal**. Type a
   title. Do not save. Now switch company on the rail. The dialog stays open
   and gains the line "This goal will be saved in <the company you started
   in>, where you started it." Close it with the X without saving. Do the same
   on the **Projects** tab with **Add Project**: "This project will be saved
   in <company>, where you started it."
   STOP if there is no such line, or the dialog has quietly moved to the new
   company. A goal typed in one company used to be able to save into another.

### Part 2: the new layout (about 8 minutes)

10. Look at the sidebar menu. Two headings, **YOUR WORKSPACES** and **CONTROL
    CENTER**, eight entries between them, and **Everything** on its own at the
    bottom. Your workspaces has Email, Calendar and anything you have pinned.
    Control center has Overview, Attention, Team and Work.
11. Check the five new names: Brief is now **Overview**, Inbox is
    **Attention**, Issues is **Tasks**, Routines is **Automations**, Work
    queues is **Intake queues**. Only the names changed. Prove it with an old
    address: type your company code then `/issues`. It should open, and the
    page should say Tasks.
12. Go to HQ. Your workspaces there holds the eleven Portfolio pages instead
    of Email and Calendar, because HQ has no mailbox or calendar of its own.
    Un-pin one of them from Everything: it should stay gone when you come back
    to HQ, not be put back for you.
13. Click the scope button at the left of the top bar. A panel explains where
    you are: the name, one line of what it means, a **WHAT IT INCLUDES** line,
    and a line about what stays inside this scope. Below that a **GO TO** list:
    Portfolio first, then HQ, then every company, with a tick on the one you
    are in.
14. Open **Costs** in a company, then pick **Portfolio** from that Go to list.
    You should land on Portfolio Costs, not on the Portfolio Overview. From a
    page that has no all-company version you land on the Portfolio Overview
    and it says so.
15. Look at the top of the rail, above HQ: a globe button. Rest the pointer on
    it and it says "Portfolio". Click it. It takes the selection mark, and HQ
    should NOT be lit up at the same time.
16. From an all-company page, click a normal company on the rail. You should
    get that company's own version of the same page, and a line saying why,
    such as "Portfolio Costs adds every company together, so this is
    <company>'s own Costs."
17. While you are on a Portfolio page, look at the top bar: there is no
    **Start work** button. Pick a company and it comes back. That is on
    purpose: work is always created inside a company.
18. Click the magnifying glass in the top bar (or press Ctrl/Cmd+K). The box
    now reads "Search tasks, agents, email, notes, add-ons, settings...".
    Search and Start work are only in the top bar now. Neither should still be
    in the sidebar.

### Part 3: Work and Team, one page each (about 5 minutes)

19. Click **Work**. The heading reads "WORK IN <COMPANY>" and there are five
    tabs: Tasks, Projects, Goals, Automations, Intake queues. It opens on
    Tasks.
20. Click through the tabs and watch the address change (`/issues`,
    `/projects`, `/goals`, `/routines`, `/work-queues`). Press the browser
    back button: it should step back one tab at a time, with nothing bouncing
    you past a tab.
21. Open a single task from the Tasks tab. The tab strip goes away, because
    one task is a destination of its own. Back returns you to the tab.
22. Click **Team**. The heading reads "TEAM IN <COMPANY>" and the tabs are
    Right now, Agents, Org chart, Assistants. It opens on **Right now**: one
    line per agent saying what it is doing, anything needing you at the top,
    and filter chips (Everyone, Needs you, and so on).
    STOP if a line claims an agent is doing something you know it is not.
    Every sentence there is read from something already stored, so a wrong one
    is a real fault rather than a guess that missed.
23. Open one agent. Its first tab is called **Current work**, not Dashboard,
    and the trail above the page says the same word.

### Part 4: email, agents holding mail, and ticking several (about 10 minutes)

24. Open **Email**. Above the message list there are three tabs: **All mail**,
    **Unread**, **With agents**. If an agent is holding anything, With agents
    carries a count next to it.
25. Click **With agents**. It lists every message an agent is holding, from
    any folder, each with the agent's name, the stage it is at, and a link to
    the work it created. If none, it says "No agent is holding any mail right
    now." While it is still fetching it must say it is still checking, never
    "none".
26. Find a held message in All mail. Under its subject the row reads "With
    <agent> · <stage>". Open it: a panel headed "With <agent>" shows the stage
    and a link to the work.
27. In that panel click **Take it back**. Before anything happens it says what
    will happen: the message becomes yours, the agent stops and any run it has
    going is stopped, the work item stays but the agent comes off it and work
    already under way goes back to the to-do list, and nothing is sent to
    whoever emailed you. It asks for a reason and will not go without one.
    Type one and click **Take it back from <agent>**. It should report the
    parts separately rather than as one lumped success, and a run it could not
    stop should show as a warning that stays on screen until you close it.
    STOP if it reports success but the message is still in the With agents
    list.
28. Back on All mail, click **Select** in the list header. A checkbox appears
    on every row, and a strip appears above the list with "Select visible
    messages", a count, **Mark read**, **Move selected** and **Done**. A plain
    click ticks one row, a shift click ticks the range between two, and
    clicking the row itself still opens the message.
29. Tick two or three and click **Mark read**. The strip counts down while it
    runs, can be stopped, and holds its result in place instead of fading, for
    example "Moved 8. 2 failed." Anything that did not work stays ticked, so
    trying again cannot touch what already worked. There is no Delete in that
    strip, and there should never be one.
30. With some rows still ticked, change tab, or mailbox, or folder, or start a
    search. The ticks should clear every time. Switch company: the ticks clear
    and the checkboxes switch off.

### Part 5: the things built the week before (about 8 minutes)

31. Open **Everything** at the bottom of the menu. Under **PAGES** and
    **PLUGINS** is every workspace this company can reach, including the ones
    that no longer have a menu line (Clippy, Memories, Skills, Approvals,
    Receipts, Costs, Activity). Below them are **COMPANY SETTINGS** ("Just the
    company you are in. Changing these leaves every other company alone.") and
    **INSTANCE SETTINGS** ("Every company on this instance, not only the one
    you are in."). Outside HQ there should be no Portfolio section.
32. Hover any card under PAGES or PLUGINS. A pin icon appears on the right.
    Click it.
33. Look at the sidebar, under Calendar in Your workspaces. The pinned
    workspace should be there. Switch company: it should still be there if
    that company can open it, and absent if it cannot.
34. Un-pin it from Everything. It should leave the sidebar. The settings rows
    have no pin icon at all, on purpose.
35. Open search and type "plugins". You should get an **Instance settings**
    group with a **Plugins** row marked "Every company". Type "secrets": a
    **Company settings** row marked "This company". Click one and it should
    open the real screen.
    STOP if searching for a settings page finds nothing. Until this week it
    found nothing at all, which is what this fixed.
36. Type your company code then `/workspaces` into the address bar. If
    isolated workspaces are switched off you should get a page saying
    "Workspaces is not available here", "Isolated workspaces are switched off
    for this instance." and a button **Open experimental settings**. You
    should NOT be silently dropped on Tasks. (You type the address because
    while the feature is off the page is deliberately absent from Everything
    and from search. When it is on, both find it.)
37. Go to **Email** and start a new message with the pencil button in the
    message list header ("Compose new message"). Above the To field there
    should be a **From** line showing the mailbox address (or its name).
    Change the selected mailbox in the left panel and open it again: the From
    line should change.
38. Open any message and click **Reply**. The same From line should be above
    the reply box.

### Part 6: handing an email to an agent (about 10 minutes)

39. In Email, open a message and use **Hand off to agent** to give it to an
    agent. You should get a message naming the issue that was created, and
    saying if the agent could not be woken.
40. Open that issue. Below the description there should be a box titled
    **Handed over from an email** with a "Waiting to be picked up" badge and
    three buttons.
41. Click **Mark as picked up**. The badge should change.
42. Click **Finish and reply**. A text box appears with the line "This goes to
    whoever sent the email" above it. Leave it EMPTY and click. The button
    should read "Finish without replying", and nothing should be sent.
43. Hand off a second email, open its issue, click **Finish and reply**, type
    a short line, and click **Send and finish**. With your settings as they
    are, the box should say the reply is **waiting for you in Approvals**, not
    that it was sent.
44. Open **Approvals** (it no longer has a menu line: find it on the
    Everything page, or search for it). The reply should be there. Approve it
    if you want it to go, or reject it.
45. Go to **Instance settings > General**. Under "Hold outbound messages for
    approval" there is a block **Replies when an email handoff is finished**,
    with three buttons. "Same as above" should be highlighted. Click "Always
    ask me first"; it should highlight and survive a refresh. Set it back to
    whatever you want.
46. Hand off a third email and leave it. After an hour it should appear on
    your **Attention** list (this is what used to be called Inbox) as "An
    email handed over has not been picked up". Come back to this one later.

### Part 7: the plugins (about 5 minutes)

47. Open the **Phone** pages (Campaigns, Audit log, DNC list, Inbound routes).
    If the PBX account is shared across companies, each page should carry a
    short note at the top saying so and naming the account. If it is used by
    this company alone, there should be no note at all.
48. Open **GBP Review Dashboard** (from Everything, under the GBP Reviews
    add-on) in a company that is not HQ. You should see ONLY that company's
    locations, under the line "Locations belonging to the company you are
    viewing." Switch to HQ: you should see all of them, and the line should
    say "Every location across the portfolio, because you are viewing from
    HQ."
    STOP if a non-HQ company shows another company's locations. That was a
    real leak; if you see it, the fix did not take.

### Part 8: calendar and small things (about 4 minutes)

49. Open **Calendar**, open an event that has notifications on. There should
    be a **Notifies** row showing when you will be told, separate from when
    the event is.
50. Open the **Intake queues** tab on Work (this is what used to be called
    Work queues), open an item that has an issue. The linked issue should be
    shown.
51. Open an issue that contributes to a goal. The goal should be linked on the
    issue.
52. Open **Company settings** and click the links in it. None should 404.
53. If anything at all fails during this trial, watch what the red message
    does. It should stay on screen until you close it. Confirmations still
    fade after a few seconds; only failures stay.
    STOP if a failure disappears on its own. The reason the server gave is
    carried in that message and nowhere else, so losing it means losing the
    only explanation of why something did not save.

### Part 9: asking for work in your own words (about 10 minutes)

54. Click **Start work** in the top bar. A panel opens titled **What do you
    want done?** with a text box ("Type it however you'd say it out loud"), a
    **Draft a plan** button and the ready-made starter cards below it. (This
    used to be a line in the sidebar.)
55. Type a request the way you would say it out loud (for example "Chase the
    three unpaid invoices from last month and send me a summary") and press
    Enter. The box greys out while the plan is drafted; give it up to a
    minute. When it lands, a **Your plan** section appears with a short
    header: who the lead is, "Starts the moment you accept, and runs once.",
    how many tasks it creates and in which company, which AI model drafted
    it, and one sentence about whether the agents' emails, messages, calls
    and public posts will wait for your approval. Under that, a ticked list
    of tasks, each with a title, a why, a priority and the agent who would do
    it. STOP if the company named in the header is not the one you are in.
56. Click the request identifier in the header. It opens a new issue titled
    "Request: ..." with your exact words, in Backlog, assigned to nobody.
    Nothing else should have been created yet: no tasks, no agent woken.
57. Back in the panel, untick one task and click **Accept drafts** (it reads
    **Accept selected drafts** once something is unticked). A **Plan
    accepted** receipt lists each task created with a link, "Handed to
    <lead>. It will pick this up on its next run.", and "Left out by you: 1".
    If that agent is paused by budget, the line says so instead.
58. Open **Work** (it lands on Tasks). The request issue is now in Todo and
    assigned to the lead; its description ends with an "Accepted plan" list.
    Each new task's description ends with a line naming the request it came
    from.
59. Draft a second plan and close the panel without deciding. Open your
    **Overview** (or **Attention**): a row "Plan waiting for your decision"
    with the line "No tasks are created until you accept it. Waiting costs
    nothing." Open the request issue from it: the same plan card is there with
    the same accept and reject buttons. Click **Reject**. You should get a
    **Plan rejected** receipt saying the request was cancelled and nothing was
    started, and the request issue should be Cancelled with no tasks.
60. Type words that match one of the seven starters (their names are on the
    cards). The matching card moves up under "Ready-made starters that
    match" with its usual **Turn this on** button. Press Enter: you get a
    plan, and the starter is NOT switched on. Only its own button does that.
61. Type something that should repeat ("every Monday, ..."). The plan header
    should say this step creates one-off tasks only, with a link to the
    **Automations page** (this is what used to be called Routines). Do the
    same from HQ: the header should also say the plan is for HQ only, with a
    link to Portfolio directives.
62. If you have a company where your role is viewer-only, open the panel
    there. There should be no **Draft a plan** button and no **Turn this
    on**, just the sentence "You can browse this company, but only members
    who can create work can start it." Skip this step if you have no such
    company.
    If at any point the panel says no AI model is set up, it should offer
    **Create it as one issue instead**, which opens the normal New issue form
    with your words already filled in.

### Part 10: replying to a Google review (about 10 minutes, plus one real post)

63. Open **GBP Review Dashboard** in a company that is not HQ. Each location
    card has **Open ›**. Click it. You should see that location's reviews,
    newest first with unreplied ones on top: the reviewer's name, stars, what
    they wrote, when, and either "Not replied yet" or "Replied from
    Paperclip", "Replied by an agent" or "Replied in Google". Above the list
    there is a line reading "Google account <account>. Last synced <time>."
    and a **Sync now** button on the right.
64. Click **Sync now**. It reads "Syncing..." for a moment and the synced time
    updates. A review that so far only arrived by email should appear in the
    list after this.
65. Click a review that has no reply. The editor opens on the right: first
    "Loading the review and checking Google...", then the review, one line
    "Posts as: <location>, using the Google account <account>" that you cannot
    edit, an empty box, a **Start from the suggested reply** button, and the
    line "Not replied yet on Google." The editor is closed with **Close** at
    its top right.
    STOP if the Posts as line names a location or a Google account you did
    not expect. That line is the whole safety of this feature.
66. Click **Start from the suggested reply**. Text matching the star rating
    drops in. Change a word, click **Close**, then reopen the same review:
    your edited words should still be there (kept in this browser).
67. Do not post yet. Click **Post to Google**. The box is replaced by a panel
    titled "Post this reply to Google?" showing your exact text, the same
    Posts as line, and the sentence "Anyone can read this on Google. Paperclip
    cannot take it down afterwards; only Google's console can." **Yes, post
    it** must be greyed out until you tick "I understand this will be public".
    Leave it unticked and click **Back to editing**.
68. Open a review that already has a reply on Google. The page shows the
    existing reply before you type anything. Click **Post to Google**: the
    panel is now titled "Replace the reply on Google?", shows "On Google now"
    and "Your reply" side by side, and needs a second tick, "Replace the
    reply that is already on Google", before the button (now reading
    **Replace the reply on Google**) lights up. Do not confirm; click **Back
    to editing**.
69. Switch to HQ, open the GBP Review Dashboard, **Open ›** a location and
    click a review. You can read it, there is no Post button, and one sentence
    says "Open this location's own company to reply."
70. In the GBP Reviews plugin settings, turn OFF "Allow posting replies to
    GBP" if it is on, then reopen a review. No Post button; one sentence says
    posting is switched off in the plugin settings and that you can still copy
    the words into Google's console yourself. The review, the suggested reply
    and the text box should all still be there. Turn the setting back on.
71. The one real post, only you can do this, and only once. On a listing you
    own, pick a review you wrote yourself, or one where a public reply can
    honestly stay. Write text that can stay public, click **Post to
    Google**, tick "I understand this will be public", click **Yes, post
    it**. A **Reply posted** receipt appears as a short step list: "Checked
    Google for an existing reply" with "There was none.", "Posted to
    Google", "Recorded in Paperclip" with "The review now shows as
    replied.", and the task line "Still open. Close it yourself when you are
    done with this review." with an **Open the task** link. Click **Back to
    the list**: the review now reads "Replied from Paperclip" and the
    location's unreplied count has dropped by one. Then remove the test reply
    in Google's own console; Paperclip cannot remove replies, and the panel
    told you so.
    Optional, to see the double-post guard: before step 71, open the same
    review in a second browser tab. After posting in the first tab, tick and
    post in the second. It must refuse with "A reply is already on Google
    for this review..." and post nothing.

## What to tell me

Four things are enough:

- Any step where you saw the wrong company's data. Say the step number.
- Any step where a button did nothing, or something silently sent you
  somewhere else. Say the step number.
- Whether the Posts as line in Part 10 was right every single time.
- Whether you could do a normal session without needing to know internal
  names. That is A26, the only acceptance item nobody else can sign off.

## Why these steps, for reference

The steps here are drawn from the project's own acceptance list
(`2026-09-02-ux-control-center-validation.md`, A01 to A26), from the work in
`2026-09-02-ux-control-center-handoff.md` marked "not yet Barry-confirmed
live", and from the fifteen commits on the `ux-mockup-shell` branch that
built the agreed mockup (`2026-09-07-mockup-vs-app.md`). They are not
exhaustive: A05, A06, A08, A13, A14, A15 and A17 cover existing behaviour
that this project was careful not to change, and are better checked by using
the app normally than by a script.

Part 1 is first because company scoping was the largest class of bug found
(around fifty places), and one of its instances was a real leak in a plugin.
If Part 1 is wrong, nothing else matters.

Steps 8 and 9 are in Part 1 rather than Part 2 because both are company
scoping in disguise. A dialog that keeps your typed text across a company
switch could file it into the wrong company, and the rail's shortcuts are how
most company switches now start.

Parts 2, 3 and 4 are the mockup work. Nothing there changed what the app can
do: no page, route or address was added or removed, and every saved link
still opens what it always opened. What changed is where things are and what
they are called. The one exception is Part 4's "With agents" tab and taking a
message back from an agent, which is genuinely new behaviour.

Steps 42 and 43 are separate on purpose. The difference between "finish
without replying" and "send and finish" is the difference between an internal
note and a message to a customer, and the interface is built so the button
tells you which one you are about to do.

Step 46 cannot be checked in one sitting. The threshold is an hour, because
agents wake on their own schedule and a few minutes of delay is ordinary.

Parts 9 and 10 were added on 2026-09-06 when the two remaining features were
built. Step 71 is the only step in this whole list that writes something the
public can see and that Paperclip cannot undo, which is why it sits last and
why it is written for a review you control. Everything before it in Part 10
is a refusal or a confirm panel, and each of those is a thing the code must
do without you ever reaching Google.
