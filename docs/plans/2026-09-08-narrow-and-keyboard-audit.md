# Narrow widths and keyboard only: what is broken

Audit run 2026-09-08 against the running app at http://localhost:3100 on branch `ux-mockup-shell`,
with the owner's real data. Phase 6 of `docs/plans/2026-09-02-ux-control-center-implementation.md`
asked for this and it had never been done. Nothing was fixed and nothing was committed. No message
was sent, nothing was deleted, no setting was changed, and no message was taken back from an agent.

## How bad is it overall

The desktop layout is in good shape. The overlays behave. The company rail's shortcut panel, which
was the one known keyboard hole, is genuinely fixed: the right arrow key opens it, it takes focus,
Escape closes it and puts focus back on the logo you came from. The scope picker and the search box
do the same. Long company names truncate properly, a lot of pinned workspaces just makes the menu
scroll, and reloading any page brings it back the way you left it.

The phone layout is a different story, and so is keyboard-only use. There are four things that make
something completely unusable, and three of the four are new or newly exposed by this branch. The
worst is that a person using only a keyboard has to press Tab about sixty times through controls
they cannot see before they reach the page, because hiding the sidebar only moves it off screen, it
does not take it out of the keyboard's path. On a phone the fifth button in the bottom bar cannot be
tapped at all, because the round Clippy button sits on top of it. And the Email page has had no
phone layout done to it at all: it still tries to show the desktop two-column view inside 367
pixels.

Sixteen findings. Four make something completely unusable. Six are worth fixing before this ships.
Six are small.

Three of the eight areas I was asked to cover could not be checked at all, for reasons given at the
end: the panel showing an agent holding a message, the take back confirmation, and the plugin page
failure panel. Toasts were measured rather than watched, and I say below exactly how.

---

## Findings, worst first

### 1. On a phone, the last button in the bottom bar cannot be tapped. COMPLETELY UNUSABLE

**Screen:** every page, at phone width. The mobile bottom bar.

**What I did:** set the window to 375 by 667, then asked the browser what element is at the centre
point of each of the five bottom bar buttons.

**What happened:** the first four (Home, Tasks, Create, Agents) answer with themselves. The fifth,
Attention, answers with the round Clippy button. The bottom bar sits at z-index 30 and spans y 602
to 667. The Clippy launcher is fixed at bottom right, z-index 40, and covers x 303 to 351 by y 603
to 651. The Attention button occupies x 291 to 363. They overlap almost exactly, and Clippy is the
higher layer, so every tap on Attention opens Clippy instead.

**What should happen:** all five bottom bar buttons should be tappable. Clippy should sit above the
bar, not on it.

**Size:** small. Move the Clippy launcher up by the height of the bar when the bar is showing, or
put it on the other side.

**Files:** `ui/src/components/ClippyDrawer.tsx` (line 308, `fixed bottom-4 right-4 z-40`) and
`ui/src/components/MobileBottomNav.tsx` (line 116, `z-30`). Both were changed on this branch.

---

### 2. Hiding the sidebar does not take it out of the keyboard's path. COMPLETELY UNUSABLE

**Screen:** the whole app. Worst on a phone, but it happens on the desktop too.

**What I did:** at 375 by 667 with the sidebar drawer closed, I put focus on the page body and
pressed Tab three times for real, recording what received focus each time. Then at 1280 wide I
clicked "Hide sidebar" and counted the controls still inside the collapsed panel.

**What happened:** on the phone, the first Tab reaches the skip link, and the second Tab lands on
the "Portfolio" button in the company rail, which is sitting at x -312, entirely off the left edge
of the screen. Sixty of the eighty-five things you can Tab to on that page are inside the closed
drawer. The drawer is not marked `inert`, it is not `aria-hidden`, and its `visibility` is still
`visible`. It has simply been slid off screen with a transform. So a keyboard user presses Tab about
sixty times, seeing nothing move, before the first real control on the page.

On the desktop the same thing happens in a smaller way. Collapsing the sidebar animates its width to
zero and hides the overflow, but twenty-five controls inside it stay in the tab order at zero width.

**What should happen:** when the sidebar is closed or collapsed, nothing inside it should be
reachable by Tab.

**Size:** small. Put `inert` on the wrapper whenever it is closed, which removes it from the tab
order and from screen readers in one attribute.

**Files:** `ui/src/components/Layout.tsx` (line 381 for the phone drawer, and the
`transition-[width]` wrapper for the desktop sidebar). Changed on this branch.

---

### 3. The phone sidebar drawer does not hold focus and Escape does not close it. COMPLETELY UNUSABLE

**Screen:** the sidebar drawer at phone width.

**What I did:** at 375 by 667 I clicked "Show sidebar", then pressed Tab five times recording each
element that got focus. Then I put focus on the first control inside the drawer and pressed Escape.

**What happened:** three separate problems, one after another.

Opening the drawer leaves focus on the toggle button that opened it. That button lives in the top
bar, which the drawer now covers, so focus is sitting on something invisible. The next Tab does not
go into the drawer. It goes to the scope button, then the Search button, then into the links on the
page behind the drawer, all of which are underneath a dark scrim and cannot be seen. Nothing stops
Tab from walking the whole page under the overlay.

Pressing Escape does nothing. The drawer stays at x 0 with its scrim still up. This is true whether
focus is inside the drawer or outside it.

The only ways out are tapping the scrim, or finding your way back to the toggle button that the
drawer is covering.

**What should happen:** opening the drawer should move focus into it, Tab should stay inside it,
Escape should close it, and closing it should put focus back on the button that opened it.

**Size:** medium. It needs a focus trap and an Escape handler, neither of which the hand rolled
drawer has. The app already has `sheet.tsx`, which is the Radix primitive that does all of this.

**File:** `ui/src/components/Layout.tsx`, around line 372 to 381. Changed on this branch.

---

### 4. On a phone, two of the five email sender actions cannot be reached by finger. COMPLETELY UNUSABLE

**Screen:** the Portfolio Brief, the "Email senders awaiting your call" cards.

**What I did:** set the window to 375 by 667, opened `/HQ/portfolio-brief`, and measured where each
of the five action buttons sits and which parent cuts it off.

**What happened:** each card is 333 pixels wide with `overflow-hidden`, and its row of buttons is
481 pixels wide. "Auto-triage", "Keep, read" and "Keep, unread" fit. "Keep, mute" runs from x 355 to
437 and "Dismiss" from 443 to 498, both past the card's right edge at 351. They are cut off with no
scrollbar, no wrap and no other way to see them, so a finger can never reach them.

A keyboard can. Tabbing to "Dismiss" makes the browser scroll the card sideways by 148 pixels and
the button becomes visible. But at that point "Auto-triage" has scrolled off the left, so there is
no state in which all five are on screen, and a touch user cannot cause that scroll at all.

**What should happen:** all five choices should be reachable on a phone. They should wrap onto a
second line, or the row should be scrollable in a way a finger can use.

**Size:** medium. It is a layout change on the card, not a new component.

**Note:** this card is older than this branch, but the branch made it matter more by making the
Portfolio Brief the landing page for the whole portfolio.

---

### 5. The Email page has no phone layout at all

**Screen:** Email, at phone width.

**What I did:** opened `/COB/email` at 375 by 667 and measured every column and every control in the
page header.

**What happened:** the desktop two-column layout is still there, squeezed. The mailbox column is a
fixed 176 pixels and the message list gets the remaining 155. There is no reading pane. Between them
is a 4 pixel wide drag handle with a `col-resize` cursor, which does nothing on a touch screen.

The header rows do not fit the 155 pixel column and spill out of both sides of it:

- The three tabs are drawn from x 173 to 374. Their own container runs 204 to 343 and the message
  column runs 196 to 351. So "All mail" is painted on top of the mailbox folder list (which ends at
  191), and I confirmed by hit test that the tab, not the folder list, is what a tap at x 178 finds.
  "With agents" runs to 374, past the 367 pixel page edge, so its right end is cut by the window.
- The selection strip, once you turn selection on, starts at x 185, again to the left of its own
  column and over the mailbox list.

**What should happen:** below the phone breakpoint the Email page should show one column at a time,
with a way to move between mailbox list, message list and message.

**Size:** large. This is a real responsive pass on the biggest page in the app.

**File:** `ui/src/pages/Email.tsx`. Heavily changed on this branch, though the two-column shell is
older.

---

### 6. Every mailbox row is wider than the column that holds it, at every width

**Screen:** Email, the mailbox and folder list. Not a narrow-width problem. It happens at 1280 too.

**What I did:** measured a mailbox row and the column that clips it, at 375, at 768 and at 1280.

**What happened:** identical at all three. Each row runs from x 344 to 575, and the column clips at
511. So the right 64 pixels of every mailbox and folder row is cut off. Long folder names such as
`INBOX.Brooks Old Emails.Sent Emails` end mid-word, with no ellipsis and no title tooltip.

There is also a small icon button in the "Folders" header sitting at x 559 to 571, which is entirely
outside the visible column. It cannot be clicked at all, and it has no `aria-label`, so a screen
reader announces it as an unnamed button.

**What should happen:** rows should be the width of their column and truncate with an ellipsis. The
header button should be inside the column and should have a name.

**Size:** medium.

**Note:** older than this branch, but worth fixing while the Email page is open.

---

### 7. The back button needs two presses after switching a tab on Work or Team

**Screen:** the Work page and the Team page.

**What I did:** loaded `/COB/work`, which correctly redirects to `/COB/issues`. Clicked the
"Projects" tab, then "Goals", reading `history.state.idx` after each. Then pressed Back and watched
where I landed.

**What happened:** each tab click adds two history entries instead of one. `idx` went from 1 to 3 on
a single click. The first Back press appears to do nothing, because it lands on a duplicate entry
for the page you are already on. The second Back finally moves. The Team page does the same: `idx`
went 0 to 2 on one tab click.

**What should happen:** one tab click, one history entry, one Back press to undo it.

**Size:** small. Something in the tab layout is navigating twice, most likely a redirect firing after
the tab has already pushed.

**Files:** `ui/src/pages/Work.tsx`, `ui/src/pages/Team.tsx`, `ui/src/components/PageTabBar.tsx`. All
new or changed on this branch.

---

### 8. A pile of failure messages can push the oldest one off the top of the screen

**Screen:** the toast messages, anywhere.

**What I did:** read `ToastContext.tsx` and `ToastViewport.tsx`, then built the same markup with the
same classes inside the live page, measured it, and removed it again. See the note at the end about
why I could not make the app raise a real failure.

**What happened:** failures now stay until you close them, and the app keeps up to five messages at
once. Five failures with a two line body each come to 602 pixels tall. The container is pinned to the
bottom of the window with no maximum height and no scrolling, so on a 600 pixel tall window the
oldest message sits at y -14, above the top of the screen, and its close button cannot be reached.
Since failures never go away on their own, the only way to clear it is to close the four below it
first, which is not obvious.

The same stack also sits over the company rail and most of the sidebar, because the container starts
12 pixels from the left edge.

At a 800 pixel tall window five messages fit, so this needs a short window or long error text. Both
are ordinary.

**What should happen:** the stack should have a maximum height and scroll inside it, or the container
should cap what it shows and say how many more there are.

**Size:** small.

**File:** `ui/src/components/ToastViewport.tsx`. Changed on this branch.

---

### 9. Toast messages are cut off on the right on a phone

**Screen:** the toast messages, at phone width.

**What I did:** measured the toast container at 375 by 667.

**What happened:** the container is `left-3 w-full max-w-sm`. `w-full` means the full width of the
page, 367 pixels, and it starts 12 pixels in, so its right edge lands at 379 against a 367 pixel
page. Twelve pixels of every message, including part of the close button, is off the screen.

**What should happen:** the container should be inset from both sides on a phone.

**Size:** tiny. One class.

**File:** `ui/src/components/ToastViewport.tsx`.

---

### 10. On a phone the top bar never tells you which page you are on

**Screen:** the top bar, at phone width.

**What I did:** measured every control in the top bar at 375 by 667 on `/COB/issues`. Then I
temporarily replaced the company name in the page with a very long one, measured again, and put the
original text back.

**What happened:** the page title is an `h1` with `min-w-0 truncate`, and it measures exactly 0
pixels wide. It is squeezed out completely by the scope button beside it, so a phone user sees the
company name and nothing else. There is no other page heading on most pages.

The scope button itself is cut too. It is 147 pixels wide inside a 140 pixel box with
`overflow-hidden`, so its right edge is shaved. With a long company name it is cut mid-word at the
same 140 pixels, with no ellipsis, because the button grows instead of the text truncating inside it.
The full name is still in the button's `aria-label`, so screen readers are fine; it is only the
visible text that is chopped.

At desktop widths both truncate correctly, so this is a narrow-width problem only.

**What should happen:** at phone width, show the page name. Dropping the scope text to just the
company initials, or putting the page name on its own line, would both do it.

**Size:** small.

**File:** `ui/src/components/BreadcrumbBar.tsx`. New on this branch.

---

### 11. On a phone the Work and Team tabs become a dropdown with no name

**Screen:** Work and Team, at phone width.

**What I did:** opened `/COB/work` and `/COB/team` at 375 and inspected the control that replaces the
tab strip.

**What happened:** `PageTabBar` swaps the tab strip for a plain HTML `<select>`. On Work it holds
Tasks, Projects, Goals, Automations and Intake queues; on Team it holds Right now, Agents, Org chart
and Assistants. The `<select>` has no `aria-label`, no `id` and no `<label>` pointing at it, so a
screen reader announces it as a combo box with no name, and there is no visible heading nearby saying
what it changes.

**What should happen:** give it an accessible name, for example "Work section" and "Team section".

**Size:** tiny. One attribute.

**File:** `ui/src/components/PageTabBar.tsx`, lines 20 to 32.

---

### 12. Closing the search box or the Clippy drawer drops focus at the top of the page

**Screen:** the search box and the Clippy drawer, at any width.

**What I did:** opened each one, pressed Escape, and read which element had focus afterwards.

**What happened:** both close correctly, but focus ends up on the outer page wrapper rather than on
the button that opened them. Pressing Tab then restarts from the very top of the document. On a
phone that means walking the sixty off-screen sidebar controls from finding 2 all over again.

For the search box the cause is clear: the Search button in the top bar does not own the dialog, it
fires a made-up Ctrl+K key event so the command palette picks it up. Radix therefore has no trigger
to hand focus back to.

For comparison, the scope picker, the rail's shortcut panel and the sidebar help popovers all do
return focus to their trigger, so the app clearly knows how.

**What should happen:** closing either one should put focus back on the button that opened it.

**Size:** small.

**Files:** `ui/src/components/BreadcrumbBar.tsx` (around line 327),
`ui/src/components/ClippyDrawer.tsx`.

---

### 13. The Clippy button can be clicked through the sidebar drawer's scrim

**Screen:** phone width, with the sidebar drawer open.

**What I did:** opened the drawer at 375 and asked what element is at x 330, y 627, which is in the
strip of scrim to the right of the drawer.

**What happened:** it answers with the Clippy button. The scrim and the Clippy button are both at
z-index 40, and the button wins because it comes later in the document. So a second overlay can be
opened on top of the drawer.

**What should happen:** while the drawer is open, the scrim should be the only thing you can hit
outside it.

**Size:** tiny.

---

### 14. A rail tooltip stays on screen on top of the search dialog

**Screen:** desktop, company rail plus the search box.

**What I did:** put focus on a company logo in the rail so its tooltip showed, then opened the search
box with Ctrl+K.

**What happened:** opening the dialog correctly closes the rail's shortcut panel, so those two do not
fight. But the tooltip stays. Tooltips are z-index 70 and dialogs are z-index 50, so the tooltip
floats above the dimmed overlay while the dialog is modal. It cleared on the next Escape.

**What should happen:** opening a modal dialog should take any open tooltip with it.

**Size:** tiny. Cosmetic only.

**Note:** `ui/src/lib/z-layers.ts` puts tooltips above panels on purpose, for a good reason it
documents. The gap is that dialogs are not on that scale at all.

---

### 15. The focus ring is faint on the dark background

**Screen:** everywhere, on anything built from the shared Button component.

**What I did:** pressed Tab for real and read the applied styles.

**What happened:** the ring is there and it works. It is a 3 pixel box shadow in
`oklch(0.65 0 0)` at 50 per cent, which over the dark surface comes out around a mid grey. By my
rough arithmetic that is near 2.5 to 1 against the surrounding background, and a focus indicator is
meant to be at least 3 to 1.

I want to be honest that I calculated this rather than measured it with a contrast tool, so treat
the number as approximate. The ring is real and visible; the question is only whether it is strong
enough.

**What should happen:** worth checking with a proper contrast check and lifting the ring if it comes
out under 3 to 1.

**Size:** tiny.

**File:** `ui/src/components/ui/button.tsx`, line 8.

---

### 16. A plugin page makes the whole app scroll sideways on a phone

**Screen:** the Phone Wallboard plugin page, at phone width. Older than this branch, and in the
plugin rather than the shell.

**What I did:** opened `/COB/phone-wallboard` at 375 by 667.

**What happened:** the page's panels have fixed widths that do not fit. The document's scroll width
comes out at 392 against a 367 pixel page, so the whole app including the top bar can be dragged
sideways. The plugin page loaded fine otherwise.

**What should happen:** plugin pages should not force the shell to scroll sideways. It may be worth a
rule that the shell clips horizontally so one bad plugin cannot do this.

**Size:** unknown, it is in the extensions repo, not here.

---

## What works, so nobody re-checks it

- **The company rail's shortcut panel is properly fixed.** Focus a logo, press the right arrow key:
  the panel opens, takes focus, is fully opaque, sits at z-index 60, and Escape closes it and puts
  focus back on the logo. This only happens when the wide menu is collapsed, which is the intended
  design.
- **The scope picker** opens, fits inside a 375 pixel screen, is opaque, and Escape returns focus to
  the button that opened it.
- **The search box** fits at 375, is opaque over its own dark overlay, puts focus in the input, and
  twenty-six results scroll inside it without overflowing. Only the focus-on-close is wrong, see
  finding 12.
- **The sidebar help popovers** (the little question marks) are opaque and return focus correctly.
- **The Everything page** is clean at both 375 and 1280, shows both settings groups, and its bottom
  padding clears the phone bottom bar so nothing is hidden behind it.
- **Long company names** truncate correctly in the sidebar and in the scope button at desktop widths.
- **A lot of pinned workspaces** is handled. With eleven pins in a 600 pixel tall window, both the
  menu and the company rail scroll, and nothing becomes unreachable.
- **Reloading works.** Work, Team, Email and Everything all come back the same after a full reload.
  The collapsed sidebar and the chosen Email tab both survive.
- **The back button after switching company** correctly returns you to the previous company on the
  same page. Switching company keeps you on the page you were on, as intended.
- **The selection strip with fifty messages selected** wraps cleanly at desktop and stays intact,
  though cramped, at 375.

---

## What I could not check, and why

**The panel showing an agent holding a message, and the take back confirmation.** No company in this
instance currently has an email held by an agent. The "With agents" tab says "No agent is holding
any mail right now" in both Company B and Company A, and the other companies have no mail
handed over either. To create one I would have to hand an email to an agent, which is exactly the
kind of outward action I was told not to take. If someone wants this checked, hand one test message
to an agent in a company that does not matter, then re-run this audit on that panel and its
confirmation step.

**The plugin page failure panel added today.** Every installed plugin loads correctly, so the panel
never renders. The only way to see it is to break a plugin on purpose, which would mean changing
files outside the report. What I can say from reading the code is that it uses `role="alert"` and a
`data-testid` of `plugin-load-failure`, and it lives in `ui/src/plugins/slots.tsx` at line 855.

**Toasts as they really appear.** I could not make the app raise a toast without doing something that
changes data or sends something outward. So instead I read the two files that build them, then
created the same markup with the same classes inside the live page, measured it, and removed it
again. The geometry in findings 8 and 9 is real measurement of the real classes, but it is not a
screenshot of a live message. The behaviour I did read straight from the code: failures now have no
time limit, the app keeps at most five messages at once, and when it has to drop one it drops the
oldest one that was going to fade rather than a failure.

**Anything behind a destructive or outward button.** Taking a message back from an agent, pressing
Update or Rebuild, accepting or rejecting a plan, sending an email, and restarting the server were
all off limits, so none of the screens that only appear after those actions were seen.

---

## How I tested

Window sizes used: 375 by 667 (phone), 768 by 700 (just above the point where the app switches
layouts), 1280 by 800 and 1280 by 600. The app switches between the phone and desktop shells in
JavaScript at 768 pixels, in `ui/src/context/SidebarContext.tsx`, not with a CSS breakpoint, so 767
and 768 are the two widths that matter most.

Keyboard tests used real key presses, not scripted focus calls, because the two do not always give
the same answer. I checked one finding, about the focus ring, both ways and the scripted version was
wrong, so everything about focus in this report comes from real Tab and Escape presses.

Overflow and overlap were found by asking the browser for the position of every button and link on
each page and comparing it against the box that clips it, and by asking what element sits at a given
point on screen.
