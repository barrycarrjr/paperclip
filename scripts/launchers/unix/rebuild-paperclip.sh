#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
check_build_tools
service stop
backup_existing
pnpm install --no-frozen-lockfile
pnpm build:runtime
configure_database
record_install
service start
