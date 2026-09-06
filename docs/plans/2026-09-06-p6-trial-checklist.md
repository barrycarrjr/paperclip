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

## What to tell me

Three things are enough:

- Any step where you saw the wrong company's data. Say the step number.
- Any step where a button did nothing, or something silently sent you
  somewhere else. Say the step number.
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
