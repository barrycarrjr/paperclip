#!/usr/bin/env bash
set -euo pipefail

# Anchor every operation to this checkout, including paths containing spaces.
PAPERCLIP_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME/.paperclip}"
export PAPERCLIP_INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
export PAPERCLIP_CONFIG="${PAPERCLIP_CONFIG:-$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID/config.json}"
cd "$PAPERCLIP_SRC"

fail() { printf '%s\n' "$*" >&2; exit 1; }
check_runtime() {
  command -v node >/dev/null || fail 'Install Node.js 24.11 or newer first.'
  node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<24 || (major===24 && minor<11)) process.exit(1)' || fail 'Node.js 24.11 or newer is required by the runner.'
  command -v pnpm >/dev/null || fail 'Install pnpm 9.15.4 first: corepack enable && corepack prepare pnpm@9.15.4 --activate'
}
check_build_tools() {
  check_runtime
  command -v git >/dev/null || fail 'Install Git first.'
  command -v cargo >/dev/null || fail 'Install Rust with rustup (https://rustup.rs); the runner pins its compiler version.'
  command -v cc >/dev/null || fail 'Install a C compiler: xcode-select --install on macOS, or build-essential on Debian/Ubuntu.'
}
service() {
  pnpm --dir "$PAPERCLIP_SRC" --filter @paperclipai/server exec tsx ../scripts/installed-service.ts "$1"
}
backup_existing() {
  if [ -f "$PAPERCLIP_CONFIG" ]; then
    pnpm --dir "$PAPERCLIP_SRC" paperclipai db:backup --config "$PAPERCLIP_CONFIG"
  fi
}
configure_database() {
  if [ -f "$PAPERCLIP_CONFIG" ]; then
    pnpm --dir "$PAPERCLIP_SRC" db:migrate
  else
    # Explicit loopback: a fresh source installation is local by default.
    pnpm --dir "$PAPERCLIP_SRC" paperclipai onboard --yes --setup-only --bind loopback --config "$PAPERCLIP_CONFIG"
    pnpm --dir "$PAPERCLIP_SRC" db:migrate
  fi
}
# CI owns pnpm-lock.yaml (doc/DEVELOPING.md), and the install step runs with
# --no-frozen-lockfile, so pnpm rewrites the lockfile whenever a manifest is
# ahead of the committed copy. That rewrite is generated state, not a local
# edit: restore it so it cannot block an update or a fast-forward merge.
discard_generated_lockfile() {
  if [ -n "$(git status --porcelain -- pnpm-lock.yaml)" ]; then
    git checkout -- pnpm-lock.yaml
  fi
}
record_install() {
  node "$PAPERCLIP_SRC/scripts/launchers/unix/install-metadata.mjs" "$PAPERCLIP_SRC"
}
