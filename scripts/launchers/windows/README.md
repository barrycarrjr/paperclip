# Windows launchers

Double-click scripts for running paperclip on Windows. They live inside the
repo and self-locate, so they work from wherever you cloned this — no path
edits needed.

## Files

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

## First-time setup

1. Clone the repo to wherever you want (commonly `%USERPROFILE%\paperclip\`).
2. From the repo root, run `pnpm install`.
3. Double-click `scripts\launchers\windows\launch-paperclip.bat`.

The launchers compute the repo location from their own path, so you can clone
anywhere — `C:\dev\paperclip`, `D:\code\paperclip`, etc. Only requirement is
that `scripts\launchers\windows\` stays in its expected location relative to
the repo root.

## Where things live

| What | Path |
|---|---|
| Paperclip source | `<wherever-you-cloned>\` |
| Paperclip data | `%USERPROFILE%\.paperclip\instances\default\` |
| Backups (manual) | `%USERPROFILE%\paperclip-backups\paperclip-<timestamp>\` |
| Backups (auto, hourly) | `%USERPROFILE%\.paperclip\instances\default\data\backups\` |
| Server logs | `%USERPROFILE%\.paperclip\instances\default\logs\` |

## Troubleshooting

- **Server hangs on startup with "database system is starting up"** — known
  bug in `pnpm dev`. Use `launch-paperclip.bat` (which uses `paperclipai run`)
  instead; it sequences postgres + server correctly.
- **Port 3100 in use** — run `stop-paperclip.bat`, then launch again.
- **Data dir got corrupted** — restore from `backup-data.bat`'s most recent
  snapshot, OR from the auto-hourly postgres backup at
  `%USERPROFILE%\.paperclip\instances\default\data\backups\`.
