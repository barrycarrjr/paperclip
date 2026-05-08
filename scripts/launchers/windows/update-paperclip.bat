@echo off
REM === Update paperclip ===
REM Pulls the latest from origin/master, rebuilds, applies migrations,
REM and auto-restarts the server. Safe to double-click.
REM
REM Flow:
REM   1. Stop the running server (if any) via stop-paperclip.bat.
REM   2. git pull (only origin/master is supported here).
REM   3. pnpm install if pnpm-lock.yaml changed.
REM   4. pnpm build.
REM   5. pnpm db:migrate.
REM   6. Refresh %USERPROFILE%\.paperclip\install.json.
REM   7. 5-second auto-restart with cancel option, then launch-paperclip.bat.

setlocal EnableDelayedExpansion
title Update Paperclip

for %%I in ("%~dp0..\..\..") do set "PAPERCLIP_SRC=%%~fI"
set "INSTALL_MARKER=%USERPROFILE%\.paperclip\install.json"

if not exist "%PAPERCLIP_SRC%\package.json" (
  echo [!] Paperclip source not found at: %PAPERCLIP_SRC%
  pause
  exit /b 1
)

cd /d "%PAPERCLIP_SRC%"

echo.
echo === Update Paperclip ===
echo Source:  %PAPERCLIP_SRC%
echo Branch:
git -C "%PAPERCLIP_SRC%" branch --show-current
echo.

echo [1/6] Stopping running server (if any)
REM `< nul` feeds EOF to stdin so the trailing `pause` in stop-paperclip.bat
REM returns immediately instead of waiting for a keypress.
call "%~dp0stop-paperclip.bat" < nul >nul 2>&1
timeout /t 1 /nobreak >nul

echo.
echo [2/6] git pull origin master
REM Capture the lockfile hash before pulling so we can decide whether to reinstall.
set "LOCK_BEFORE="
if exist "%PAPERCLIP_SRC%\pnpm-lock.yaml" (
  for /f "delims=" %%H in ('powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 '%PAPERCLIP_SRC%\pnpm-lock.yaml').Hash"') do set "LOCK_BEFORE=%%H"
)
git -C "%PAPERCLIP_SRC%" pull --ff-only origin master
if errorlevel 1 (
  echo.
  echo [!] git pull failed. Resolve manually and re-run.
  pause
  exit /b 1
)
set "LOCK_AFTER="
if exist "%PAPERCLIP_SRC%\pnpm-lock.yaml" (
  for /f "delims=" %%H in ('powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 '%PAPERCLIP_SRC%\pnpm-lock.yaml').Hash"') do set "LOCK_AFTER=%%H"
)

echo.
echo [3/6] pnpm install (only if lockfile changed)
if "!LOCK_BEFORE!"=="!LOCK_AFTER!" (
  echo       lockfile unchanged — skipping
) else (
  call pnpm --dir "%PAPERCLIP_SRC%" install
  if errorlevel 1 goto :update_failed
)

echo.
echo [4/6] pnpm build:runtime ^(skips in-repo example/scaffold plugins^)
call pnpm --dir "%PAPERCLIP_SRC%" build:runtime
if errorlevel 1 goto :update_failed

echo.
echo [5/6] pnpm db:migrate
call pnpm --dir "%PAPERCLIP_SRC%" db:migrate
if errorlevel 1 goto :update_failed

echo.
echo [6/6] Refreshing install marker
if not exist "%USERPROFILE%\.paperclip" mkdir "%USERPROFILE%\.paperclip"
for /f "delims=" %%C in ('git -C "%PAPERCLIP_SRC%" rev-parse HEAD 2^>nul') do set "GIT_COMMIT=%%C"
for /f "delims=" %%B in ('git -C "%PAPERCLIP_SRC%" branch --show-current 2^>nul') do set "GIT_BRANCH=%%B"
for /f "delims=" %%R in ('git -C "%PAPERCLIP_SRC%" remote get-url origin 2^>nul') do set "ORIGIN_URL=%%R"
powershell -NoProfile -Command "$existing = if (Test-Path $env:INSTALL_MARKER) { try { Get-Content $env:INSTALL_MARKER -Raw | ConvertFrom-Json } catch { $null } } else { $null }; $now = (Get-Date).ToString('o'); $obj = [ordered]@{ repoPath = $env:PAPERCLIP_SRC; remote = $env:ORIGIN_URL; branch = $env:GIT_BRANCH; commit = $env:GIT_COMMIT; installedAt = if ($existing -and $existing.installedAt) { $existing.installedAt } else { $now }; lastUpdated = $now }; $obj | ConvertTo-Json | Set-Content -Path $env:INSTALL_MARKER -Encoding UTF8"

echo.
echo ==========================================================
echo   Update complete.
echo.
echo   Commit:    %GIT_COMMIT%
echo   Branch:    %GIT_BRANCH%
echo.
echo   Auto-restart in 5 seconds. Y = restart now, N = cancel.
echo ==========================================================
choice /M "Restart now" /T 5 /D Y /C YN
if errorlevel 2 (
  echo.
  echo Auto-restart cancelled. Double-click paperclip.exe when ready.
  pause
  exit /b 0
)

REM Chain into paperclip.exe (hidden launcher) so the post-update server
REM runs invisibly — no terminal window left on the desktop. paperclip.exe
REM is built from tools\paperclip-launcher (GUI subsystem, fire-and-forget);
REM cmd returns immediately after spawning it, this update window closes,
REM and the browser pops once the server has bound port 3100.
endlocal
start "" "%~dp0paperclip.exe"
exit /b 0

:update_failed
echo.
echo [!] Update failed. See errors above.
pause
endlocal
exit /b 1
