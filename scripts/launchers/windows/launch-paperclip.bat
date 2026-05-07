@echo off
REM === Paperclip launcher ===
REM Double-click to start paperclip from this clone of the repo.
REM Runs whatever branch is currently checked out.
REM Data lives at %USERPROFILE%\.paperclip\ — survives across restarts and source updates.

setlocal
title Paperclip

REM Resolve repo root from this script's own location.
REM This .bat lives at <repo>\scripts\launchers\windows\, so go up 3 levels.
for %%I in ("%~dp0..\..\..") do set "PAPERCLIP_SRC=%%~fI"

set "PAPERCLIP_PORT=3100"
set "PAPERCLIP_URL=http://localhost:%PAPERCLIP_PORT%/"

if not exist "%PAPERCLIP_SRC%\package.json" (
  echo [!] Paperclip source not found at: %PAPERCLIP_SRC%
  echo     This script expects to live in ^<repo^>\scripts\launchers\windows\.
  pause
  exit /b 1
)

REM Already-running guard: if something is listening on PAPERCLIP_PORT, assume
REM it is another Paperclip instance and bail with a friendly message instead
REM of spawning a duplicate that will fail to bind the port.
REM
REM `findstr ":%PAPERCLIP_PORT% "` with a trailing space avoids matching
REM neighboring ports like 31000/31001. Netstat's LISTENING rows have spaces
REM after the port for both IPv4 (0.0.0.0:3100  ...) and IPv6 ([::]:3100  ...).
netstat -ano | findstr "LISTENING" | findstr ":%PAPERCLIP_PORT% " >nul 2>&1
if not errorlevel 1 (
  cls
  echo.
  echo ==========================================================
  echo   Paperclip is already running.
  echo.
  echo   Open it here:
  echo       %PAPERCLIP_URL%
  echo.
  echo   This window closes in 30 seconds. Press any key to close sooner.
  echo ==========================================================
  echo.
  REM Drop /nobreak so any key press cancels the wait and exits immediately.
  timeout /t 30 >nul
  exit /b 0
)

cd /d "%PAPERCLIP_SRC%"

echo.
echo === Paperclip ===
echo Source:  %PAPERCLIP_SRC%
echo Data:    %USERPROFILE%\.paperclip\instances\default\
echo Branch:
git branch --show-current
echo.
echo Server will be at %PAPERCLIP_URL%
echo Ctrl-C in this window to stop.
echo.

REM Use --dir to anchor pnpm at the paperclip workspace regardless of the
REM caller's working directory. `cd /d` above isn't reliably honored when this
REM .bat is invoked via `cmd /c` from a non-cmd parent shell (e.g. Git Bash):
REM pnpm.cmd ends up walking up from the caller's cwd and complains
REM `No projects matched the filters in <some-other-dir>`. --dir makes the
REM workspace explicit and makes the launcher portable.
pnpm --dir "%PAPERCLIP_SRC%" --filter paperclipai exec tsx src/index.ts run

echo.
echo ==========================================================
echo Paperclip stopped. Close this window when ready.
echo ==========================================================
pause
endlocal
