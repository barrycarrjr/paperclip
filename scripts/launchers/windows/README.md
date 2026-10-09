# Windows launchers

Double-click scripts for installing, updating, and running paperclip on
Windows. They live inside the repo and self-locate, so they work from
wherever you cloned this — no path edits needed.

## Files

### Daily use

- **`paperclip.exe`** — **Recommended everyday launcher.** Double-click to
  start paperclip in the background — no terminal window stays open on the
  desktop. The browser opens to http://localhost:3100/ once the server is
  bound. If the server's already up, just opens the browser. Logs go to
  `%USERPROFILE%\.paperclip\logs\paperclip-YYYYMMDD.log` (one file per day);
  tail it when you need to see what the server is doing.

  After launch, a paperclip icon lives in your system tray. Right-click for
  the menu — same lifecycle actions as the browser's account-menu strip:
  *Open Paperclip*, *Update*, *Rebuild from local*, *Restart*, *Repair blank
  screen*, *Open logs folder*, *Documentation*, *Start with Windows*, and
  *Shut down Paperclip*. The checked **Start with Windows** item registers the
  launcher for the current Windows user; startup launches remain in the tray
  without opening a browser tab. Uncheck it to remove the startup entry.
  Update/Rebuild open a visible console window so you can watch the build run,
  same as the browser flow.

  The launcher validates Vite's generated dependency cache before every server
  start. If the cache references a missing JavaScript chunk, it clears only
  those generated files and rotates the browser cache generation so Vite can
  rebuild without an already-open tab reusing old modules. If the browser is
  ever blank while the server is already running, choose
  **Repair blank screen** from the tray menu; it stops the server, clears the
  generated UI cache, restarts, and opens a cache-busted Paperclip URL. It does
  not touch Paperclip data, configuration, source files, or installed plugins.

  Single-instance: re-running `paperclip.exe` while the tray is up just
  opens the browser instead of stacking trays.

  Restart feedback: choosing *Restart Paperclip* immediately shows a Windows
  notification, then reports success when the configured port is healthy
  again. A restart is aborted with a visible error if the old server does not
  release its port; Paperclip will not silently start a duplicate on 3101.

  Source lives at [`tools/paperclip-launcher/`](../../../tools/paperclip-launcher/) —
  Rust binary, GUI subsystem, no console flash. Rebuild via
  `tools\paperclip-launcher\build.bat` only if you change the launcher
  itself; routine paperclip updates don't require rebuilding it.

#### Configuring the launcher (different URL / port)

The launcher defaults to `http://localhost:3100/` and probes port 3100.
Override these without rebuilding by dropping a JSON file at
`%USERPROFILE%\.paperclip\launcher.json`:

```json
{
  "url":      "http://paperclip.lan:3100/",
  "port":     3100,
  "docs_url": "https://docs.paperclip.ing/"
}
```

All three keys are optional — anything missing falls back to the default.
Useful when running paperclip on a non-default port, behind a reverse
proxy, on a different hostname (LAN access), or when you want the
"Documentation" tray entry to point at internal runbooks.

For one-off testing without editing the file, set environment variables:
`PAPERCLIP_URL`, `PAPERCLIP_PORT`, `PAPERCLIP_DOCS_URL`. Env vars override
the file; the file overrides the built-in defaults.
- **`launch-paperclip.bat`** — Verbose / debugging launcher. Same server, but
  output goes to a visible cmd window so you can watch it live and Ctrl-C it.
  Use this when troubleshooting startup issues or when you want to see
  embedded-postgres + server logs streaming in real time.
- **`stop-paperclip.bat`** — Kill the running paperclip server, including
  embedded postgres, stale fallback-port siblings from this checkout, and any
  zombie dev-runner children. Works regardless of which launcher started it.
  Leaves your data dir alone.
  Update and Rebuild use its internal `-RestartAfterMaintenance` mode after
  stopping. That mode waits for the old tray's single-instance lock to be
  released, launches one replacement, and does not report success until both
  the tray and `/api/health` are back. Maintenance failures also use it, so a
  failed build no longer leaves an otherwise recoverable Paperclip offline.
- **`backup-data.bat`** — Snapshot `%USERPROFILE%\.paperclip\` to a timestamped
  folder under `%USERPROFILE%\paperclip-backups\`. Run before risky operations
  (upgrades, migrations, schema changes).

### Setup & maintenance

- **`install-paperclip.bat`** — Run **once after `git clone`**. Idempotent.
  Does `pnpm install` → `pnpm build:runtime` → migrations (or `paperclipai
  onboard` on a truly fresh box) → records the install location at
  `%USERPROFILE%\.paperclip\install.json`. Re-running is safe and refreshes
  the marker.
- **`update-paperclip.bat`** — Pull the latest from `origin/master`,
  rebuild, run new migrations, and auto-restart. Stops the server first,
  reinstalls only if `pnpm-lock.yaml` changed, refreshes the install
  marker, gives you a 5-second cancel before the auto-restart kicks in, and
  verifies that Paperclip is healthy before declaring the restart complete.
  If an earlier step fails, it preserves the error on screen while attempting
  to restore the server from the files already present.
  Before migrating it copies the stopped database folder to
  `instances\default\data\backups\cold-<timestamp>\` (a successful update
  keeps only the newest two of these). After migrating it
  starts the new version once as a trial, exactly the way `paperclip.exe`
  does, and waits for `/api/health` (120 seconds by default; set
  `PAPERCLIP_UPDATE_TRIAL_TIMEOUT_SECONDS` to change it). If the trial does
  not become healthy, the update prints the reason and the server's last
  output, returns the checkout to the commit that was installed before
  (`git reset --keep`, which refuses rather than discard local edits),
  reinstalls and rebuilds it, starts that version, and leaves the console
  open with the error. Migrations are not undone and the database is not
  restored; the backup above is there if the old version needs it. See
  [Safe update and rollback](#safe-update-and-rollback).

> **Note on `build:runtime` vs `build`:** the launchers use `pnpm
> build:runtime`, which skips the in-repo plugin packages
> (`packages/plugins/examples/*`, `paperclip-plugin-fake-sandbox`,
> `create-paperclip-plugin`). Those aren't used at runtime — runtime
> plugins come from `paperclip-extensions` and live under
> `%USERPROFILE%\.paperclip\installed-plugins\`. Use the regular
> `pnpm build` only when you're working on the in-repo plugin examples
> or scaffold themselves.
- **`migrate-from-upstream.bat`** — One-time switch for a clone whose
  `origin` still points at `paperclipai/paperclip`. Backs up your data,
  re-points `origin` to `barrycarrjr/paperclip`, hard-resets to the fork's
  `master`, then chains into `install-paperclip.bat`. Refuses to run if
  `origin` is anything other than upstream.

## First-time setup

```
git clone https://github.com/barrycarrjr/paperclip.git C:\path\of\your\choosing
cd /d C:\path\of\your\choosing
scripts\launchers\windows\install-paperclip.bat
scripts\launchers\windows\paperclip.exe
```

You can clone anywhere — `C:\Users\<you>\paperclip\`, `C:\dev\paperclip`,
`D:\code\paperclip`, etc. The launchers compute the repo location from
their own path and write the chosen location into
`%USERPROFILE%\.paperclip\install.json` so future tooling can find it.

> Requirements: Node.js 22 LTS+, pnpm 9.15+, git.

## If you previously installed upstream paperclipai/paperclip

```
cd /d C:\path\to\your\existing\paperclip\clone
scripts\launchers\windows\migrate-from-upstream.bat
```

The script will back up your data dir, re-point `origin` to the fork,
reset the working tree to `origin/master`, and then run the standard
post-clone install. Local commits on your existing clone will be
discarded — push them somewhere first if you need them.

## Updating

```
scripts\launchers\windows\update-paperclip.bat
```

Or set up a Start Menu / desktop shortcut to it. Safe to run while the
server is up — it stops, updates, and restarts. Cancel the auto-restart
within 5 seconds if you want to manually verify the build before going
live.

### Safe update and rollback

1. The update records the commit that is installed now as `previousCommit`
   in `install.json` (the rollback point). If that cannot be recorded, the
   update stops there and does not start Paperclip, because the new files
   are already in place but not built. Fix the reported problem and run
   the update again; it carries on from where it stopped.
2. It pulls, installs, builds, backs up the database, and migrates. If the
   install, the build or the backup fails, nothing has been migrated yet:
   the checkout goes back to
   `previousCommit` and the previous version is started. With no rollback
   point, or if rolling back fails, the update stops without starting
   anything rather than run the new version on a database it would
   migrate with no backup.
3. It starts the new version once as a trial and waits for `/api/health`.
   The trial runs with `HEARTBEAT_SCHEDULER_ENABLED=false` and
   `PAPERCLIP_PLUGIN_RUNTIME_ENABLED=false`, so it starts no agent runs,
   schedules or plugins that it would abandon when it stops. It checks the
   address the server prints in its `Server listening on` line; until then
   it expects the port from `PORT`, the instance `config.json`,
   `launcher.json`, or 3100, in that order, on the address the server's bind
   settings give. The trial's output goes to
   `%USERPROFILE%\.paperclip\logs\update-trial-<timestamp>.log`.
4. Trial healthy: the trial server is stopped (its own process tree, by
   pid, plus the database processes it started from this checkout) and
   the update carries on. It refreshes `install.json`, which also clears
   `previousCommit`, keeps only the newest two `cold-*` database copies,
   and does the normal restart. If `install.json` cannot be refreshed the
   restart still happens, with a warning: until a later update or rebuild
   refreshes it, the next update cannot roll back automatically.
5. Trial not healthy: the checkout goes back to `previousCommit`, the
   previous version is reinstalled, rebuilt and started, and the console
   window stays open with the reason. The update exits with an error.
6. No rollback point recorded: the failure is reported but nothing can be
   rolled back, and the update tries to start the new version anyway.

A rollback point is only used if it matches the commit `install.json`
says is installed. One left over from an earlier run is refused, because
rolling back to it could skip a release.

Migrations are never run down. If the previous version does not work with
the migrated database, restore the newest backup from
`instances\default\data\backups\`.

The rollback point is the `commit` already in `install.json`, recorded just
after the pull. It is not read before the pull because cmd re-reads a
running .bat by position and the pull replaces the file, so nothing above
the `git pull` line in `update-paperclip.bat` may change size. Keep that in
mind when editing the script. For the same reason, everything from the
rollback to the end of the run is one parenthesised block: the rollback's
`git reset --keep` can replace the running .bat with the previous version's
copy, and cmd reads a whole block before running any of it, so nothing
after the reset is read from the file.

## Where things live

| What | Path |
|---|---|
| Paperclip source | `<wherever-you-cloned>\` |
| Install marker | `%USERPROFILE%\.paperclip\install.json` |
| Paperclip data | `%USERPROFILE%\.paperclip\instances\default\` |
| Backups (manual) | `%USERPROFILE%\paperclip-backups\paperclip-<timestamp>\` |
| Backups (auto, hourly) | `%USERPROFILE%\.paperclip\instances\default\data\backups\` |
| Backups (taken by each update) | `%USERPROFILE%\.paperclip\instances\default\data\backups\cold-<timestamp>\` |
| Update trial output | `%USERPROFILE%\.paperclip\logs\update-trial-<timestamp>.log` |
| Server logs (in-app) | `%USERPROFILE%\.paperclip\instances\default\logs\` |
| Launcher logs (paperclip.exe) | `%USERPROFILE%\.paperclip\logs\paperclip-YYYYMMDD.log` |

The install marker (`install.json`) records `repoPath`, `remote`,
`branch`, `commit`, `installedAt`, `lastUpdated`, and, from the start of an
update until one succeeds, `previousCommit` (the rollback point). It's the single
source of truth for "where is paperclip installed on this machine" and
is rewritten by `install-paperclip.bat` and `update-paperclip.bat`.

## Troubleshooting

- **Server hangs on startup with "database system is starting up"** — known
  bug in `pnpm dev`. Use `paperclip.exe` or `launch-paperclip.bat` (both use
  `paperclipai run`) instead; that path sequences postgres + server correctly.
- **Browser opened but page won't load** — server is still booting. Check
  `%USERPROFILE%\.paperclip\logs\paperclip-<today>.log` (the launcher log)
  and refresh after a few seconds. If the launcher MsgBox said "didn't come
  up within 90 seconds", that log will tell you why.
- **Need to see live server output** — re-launch via `launch-paperclip.bat`
  instead of `paperclip.exe` (after stopping with `stop-paperclip.bat`).
- **Port 3100 in use** — run `stop-paperclip.bat`, then launch again.
- **`update-paperclip.bat` fails on `git pull`** — usually means you have
  local commits or uncommitted changes that conflict with `origin/master`.
  Resolve manually and re-run.
- **Server refuses to start with "pending migrations"** — run
  `pnpm db:migrate` from the repo root, then launch. (Update/install
  scripts already do this; you'll only hit this if launching directly
  after pulling without running update.)
- **Data dir got corrupted** — restore from `backup-data.bat`'s most recent
  snapshot, OR from the auto-hourly postgres backup at
  `%USERPROFILE%\.paperclip\instances\default\data\backups\`.
