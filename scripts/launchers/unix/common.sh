#!/usr/bin/env bash
set -euo pipefail

# Anchor every operation to this checkout, including paths containing spaces.
PAPERCLIP_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME/.paperclip}"
export PAPERCLIP_INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
export PAPERCLIP_CONFIG="${PAPERCLIP_CONFIG:-$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID/config.json}"
cd "$PAPERCLIP_SRC"

fail() { printf '%s\n' "$*" >&2; exit 1; }
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
service() {
  pnpm --dir "$PAPERCLIP_SRC" --filter @paperclipai/server exec tsx ../scripts/installed-service.ts "$1"
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
