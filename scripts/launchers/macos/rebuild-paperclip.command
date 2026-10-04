#!/bin/bash
set -euo pipefail
# Finder's .command entry point shares the tested macOS/Linux implementation.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec /bin/bash "$SCRIPT_DIR/../unix/rebuild-paperclip.sh" "$@"
