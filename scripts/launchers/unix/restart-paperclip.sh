#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
check_runtime
service stop
service start
