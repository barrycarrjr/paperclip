# paperclip-launcher

Rust binary that powers `scripts\launchers\windows\paperclip.exe` — the
hidden-window launcher and system-tray for paperclip on Windows.

## What it does

1. **Single-instance lock** — second double-click while the tray is up
   just opens the browser. (Bound to a fixed loopback port; the OS releases
   it when the launcher exits.)
2. **Spawns the server hidden** if the configured port (default 3100)
   isn't bound. Stdout/stderr append to
   `%USERPROFILE%\.paperclip\logs\paperclip-YYYYMMDD.log`.
3. **Polls the port** for up to 90 seconds. Opens the browser when the
   server binds, or shows a MessageBox pointing at the log if it times out.
4. **Stays in the tray** with a menu that mirrors the browser's
   account-menu lifecycle strip: Open / Update / Rebuild / Restart / Logs /
   Docs / Shut down / Quit launcher.

## Why a native exe?

Windows has two process subsystems: console and GUI. Console-subsystem
processes (powershell.exe, cmd.exe, node.exe) get a console window
allocated — even with `-WindowStyle Hidden` you see a brief flash.
GUI-subsystem processes don't. This binary is built with
`#![windows_subsystem = "windows"]`, so double-clicking from explorer
produces no flash, ever.

## Configuration

The launcher reads `%USERPROFILE%\.paperclip\launcher.json` at startup
(if present). Schema:

```json
{
  "url":      "http://localhost:3100/",
  "port":     3100,
  "docs_url": "https://docs.paperclip.ing/"
}
```

All keys are optional — missing keys fall back to defaults. Env vars
`PAPERCLIP_URL`, `PAPERCLIP_PORT`, and `PAPERCLIP_DOCS_URL` override the
file values for one-off testing without editing the file.

This is what makes the launcher portable: anyone running paperclip on a
non-default port, behind a reverse proxy, or on a custom domain edits one
JSON file — no recompile.

## Rebuilding

Prerequisites:

- **Rust toolchain** — `winget install Rustlang.Rustup`. The
  [`rust-toolchain.toml`](rust-toolchain.toml) in this directory pins to
  `stable-x86_64-pc-windows-gnu`, so cargo auto-installs the right
  components on first run.
- **mingw-w64 toolchain** — `winget install BrechtSanders.WinLibs.POSIX.MSVCRT`.
  Provides `gcc`, `dlltool`, `ld`, etc. that the GNU target's import-lib
  generation needs. (Avoids the ~3 GB Visual Studio Build Tools install.)

Then:

```
tools\paperclip-launcher\build.bat
```

This runs `cargo build --release` and copies the resulting binary to
`scripts\launchers\windows\paperclip.exe`. The build script auto-detects
WinLibs in its default winget install path — restart your shell first if
you just installed it and `gcc` isn't on PATH yet.

## When to rebuild

The launcher is a thin wrapper. It doesn't know or care what paperclip
itself does. Things that DO require a rebuild:

- Adding a tray menu item or changing menu labels.
- Changing built-in defaults (port, URL).
- Adding new config keys.
- Bumping crate dependencies.

Things that DON'T require a rebuild:

- Any change to paperclip's server, ui, plugins, or dependencies.
- Updates pulled via `update-paperclip.bat`.
- Schema migrations.
- Switching the listen URL or port — edit `launcher.json` instead.
