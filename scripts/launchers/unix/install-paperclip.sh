#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
check_build_tools
printf 'Installing Paperclip from %s\nData home: %s\n' "$PAPERCLIP_SRC" "$PAPERCLIP_HOME"
pnpm install --no-frozen-lockfile
service stop
backup_existing
pnpm build:runtime
configure_database
record_install
printf 'Installed. Start with scripts/launchers/unix/launch-paperclip.sh\n'
