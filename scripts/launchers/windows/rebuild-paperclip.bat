@echo off
REM === Rebuild paperclip from local working tree ===
REM Sibling of update-paperclip.bat for the local-dev case: you've made code
REM changes (committed or not) and want them baked into the running server
REM without going through git pull.
REM
REM Flow:
REM   1. Stop the running server (if any) via stop-paperclip.bat.
REM   2. pnpm build:runtime  (skips example/scaffold plugins).
REM   3. pnpm db:migrate     (no-op if no new migrations).
REM   4. Refresh %USERPROFILE%\.paperclip\install.json with current commit.
REM   5. 5-second auto-restart with cancel option, then launch-paperclip.bat.
REM
REM Does NOT run pnpm install — if you changed deps, run it yourself first.
REM Does NOT run git pull — that's what update-paperclip.bat is for.

setlocal EnableDelayedExpansion
title Rebuild Paperclip

for %%I in ("%~dp0..\..\..") do set "PAPERCLIP_SRC=%%~fI"
set "INSTALL_MARKER=%USERPROFILE%\.paperclip\install.json"

if not exist "%PAPERCLIP_SRC%\package.json" (
  echo [!] Paperclip source not found at: %PAPERCLIP_SRC%
  pause
  exit /b 1
)

cd /d "%PAPERCLIP_SRC%"

echo.
echo === Rebuild Paperclip (local working tree) ===
echo Source:  %PAPERCLIP_SRC%
echo Branch:
git -C "%PAPERCLIP_SRC%" branch --show-current
echo.

echo [1/4] Stopping running server (if any)
REM `< nul` feeds EOF to stdin so the trailing `pause` in stop-paperclip.bat
REM returns immediately instead of waiting for a keypress.
call "%~dp0stop-paperclip.bat" < nul >nul 2>&1
timeout /t 1 /nobreak >nul

echo.
echo [2/4] pnpm build:runtime ^(skips in-repo example/scaffold plugins^)
call pnpm --dir "%PAPERCLIP_SRC%" build:runtime
if errorlevel 1 goto :rebuild_failed

echo.
echo [3/4] pnpm db:migrate
call pnpm --dir "%PAPERCLIP_SRC%" db:migrate
if errorlevel 1 goto :rebuild_failed

echo.
echo [4/4] Refreshing install marker
if not exist "%USERPROFILE%\.paperclip" mkdir "%USERPROFILE%\.paperclip"
for /f "delims=" %%C in ('git -C "%PAPERCLIP_SRC%" rev-parse HEAD 2^>nul') do set "GIT_COMMIT=%%C"
for /f "delims=" %%B in ('git -C "%PAPERCLIP_SRC%" branch --show-current 2^>nul') do set "GIT_BRANCH=%%B"
for /f "delims=" %%R in ('git -C "%PAPERCLIP_SRC%" remote get-url origin 2^>nul') do set "ORIGIN_URL=%%R"
powershell -NoProfile -Command "$existing = if (Test-Path $env:INSTALL_MARKER) { try { Get-Content $env:INSTALL_MARKER -Raw | ConvertFrom-Json } catch { $null } } else { $null }; $now = (Get-Date).ToString('o'); $obj = [ordered]@{ repoPath = $env:PAPERCLIP_SRC; remote = $env:ORIGIN_URL; branch = $env:GIT_BRANCH; commit = $env:GIT_COMMIT; installedAt = if ($existing -and $existing.installedAt) { $existing.installedAt } else { $now }; lastUpdated = $now }; $obj | ConvertTo-Json | Set-Content -Path $env:INSTALL_MARKER -Encoding UTF8"

echo.
echo ==========================================================
echo   Rebuild complete (from local working tree).
echo.
echo   Commit:    %GIT_COMMIT%
echo   Branch:    %GIT_BRANCH%
echo.
echo   Auto-restart in 5 seconds. Y = restart now, N = cancel.
echo ==========================================================
choice /M "Restart now" /T 5 /D Y /C YN
if errorlevel 2 (
  echo.
  echo Auto-restart cancelled. Run launch-paperclip.bat when ready.
  pause
  exit /b 0
)

REM Chain into launch-paperclip.bat in the SAME window so double-click feels
REM continuous (rebuild window transitions into running-server window).
endlocal
"%~dp0launch-paperclip.bat"

:rebuild_failed
echo.
echo [!] Rebuild failed. See errors above.
pause
endlocal
exit /b 1
