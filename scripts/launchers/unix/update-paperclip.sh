#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
# --check runs only the checks, so the Settings UI can show a refusal before
# anything has stopped.
[ "${1:-}" = --check ] || watch_unattended_run update
check_build_tools
discard_generated_lockfile
[ -z "$(git status --porcelain)" ] || fail 'The checkout has local changes. Commit or move them before updating.'
[ "$(git branch --show-current)" = master ] || fail 'Automatic updates require the master branch.'
git fetch origin master
git merge-base --is-ancestor HEAD origin/master || fail 'This checkout is ahead of or diverged from origin/master. Resolve it before updating.'
[ "${1:-}" != --check ] || exit 0
backup_existing
service stop
cold_backup_if_needed
git merge --ff-only origin/master
pnpm install --no-frozen-lockfile
pnpm build:runtime
configure_database
record_install
start_after_maintenance
