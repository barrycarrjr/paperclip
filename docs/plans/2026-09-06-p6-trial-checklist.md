# P6 trial: what to click, in order

Created: 2026-09-06. For: Barry. Purpose: the daily-use trial that only you can
run. Each line is one thing to do and what you should see. Tick it or say
what you saw instead. Nothing below needs the internal object model.

Log in at `http://paperclip.local:3100` (or `http://localhost:3100`) first.

## Run sheet

### Part 1: switching companies (about 5 minutes)

1. Open **Email** in one company. Note the mailbox name in the left panel.
2. Switch to a different company using the rail. You should stay in Email, and
   the mailbox list should be the new company's. Nothing from the old company
   should remain visible, not even for a moment.
3. Look at the top of the page. The header should say which company you are in.
   Switch to HQ and open **Portfolio Brief**: the header should say
   "Portfolio" with a company count, not "HQ".
4. Collapse the sidebar. Hover a different company on the rail and click
   **Issues** in the flyout. You should land on that company's Issues, with a
   single company code in the address (not two).
5. Press the browser back button. You should return to where you were, in the
   right company.
   STOP if step 2 or 4 shows the wrong company's data. That is the most
   important thing in this whole list.

### Part 2: the things built this week (about 10 minutes)

6. Open **Everything** (bottom of the sidebar). Every workspace this company
   can reach should be listed. Outside HQ there should be no Portfolio section.
7. Hover any card on Everything. A pin icon appears on the right. Click it.
8. Look at the sidebar under **Calendar**. The pinned workspace should be
   there. Switch company: it should still be there if that company can open
   it, and absent if it cannot.
9. Un-pin it from Everything. It should leave the sidebar.
10. Open **Workspaces** from search (Ctrl/Cmd+K, type "workspaces"). If
    isolated workspaces are switched off, you should see a page saying it is
    not available and why, with a link to the setting. You should NOT be
    silently dropped on Issues.
11. Go to **Email**, click **New message**. Above the To field there should be
    a **From** line showing the mailbox address (or its name). Change the
    selected mailbox in the left panel and reopen: the From line should change.
12. Open any message and click **Reply**. The same From line should be above
    the reply box.

### Part 3: handing an email to an agent (about 10 minutes)

13. In Email, open a message and use the hand-off action to give it to an
    agent. You should get a message naming the issue that was created, and
    saying if the agent could not be woken.
14. Open that issue. Below the description there should be a box titled
    **Handed over from an email** with a "Waiting to be picked up" badge and
    three buttons.
15. Click **Mark as picked up**. The badge should change.
16. Click **Finish and reply**. A text box appears with the line "This goes to
    whoever sent the email" above it. Leave it EMPTY and click. The button
    should read "Finish without replying", and nothing should be sent.
17. Hand off a second email, open its issue, click **Finish and reply**, type
    a short line, and click **Send and finish**. With your settings as they
    are, the box should say the reply is **waiting for you in Approvals**, not
    that it was sent.
18. Open **Approvals**. The reply should be there. Approve it if you want it
    to go, or reject it.
19. Go to **Instance settings > General**. Under "Hold outbound messages for
    approval" there is a new block, **Replies when an email handoff is
    finished**, with three buttons. "Same as above" should be highlighted.
    Click "Always ask me first"; it should highlight and survive a refresh.
    Set it back to whatever you want.
20. Hand off a third email and leave it. After an hour it should appear on
    your **Inbox** attention list as "An email handed over has not been picked
    up". (Come back to this one later.)

### Part 4: the plugins (about 5 minutes)

21. Open the **Phone** pages (Campaigns, Audit log, DNC list, Inbound routes).
    If the PBX account is shared across companies, each page should carry a
    short note at the top saying so and naming the account. If it is used by
    this company alone, there should be no note at all.
22. Open **GBP Reviews** in a company that is not HQ. You should see ONLY that
    company's locations. Switch to HQ: you should see all of them, and the
    subtitle should say you are viewing from HQ.
    STOP if a non-HQ company shows another company's locations. That was a
    real leak, fixed this week; if you see it, the fix did not take.

### Part 5: calendar and small things (about 3 minutes)

23. Open **Calendar**, open an event that has notifications on. There should
    be a **Notifies** row showing when you will be told, separate from when
    the event is.
24. Open **Work queues**, open an item that has an issue. The linked issue
    should be shown.
25. Open an issue that contributes to a goal. The goal should be linked on
    the issue.
26. Open **Company settings** and click the links in it. None should 404.

### Part 6: asking for work in your own words (about 10 minutes)

27. In the sidebar click **What do you want done?**. A panel opens with a text
    box, a **Draft a plan** button and the ready-made starter cards below it.
28. Type a request the way you would say it out loud (for example "Chase the
    three unpaid invoices from last month and send me a summary") and press
    Enter. The box greys out while the plan is drafted; give it up to a
    minute. When it lands, a **Your plan** section appears with a short
    header: who the lead is, "Starts the moment you accept, and runs once.",
    how many tasks it creates and in which company, which AI model drafted
    it, and one sentence about whether the agents' emails, messages, calls
    and public posts will wait for your approval. Under that, a ticked list
    of tasks, each with a title, a why, a priority and the agent who would do
    it. STOP if the company named in the header is not the one you are in.
29. Click the request identifier in the header. It opens a new issue titled
    "Request: ..." with your exact words, in Backlog, assigned to nobody.
    Nothing else should have been created yet: no tasks, no agent woken.
30. Back in the panel, untick one task and click **Accept drafts** (it reads
    **Accept selected drafts** once something is unticked). A **Plan
    accepted** receipt lists each task created with a link, "Handed to
    <lead>. It will pick this up on its next run.", and "Left out by you: 1".
    If that agent is paused by budget, the line says so instead.
31. Open Issues. The request issue is now in Todo and assigned to the lead;
    its description ends with an "Accepted plan" list. Each new task's
    description ends with a line naming the request it came from.
32. Draft a second plan and close the panel without deciding. Open your
    **Brief** (or Inbox): a row "Plan waiting for your decision" with the
    line "No tasks are created until you accept it. Waiting costs nothing."
    Open the request issue from it: the same plan card is there with the same
    accept and reject buttons. Click **Reject**. You should get a **Plan
    rejected** receipt saying the request was cancelled and nothing was
    started, and the request issue should be Cancelled with no tasks.
33. Type words that match one of the seven starters (their names are on the
    cards). The matching card moves up under "Ready-made starters that
    match" with its usual **Turn this on** button. Press Enter: you get a
    plan, and the starter is NOT switched on. Only its own button does that.
34. Type something that should repeat ("every Monday, ..."). The plan header
    should say this step creates one-off tasks only, with a link to the
    Routines page. Do the same from HQ: the header should also say the plan
    is for HQ only, with a link to Portfolio directives.
35. If you have a company where your role is viewer-only, open the panel
    there. There should be no **Draft a plan** button and no **Turn this
    on**, just the sentence "You can browse this company, but only members
    who can create work can start it." Skip this step if you have no such
    company.
    If at any point the panel says no AI model is set up, it should offer
    **Create it as one issue instead**, which opens the normal New issue form
    with your words already filled in.

### Part 7: replying to a Google review (about 10 minutes, plus one real post)

36. Open **GBP Reviews** in a company that is not HQ. Each location card now
    has **Open ›**. Click it. You should see that location's reviews, newest
    first with unreplied ones on top: the reviewer's name, stars, what they
    wrote, when, and either "Not replied yet" or "Replied from Paperclip",
    "Replied by an agent" or "Replied in Google". Above the list: "Last
    synced <time>" and a **Sync now** button.
37. Click **Sync now**. It reads "Syncing..." for a moment and the synced
    time updates. A review that so far only arrived by email should appear
    in the list after this.
38. Click a review that has no reply. The editor opens on the right: first
    "Loading the review and checking Google...", then the review, one line
    "Posts as: <location>, using the Google account <account>" that you
    cannot edit, an empty box, a **Start from the suggested reply** button,
    and the line "Not replied yet on Google."
    STOP if the Posts as line names a location or a Google account you did
    not expect. That line is the whole safety of this feature.
39. Click **Start from the suggested reply**. Text matching the star rating
    drops in. Change a word, click **Back to the list**, then reopen the same
    review: your edited words should still be there (kept in this browser).
40. Do not post yet. Click **Post to Google**. The box is replaced by a panel
    titled "Post this reply to Google?" showing your exact text, the same
    Posts as line, and a sentence saying anyone can read it on Google and
    Paperclip cannot take it down. **Yes, post it** must be greyed out until
    you tick "I understand this will be public". Leave it unticked and go
    **Back to the list**.
41. Open a review that already has a reply on Google. The page shows the
    existing reply before you type anything. Click **Post to Google**: the
    panel is now titled "Replace the reply on Google?", shows "On Google now"
    and "Your reply" side by side, and needs a second tick, "Replace the
    reply that is already on Google", before the button (now reading
    **Replace the reply on Google**) lights up. Do not confirm.
42. Switch to HQ, open GBP Reviews, **Open ›** a location and click a review.
    You can read it, there is no Post button, and one sentence says "Open
    this location's own company to reply."
43. In the GBP Reviews plugin settings, turn OFF "Allow posting replies to
    GBP" if it is on, then reopen a review. No Post button; one sentence
    says posting is switched off in the plugin settings and that you can
    still copy the words into Google's console yourself. The review, the
    suggested reply and the text box should all still be there. Turn the
    setting back on.
44. The one real post, only you can do this, and only once. On a listing you
    own, pick a review you wrote yourself, or one where a public reply can
    honestly stay. Write text that can stay public, click **Post to
    Google**, tick "I understand this will be public", click **Yes, post
    it**. A **Reply posted** receipt appears as a short step list: "Checked
    Google for an existing reply" with "There was none.", "Posted to
    Google", "Recorded in Paperclip" with "The review now shows as
    replied.", and the task line "Still open. Close it yourself when you are
    done with this review." with an **Open the task** link. Go **Back to the
    list**: the review now reads "Replied from Paperclip" and the location's
    unreplied count has dropped by one. Then remove the test reply in
    Google's own console; Paperclip cannot remove replies, and the panel
    told you so.
    Optional, to see the double-post guard: before step 44, open the same
    review in a second browser tab. After posting in the first tab, tick and
    post in the second. It must refuse with "A reply is already on Google
    for this review..." and post nothing.

## What to tell me

Three things are enough:

- Any step where you saw the wrong company's data. Say the step number.
- Any step where a button did nothing, or something silently sent you
  somewhere else. Say the step number.
- Whether the Posts as line in Part 7 was right every single time.
- Whether you could do a normal session without needing to know internal
  names. That is A26, the only acceptance item nobody else can sign off.

## Why these steps, for reference

The steps above are drawn from the project's own acceptance list
(`2026-09-02-ux-control-center-validation.md`, A01 to A26) and from the work
in `2026-09-02-ux-control-center-handoff.md` marked "not yet Barry-confirmed
live". They are not exhaustive: A05, A06, A08, A13, A14, A15 and A17 cover
existing behaviour that this project was careful not to change, and are
better checked by using the app normally than by a script. Everything listed
here is something that was changed or added.

Part 1 is first because company scoping was the largest class of bug found
(around fifty places), and one of its instances was a real leak in a plugin.
If Part 1 is wrong, nothing else matters.

Steps 16 and 17 are separate on purpose. The difference between "finish
without replying" and "send and finish" is the difference between an internal
note and a message to a customer, and the interface is built so the button
tells you which one you are about to do.

Step 20 cannot be checked in one sitting. The threshold is an hour, because
agents wake on their own schedule and a few minutes of delay is ordinary.

Parts 6 and 7 were added on 2026-09-06 when the two remaining features were
built. Step 44 is the only step in this whole list that writes something the
public can see and that Paperclip cannot undo, which is why it sits last and
why it is written for a review you control. Everything before it in Part 7
is a refusal or a confirm panel, and each of those is a thing the code must
do without you ever reaching Google.
