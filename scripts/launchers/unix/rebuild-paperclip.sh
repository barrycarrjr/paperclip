#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
check_build_tools
backup_existing
service stop
cold_backup_if_needed
pnpm install --no-frozen-lockfile
pnpm build:runtime
configure_database
record_install
service start
