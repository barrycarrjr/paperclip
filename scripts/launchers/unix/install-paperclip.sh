#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
check_build_tools
printf 'Installing Paperclip from %s\nData home: %s\n' "$PAPERCLIP_SRC" "$PAPERCLIP_HOME"
pnpm install --no-frozen-lockfile
backup_existing
service stop
cold_backup_if_needed
pnpm build:runtime
configure_database
record_install
printf 'Installed. Start with scripts/launchers/unix/launch-paperclip.sh\n'
