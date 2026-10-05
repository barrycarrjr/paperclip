#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
watch_unattended_run restart
check_runtime
service stop
start_after_maintenance
