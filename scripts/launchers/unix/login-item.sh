#!/usr/bin/env bash
# Start Paperclip at login on macOS: login-item.sh on | off | status
#
# "on" writes a per-user LaunchAgent that runs launch-paperclip.sh once when
# you log in. It is not kept alive, so stop-paperclip.sh stops the server and
# it stays stopped until the next login, and an update or rebuild stops and
# starts it the way it does a server started from the app. Turning it on or
# off does not start or stop the server that is running now.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

[ "$(uname -s)" = Darwin ] || fail 'Start at login is only available on macOS. On Linux, start launch-paperclip.sh from your desktop session or a systemd user unit.'

# One login item per installation, so two instances can each have their own.
LABEL="com.paperclip.login.$(printf '%s' "$PAPERCLIP_CONFIG" | shasum -a 256 | cut -c1-12)"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
LAUNCH_SCRIPT="$PAPERCLIP_SRC/scripts/launchers/unix/launch-paperclip.sh"
LOG="$PAPERCLIP_HOME/logs/login-item.log"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# A PORT set when it is turned on is kept too.
port_entry() {
  [ -n "${PORT:-}" ] || return 0
  printf '\n    <key>PORT</key>\n    <string>%s</string>' "$(xml "$PORT")"
}

write_plist() {
  local tmp
  mkdir -p "$AGENT_DIR"
  tmp="$(mktemp "$AGENT_DIR/.$LABEL.XXXXXX")"
  # launchd starts jobs with a bare PATH, so keep the one that finds node and
  # pnpm now. The log is replaced at each login so it cannot grow forever.
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
    <string>mkdir -p "\$(dirname "\$1")" &amp;&amp; exec &gt;"\$1" 2&gt;&amp;1; exec /bin/bash "\$2"</string>
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
    <string>$(xml "$PAPERCLIP_CONFIG")</string>$(port_entry)
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
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
    printf 'Paperclip will start when you log in.\nLogin item: %s\nLog: %s\n' "$PLIST" "$LOG"
    ;;
  off)
    # The file is only read at login. Unloading the job now would also stop a
    # server it started, so it is left loaded until you log out.
    if [ -f "$PLIST" ]; then
      rm -f "$PLIST"
      printf 'Paperclip will no longer start when you log in. A server that is running keeps running.\n'
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
    else
      printf 'Start at login is on, but it starts another checkout: %s\nRun "%s on" to point it at this one.\n' \
        "${script:-unknown}" "$0"
    fi
    ;;
  *)
    fail 'Usage: login-item.sh on | off | status'
    ;;
esac
