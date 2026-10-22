#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
check_runtime
# The login item runs this with --login-item. Anything else (the Mac app, a
# terminal) hands the start to the login item when it is loaded, so there is
# only ever one server and launchd watches it.
if [ "${1:-}" != --login-item ] && login_item_loaded; then
  start_login_item
else
  service start
fi
