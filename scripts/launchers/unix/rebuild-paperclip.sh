#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
# --check runs only the checks, so the Settings UI can show a refusal before
# anything has stopped.
[ "${1:-}" = --check ] || watch_unattended_run rebuild
check_build_tools
[ "${1:-}" != --check ] || exit 0
backup_existing
service stop
cold_backup_if_needed
pnpm install --no-frozen-lockfile
pnpm build:runtime
configure_database
record_install
start_after_maintenance
