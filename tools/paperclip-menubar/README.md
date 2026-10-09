# paperclip-menubar

Menu-bar helper for paperclip on macOS, the Mac counterpart of the Windows
tray in [`../paperclip-launcher`](../paperclip-launcher).

## What it does

1. **Menu-bar icon** with a status line (running / stopped, from
   `GET /api/health`) and Open Paperclip, Start, Stop, Restart, Open logs
   folder, and Quit. No Dock icon.
2. **Start / Stop / Restart** run the same scripts as the Terminal launchers,
   `scripts/launchers/unix/launch-paperclip.sh` and `stop-paperclip.sh`,
   through the user's login shell so `node` and `pnpm` resolve as they do in
   Terminal. Output is appended to `$PAPERCLIP_HOME/logs/paperclip-YYYYMMDD.log`.
   The server runs in its own process group, so quitting the helper leaves it
   running.
3. **Reminder notifications.** Polls
   `GET /api/internal/desktop-notifications/pending` over loopback every 10
   seconds and shows each reminder as a native notification. Clicking it opens
   the reminder's link inside this instance. A reminder is acknowledged
   (`POST /api/internal/desktop-notifications/ack`) once it is clicked or
   cleared from Notification Center, so it is not lost if the helper quits
   first.
4. **Replaces the background checker.** While it runs, it writes
   `$PAPERCLIP_HOME/menubar.json` (`{"pid", "pollBase"}`).
   `scripts/launchers/unix/desktop-reminders.mjs` reads it and stays quiet for
   the same server, so a reminder is not shown twice. When the helper quits,
   the checker takes over again.

A second launch for the same instance just opens Paperclip in the browser.

## Configuration

Same environment and config as the Unix launchers: `PAPERCLIP_HOME`
(default `~/.paperclip`), `PAPERCLIP_INSTANCE_ID` (default `default`),
`PAPERCLIP_CONFIG`, and `PORT` / `HOST` / the public URL settings that
`desktop-reminders.mjs` reads. The checkout is found from `PAPERCLIP_SRC`,
then the `PaperclipSource` key in the app's `Info.plist`, then the folders
above the executable.

## Building

Needs Rust (`rustup`) and the Xcode command line tools.

```sh
tools/paperclip-menubar/build-app.sh            # -> tools/paperclip-menubar/dist/
tools/paperclip-menubar/build-app.sh ~/Applications
```

The result is `Paperclip Menu Bar.app`, ad-hoc signed. It records the checkout
it was built from, so it can be moved. Open it once; macOS asks whether
Paperclip Menu Bar may send notifications.

Unit tests: `cargo test --manifest-path tools/paperclip-menubar/Cargo.toml`.
