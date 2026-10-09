#!/usr/bin/env bash
set -euo pipefail

# Anchor every operation to this checkout, including paths containing spaces.
PAPERCLIP_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME/.paperclip}"
export PAPERCLIP_INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
export PAPERCLIP_CONFIG="${PAPERCLIP_CONFIG:-$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID/config.json}"
cd "$PAPERCLIP_SRC"

# The Settings UI tells a run it starts where to write its output, because
# nobody is watching a terminal for it. That is also how the helpers below
# know a run is unattended.
if [ -n "${PAPERCLIP_MAINTENANCE_LOG:-}" ]; then
  mkdir -p "$(dirname "$PAPERCLIP_MAINTENANCE_LOG")"
  exec >>"$PAPERCLIP_MAINTENANCE_LOG" 2>&1
fi
unattended_run() { [ -n "${PAPERCLIP_MAINTENANCE_LOG:-}" ]; }

# The last fail() message, so report_unattended_failure can show the reason.
PAPERCLIP_FAILURE=''
# Set when a failure leaves Paperclip in a state the generic wording does not
# describe, such as a rolled-back update that is starting the old version.
PAPERCLIP_FAILURE_STATE=''
fail() { PAPERCLIP_FAILURE="$*"; printf '%s\n' "$*" >&2; exit 1; }
check_runtime() {
  command -v node >/dev/null || fail 'Install Node.js 24.11 or newer first.'
  node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<24 || (major===24 && minor<11)) process.exit(1)' || fail 'Node.js 24.11 or newer is required by the runner.'
  command -v pnpm >/dev/null || fail 'Install pnpm 9.15.4 first: corepack enable && corepack prepare pnpm@9.15.4 --activate'
}
check_build_tools() {
  check_runtime
  command -v git >/dev/null || fail 'Install Git first.'
  command -v cargo >/dev/null || fail 'Install Rust with rustup (https://rustup.rs); the runner pins its compiler version.'
  command -v cc >/dev/null || fail 'Install a C compiler: xcode-select --install on macOS, or build-essential on Debian/Ubuntu.'
}
# Set once a stop succeeds, so a failure report can say whether Paperclip is
# still running.
PAPERCLIP_SERVICE_STOPPED=0
service() {
  pnpm --dir "$PAPERCLIP_SRC" --filter @paperclipai/server exec tsx ../scripts/installed-service.ts "$1"
  if [ "$1" = stop ]; then PAPERCLIP_SERVICE_STOPPED=1; fi
}
# Start the server at the end of a restart, update, or rebuild. A run started
# from the Settings UI has no terminal, so on macOS the server reopens in a
# Terminal window, the way the Paperclip app starts it, where Ctrl-C stops it
# again. A run in a terminal, and every run on Linux, starts it in place.
start_after_maintenance() {
  # The run itself has succeeded. A server started in place exits through this
  # script too, possibly days later, and that is not a failure of this run.
  trap - EXIT
  if unattended_run && [ "$(uname -s)" = Darwin ]; then
    if open_in_terminal; then return 0; fi
    printf 'Could not open Terminal, so Paperclip is starting in the background instead.\n' >&2
  fi
  unset PAPERCLIP_MAINTENANCE_LOG
  service start
}
# Any failure here returns non-zero, so the caller still starts the server.
open_in_terminal() {
  local dir
  mkdir -p "$PAPERCLIP_HOME/launchers" &&
    dir="$(mktemp -d "$PAPERCLIP_HOME/launchers/relaunch.XXXXXX")" &&
    write_relaunch_script "$dir" &&
    open -a Terminal "$dir/relaunch-paperclip.command"
}
# A one-shot script for Terminal that restores this run's environment, which is
# the running server's (the Settings UI passes it down), then starts Paperclip.
# A fresh login shell would drop whatever the old server had that the shell
# does not set: a Claude token pasted on the Adapters page (kept only in the
# server's environment off Windows), a PORT, a node picked with nvm. That
# environment can hold secrets, so the directory is private (mktemp -d) and the
# script deletes it as soon as it starts. The new window sets its own terminal
# variables.
write_relaunch_script() {
  local dir="$1"
  {
    printf '#!/bin/bash\n'
    printf 'rm -rf %q\n' "$dir"
    export -p | grep -Ev '^declare -x (TERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|SHLVL|PWD|OLDPWD|_|COLUMNS|LINES|PAPERCLIP_MAINTENANCE_LOG)(=|$)'
    printf 'exec /bin/bash %q\n' "$PAPERCLIP_SRC/scripts/launchers/unix/launch-paperclip.sh"
  } > "$dir/relaunch-paperclip.command" && chmod 700 "$dir/relaunch-paperclip.command"
}
# Arm the failure alert for an update, rebuild, or restart. Call it before
# anything in the script can fail.
watch_unattended_run() {
  # In an EXIT trap, $BASH_COMMAND is the command that ended the run.
  trap "report_unattended_failure \$? $1 \"\$BASH_COMMAND\"" EXIT
}
# A run started from the Settings UI has no terminal to show its errors in, and
# the browser page goes dead once the server stops. On macOS, show a failure as
# an alert instead of leaving it only in the maintenance log.
report_unattended_failure() {
  local code="$1" action="$2" step="$3" reason state
  [ "$code" -ne 0 ] && unattended_run && [ "$(uname -s)" = Darwin ] || return 0
  reason="${PAPERCLIP_FAILURE:-This step failed: $step.}"
  # A UI restart only runs after the old server has already exited.
  if [ -n "$PAPERCLIP_FAILURE_STATE" ]; then
    state="$PAPERCLIP_FAILURE_STATE"
  elif [ "$action" = restart ]; then
    state='Paperclip is stopped. Open the Paperclip app to start it again.'
  elif [ "$PAPERCLIP_SERVICE_STOPPED" != 1 ]; then
    state='Paperclip is still running the version it had before.'
  else
    state="Paperclip is stopped. Fix the problem, then run rebuild-paperclip.command in $PAPERCLIP_SRC/scripts/launchers/macos."
  fi
  osascript \
    -e 'on run argv' \
    -e 'display alert (item 1 of argv) message (item 2 of argv) as critical' \
    -e 'end run' \
    "Paperclip $action failed" \
    "$reason $state Details are in $PAPERCLIP_MAINTENANCE_LOG." \
    >/dev/null 2>&1 || true
}
# The embedded database runs inside the Paperclip server, so a live backup can
# only connect while the server is up. Call this BEFORE `service stop`. When
# the live backup cannot run (usually because the server is already stopped),
# it records that a cold copy is needed; cold_backup_if_needed takes that copy
# once the server is confirmed stopped.
PAPERCLIP_COLD_BACKUP=0
backup_existing() {
  [ -f "$PAPERCLIP_CONFIG" ] || return 0
  if pnpm --dir "$PAPERCLIP_SRC" paperclipai db:backup --config "$PAPERCLIP_CONFIG"; then
    PAPERCLIP_COLD_BACKUP=0
  else
    printf 'Live backup did not run. A copy of the database directory will be taken once the server is stopped.\n' >&2
    PAPERCLIP_COLD_BACKUP=1
  fi
}
# Prints the embedded data directory, then the backup directory, one per line.
# Prints nothing when the instance uses an external PostgreSQL server.
database_paths() {
  node -e '
    const fs = require("node:fs"), path = require("node:path");
    const configPath = process.argv[1];
    const db = (JSON.parse(fs.readFileSync(configPath, "utf8")).database) || {};
    if (db.mode && db.mode !== "embedded-postgres") process.exit(0);
    const instance = path.dirname(configPath);
    console.log(db.embeddedPostgresDataDir || path.join(instance, "db"));
    console.log((db.backup && db.backup.dir) || path.join(instance, "data", "backups"));
  ' "$PAPERCLIP_CONFIG"
}
# Call this AFTER `service stop`. Copying the data directory is only safe while
# PostgreSQL is not running, so a live postmaster stops the run instead.
cold_backup_if_needed() {
  [ "$PAPERCLIP_COLD_BACKUP" = 1 ] || return 0
  local paths data_dir backup_dir pid dest
  paths="$(database_paths)"
  data_dir="$(printf '%s\n' "$paths" | sed -n 1p)"
  backup_dir="$(printf '%s\n' "$paths" | sed -n 2p)"
  [ -n "$data_dir" ] || fail 'The database backup failed and this instance uses an external PostgreSQL server. Fix the backup before continuing.'
  [ -d "$data_dir" ] || fail "The database backup failed and no database directory was found at $data_dir. Fix the backup before continuing."
  if [ -f "$data_dir/postmaster.pid" ]; then
    pid="$(sed -n 1p "$data_dir/postmaster.pid")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      fail "PostgreSQL is still running (pid $pid) but the live backup failed. Stop it or fix the backup before continuing."
    fi
  fi
  dest="$backup_dir/cold-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$dest"
  cp -R "$data_dir" "$dest/db"
  rm -f "$dest/db/postmaster.pid"
  PAPERCLIP_COLD_BACKUP=0
  printf 'Cold backup saved: %s\n' "$dest"
}
configure_database() {
  if [ -f "$PAPERCLIP_CONFIG" ]; then
    pnpm --dir "$PAPERCLIP_SRC" db:migrate
  else
    # Explicit loopback: a fresh source installation is local by default.
    pnpm --dir "$PAPERCLIP_SRC" paperclipai onboard --yes --setup-only --bind loopback --config "$PAPERCLIP_CONFIG"
    pnpm --dir "$PAPERCLIP_SRC" db:migrate
  fi
}
# CI owns pnpm-lock.yaml (doc/DEVELOPING.md), and the install step runs with
# --no-frozen-lockfile, so pnpm rewrites the lockfile whenever a manifest is
# ahead of the committed copy. That rewrite is generated state, not a local
# edit: restore it so it cannot block an update or a fast-forward merge.
discard_generated_lockfile() {
  if [ -n "$(git status --porcelain -- pnpm-lock.yaml)" ]; then
    git checkout -- pnpm-lock.yaml
  fi
}
record_install() {
  node "$PAPERCLIP_SRC/scripts/launchers/unix/install-metadata.mjs" "$PAPERCLIP_SRC"
}
# Safe update: scripts/launchers/update-guard.mjs holds the logic shared with
# the Windows update. Call record_previous_commit before the checkout moves,
# so a failed trial has a commit to return to.
UPDATE_GUARD="$PAPERCLIP_SRC/scripts/launchers/update-guard.mjs"
# Reports a failed update, starts the version that is now in the checkout
# again, and ends the run with an error. The macOS alert waits for a click, so
# it runs in the background: an unattended run must not keep Paperclip down
# until somebody clicks it.
restart_and_fail() {
  local reason="$1" state="$2" step="$3"
  PAPERCLIP_FAILURE="$reason"
  PAPERCLIP_FAILURE_STATE="$state"
  printf '%s\n' "$PAPERCLIP_FAILURE" >&2
  report_unattended_failure 1 update "$step" </dev/null >/dev/null 2>&1 &
  start_after_maintenance
  exit 1
}
# Install or build of the new version failed after the merge. The database has
# not been migrated, so the checkout goes back to the rollback point and that
# version starts again. If that is not possible the run stops WITHOUT starting
# anything: the new files would migrate the database with no trial.
roll_back_before_migrate() {
  local what="$1" step="$2" code=0
  node "$UPDATE_GUARD" rollback || code=$?
  PAPERCLIP_FAILURE_STATE='Paperclip is stopped. Fix the problem, then run the update again.'
  if [ "$code" -eq 2 ]; then
    fail "$what, and no earlier version is recorded, so it could not be rolled back. Paperclip was not started, because the new files would migrate the database. The reason is in the output above."
  fi
  [ "$code" -eq 0 ] || fail "$what, and rolling back to the previous version also failed. Paperclip was not started, because the files in the checkout could migrate the database. The reason is in the output above."
  restart_and_fail \
    "$what, so the update was rolled back to the previous version. The reason is in the output above." \
    'Paperclip is starting the previous version again.' \
    "$step"
}
# Nothing has changed yet when this runs, so if the rollback point cannot be
# recorded the update stops and the version that was running starts again.
record_previous_commit() {
  node "$UPDATE_GUARD" record-previous && return 0
  restart_and_fail \
    'Could not record the version to return to, so the update stopped before changing anything. The reason is in the output above.' \
    'Paperclip is starting the version it had before.' \
    'recording the rollback point'
}
# After a passing trial. The new version is healthy, so a failure to refresh
# install.json is reported but does not stop the relaunch. Until a later run
# refreshes it, the next update cannot roll back automatically: update-guard
# refuses a rollback point that does not match install.json.
record_update_install() {
  if ! record_install; then
    printf '%s\n' 'Warning: the update worked, but the install record (install.json) could not be refreshed. The next update will not be able to roll back automatically until an update or rebuild refreshes it.' >&2
  fi
  node "$UPDATE_GUARD" prune-cold-backups ||
    printf '%s\n' 'Warning: old cold database copies could not be removed. They are in the backup folder as cold-* folders.' >&2
}
# Call after build and migrate, before record_update_install. Starts the new
# version once the way `service start` does and waits for /api/health. On success it
# returns and the update carries on. On failure it rolls the checkout back to
# the recorded commit (git reset --keep), reinstalls and rebuilds it, reports
# the failure, starts the previous version, and ends the run with an error.
# Migrations are not run down and the database is not restored.
trial_start_or_roll_back() {
  local code=0
  node "$UPDATE_GUARD" trial-start --launcher unix || code=$?
  # The trial stops its own server. This also stops one the trial left
  # registered if its stop was cut short; it prints nothing useful otherwise.
  service stop >/dev/null || true
  [ "$code" -ne 0 ] || return 0
  code=0
  node "$UPDATE_GUARD" rollback || code=$?
  if [ "$code" -eq 2 ]; then
    fail 'The updated Paperclip did not start, and no earlier version is recorded, so it could not be rolled back. The reason is in the output above.'
  fi
  [ "$code" -eq 0 ] || fail 'The updated Paperclip did not start, and rolling back to the previous version also failed. The reason is in the output above.'
  restart_and_fail \
    'The updated Paperclip did not start, so the update was rolled back to the previous version.' \
    'Paperclip is starting the previous version again.' \
    'trial start'
}
