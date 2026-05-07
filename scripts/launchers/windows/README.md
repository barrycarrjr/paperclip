# Windows launchers

Double-click scripts for installing, updating, and running paperclip on
Windows. They live inside the repo and self-locate, so they work from
wherever you cloned this — no path edits needed.

## Files

### Daily use

- **`launch-paperclip.bat`** — Start the paperclip server. Double-click. Runs
  whatever branch is currently checked out. Server comes up at
  http://localhost:3100/. If something is already listening on 3100, prints a
  friendly "already running" message and exits without spawning a duplicate.
- **`stop-paperclip.bat`** — Kill the running paperclip server, including
  embedded postgres and any zombie dev-runner children. Leaves your data dir
  alone.
- **`backup-data.bat`** — Snapshot `%USERPROFILE%\.paperclip\` to a timestamped
  folder under `%USERPROFILE%\paperclip-backups\`. Run before risky operations
  (upgrades, migrations, schema changes).

### Setup & maintenance

- **`install-paperclip.bat`** — Run **once after `git clone`**. Idempotent.
  Does `pnpm install` → `pnpm build` → migrations (or `paperclipai onboard`
  on a truly fresh box) → records the install location at
  `%USERPROFILE%\.paperclip\install.json`. Re-running is safe and refreshes
  the marker.
- **`update-paperclip.bat`** — Pull the latest from `origin/master`,
  rebuild, run new migrations, and auto-restart. Stops the server first,
  reinstalls only if `pnpm-lock.yaml` changed, refreshes the install
  marker, gives you a 5-second cancel before the auto-restart kicks in.
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
scripts\launchers\windows\launch-paperclip.bat
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
| Server logs | `%USERPROFILE%\.paperclip\instances\default\logs\` |

The install marker (`install.json`) records `repoPath`, `remote`,
`branch`, `commit`, `installedAt`, and `lastUpdated`. It's the single
source of truth for "where is paperclip installed on this machine" and
is rewritten by `install-paperclip.bat` and `update-paperclip.bat`.

## Troubleshooting

- **Server hangs on startup with "database system is starting up"** — known
  bug in `pnpm dev`. Use `launch-paperclip.bat` (which uses `paperclipai run`)
  instead; it sequences postgres + server correctly.
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
