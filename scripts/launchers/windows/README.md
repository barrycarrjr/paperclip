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
  *Open Paperclip*, *Update*, *Rebuild from local*, *Restart*, *Open logs
  folder*, *Documentation*, *Shut down Paperclip*, and *Quit launcher (keep
  server running)*. Update/Rebuild open a visible console window so you can
  watch the build run, same as the browser flow.

  Single-instance: re-running `paperclip.exe` while the tray is up just
  opens the browser instead of stacking trays.

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
  embedded postgres and any zombie dev-runner children. Works regardless of
  which launcher started it. Leaves your data dir alone.
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
  marker, gives you a 5-second cancel before the auto-restart kicks in.

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

## Where things live

| What | Path |
|---|---|
| Paperclip source | `<wherever-you-cloned>\` |
| Install marker | `%USERPROFILE%\.paperclip\install.json` |
| Paperclip data | `%USERPROFILE%\.paperclip\instances\default\` |
| Backups (manual) | `%USERPROFILE%\paperclip-backups\paperclip-<timestamp>\` |
| Backups (auto, hourly) | `%USERPROFILE%\.paperclip\instances\default\data\backups\` |
| Server logs (in-app) | `%USERPROFILE%\.paperclip\instances\default\logs\` |
| Launcher logs (paperclip.exe) | `%USERPROFILE%\.paperclip\logs\paperclip-YYYYMMDD.log` |

The install marker (`install.json`) records `repoPath`, `remote`,
`branch`, `commit`, `installedAt`, and `lastUpdated`. It's the single
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
