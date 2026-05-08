@echo off
REM === Rebuild scripts\launchers\windows\paperclip.exe ===
REM Run from anywhere — script self-locates. Requires:
REM   * Rust toolchain (`rustup` from https://rustup.rs/, or
REM     `winget install Rustlang.Rustup`); after install, this project's
REM     rust-toolchain.toml pins to stable-x86_64-pc-windows-gnu.
REM   * mingw-w64 toolchain. WinLibs is the path of least resistance:
REM     `winget install BrechtSanders.WinLibs.POSIX.MSVCRT`. After install,
REM     either restart your shell to pick up the new PATH, or this script
REM     prepends a few common WinLibs install dirs automatically.
REM
REM Outputs to scripts\launchers\windows\paperclip.exe.

setlocal
title Build Paperclip Launcher

set "SRC_DIR=%~dp0"
set "DEST=%~dp0..\..\scripts\launchers\windows\paperclip.exe"

REM Make sure WinLibs / cargo are findable even in a fresh shell.
REM WinLibs default install path is %LOCALAPPDATA%\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.*\mingw64\bin
REM (winget keeps versioned dirs; we glob just to find the right one).
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\BrechtSanders.WinLibs*") do (
  if exist "%%D\mingw64\bin\gcc.exe" set "PATH=%%D\mingw64\bin;%PATH%"
)
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

echo === Building paperclip.exe ===
echo Source:  %SRC_DIR%
echo Output:  %DEST%
echo.

cd /d "%SRC_DIR%"
cargo build --release
if errorlevel 1 (
  echo.
  echo [!] cargo build failed. See errors above.
  pause
  exit /b 1
)

echo.
echo Copying target\release\paperclip.exe to launcher dir
copy /y "target\release\paperclip.exe" "%DEST%" >nul
if errorlevel 1 (
  echo [!] Copy failed.
  pause
  exit /b 1
)

echo.
echo ==========================================================
echo   paperclip.exe built and installed at:
echo   %DEST%
echo ==========================================================
endlocal
