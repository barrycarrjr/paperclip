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
record_previous_commit
git merge --ff-only origin/master
# Nothing is migrated yet, so a failure here returns to the rollback point
# rather than leave the new files to migrate the database when started.
pnpm install --no-frozen-lockfile || roll_back_before_migrate 'Installing the new version failed' 'pnpm install'
pnpm build:runtime || roll_back_before_migrate 'Building the new version failed' 'pnpm build:runtime'
configure_database
# Start the new version once before the real relaunch; roll back if it fails.
trial_start_or_roll_back
# Refresh install.json (which also ends this update's rollback point) and keep
# only the newest cold database copies.
record_update_install
start_after_maintenance
