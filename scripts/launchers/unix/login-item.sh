#!/usr/bin/env bash
# Start Paperclip at login on macOS: login-item.sh on | off | status
#
# "on" writes a per-user LaunchAgent that runs launch-paperclip.sh at login
# and loads it now. launchd starts the server again when it exits without
# being asked to (a crash); stop-paperclip.sh stops it until the next login or
# start. Restart, update, rebuild and the Mac app start it through launchd.
# "off" removes the file but leaves the job loaded until you log out, because
# unloading it would stop the server it started.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

[ "$(uname -s)" = Darwin ] || fail 'Start at login is only available on macOS. On Linux, start launch-paperclip.sh from your desktop session or a systemd user unit.'

# One login item per installation, so two instances can each have their own.
LABEL="$(login_item_label)"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
LAUNCH_SCRIPT="$PAPERCLIP_SRC/scripts/launchers/unix/launch-paperclip.sh"
LOG="$(login_item_log)"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# A PORT or LANG set when it is turned on is kept too.
optional_entries() {
  local name
  for name in PORT LANG; do
    [ -n "${!name:-}" ] || continue
    printf '\n    <key>%s</key>\n    <string>%s</string>' "$name" "$(xml "${!name}")"
  done
}

write_plist() {
  local tmp
  mkdir -p "$AGENT_DIR"
  tmp="$(mktemp "$AGENT_DIR/.$LABEL.XXXXXX")"
  # launchd starts jobs with a bare PATH, so keep the one that finds node and
  # pnpm now. Each start appends to the log, so a crash can still be read
  # after the restart; past 5 MB it moves to login-item.log.1.
  cat > "$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>mkdir -p "\$(dirname "\$1")"; [ ! -f "\$1" ] || [ "\$(stat -f %z "\$1")" -lt 5000000 ] || mv -f "\$1" "\$1.1"; exec &gt;&gt;"\$1" 2&gt;&amp;1; printf '\\n--- %s\\n' "\$(date)"; exec /bin/bash "\$2" --login-item</string>
    <string>paperclip-login</string>
    <string>$(xml "$LOG")</string>
    <string>$(xml "$LAUNCH_SCRIPT")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml "$PATH")</string>
    <key>PAPERCLIP_HOME</key>
    <string>$(xml "$PAPERCLIP_HOME")</string>
    <key>PAPERCLIP_INSTANCE_ID</key>
    <string>$(xml "$PAPERCLIP_INSTANCE_ID")</string>
    <key>PAPERCLIP_CONFIG</key>
    <string>$(xml "$PAPERCLIP_CONFIG")</string>$(optional_entries)
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
EOF
  if ! plutil -lint -s "$tmp" >/dev/null; then
    rm -f "$tmp"
    fail 'Could not write a valid login item.'
  fi
  mv -f "$tmp" "$PLIST"
}

# Prints the launch script the installed login item runs, or nothing.
installed_script() {
  [ -f "$PLIST" ] || return 0
  plutil -extract ProgramArguments.5 raw -o - "$PLIST" 2>/dev/null || true
}

case "${1:-status}" in
  on)
    check_runtime
    write_plist
    printf 'Paperclip will start when you log in, and again if it crashes.\nLogin item: %s\nLog: %s\n' "$PLIST" "$LOG"
    # Loading it starts launch-paperclip.sh, which leaves a running server
    # alone. A job loaded earlier keeps its old settings until you log out.
    if login_item_loaded; then
      printf 'It was already loaded; changed settings apply from the next login.\n'
    else
      launchctl bootstrap "gui/$(id -u)" "$PLIST" || fail 'The login item was written but could not be loaded. It will load at the next login.'
    fi
    ;;
  off)
    # Unloading the job now would also stop a server it started, so it is
    # left loaded (and still restarts after a crash) until you log out.
    if [ -f "$PLIST" ]; then
      rm -f "$PLIST"
      printf 'Paperclip will no longer start when you log in. A server that is running keeps running until you log out.\n'
    else
      printf 'Start at login was already off.\n'
    fi
    ;;
  status)
    script="$(installed_script)"
    if [ ! -f "$PLIST" ]; then
      printf 'Start at login is off.\n'
    elif [ "$script" = "$LAUNCH_SCRIPT" ]; then
      printf 'Start at login is on.\nLogin item: %s\nLog: %s\n' "$PLIST" "$LOG"
      login_item_loaded && printf 'Loaded now: yes\n' || printf 'Loaded now: no (it loads at the next login)\n'
    else
      printf 'Start at login is on, but it starts another checkout: %s\nRun "%s on" to point it at this one.\n' \
        "${script:-unknown}" "$0"
    fi
    ;;
  *)
    fail 'Usage: login-item.sh on | off | status'
    ;;
esac
