@echo off
REM === Install paperclip (post-clone setup) ===
REM Run this once after `git clone https://github.com/barrycarrjr/paperclip.git`.
REM Idempotent — safe to re-run. Performs:
REM   1. pnpm install
REM   2. pnpm build
REM   3. db migrations (or `paperclipai onboard --yes` if no data dir yet)
REM   4. Records install location in %USERPROFILE%\.paperclip\install.json
REM
REM After this, double-click launch-paperclip.bat to start the server.

setlocal
title Install Paperclip

REM Resolve repo root (3 levels up from <repo>\scripts\launchers\windows\).
for %%I in ("%~dp0..\..\..") do set "PAPERCLIP_SRC=%%~fI"
set "INSTALL_MARKER=%USERPROFILE%\.paperclip\install.json"
set "DATA_DIR=%USERPROFILE%\.paperclip\instances\default"

if not exist "%PAPERCLIP_SRC%\package.json" (
  echo [!] Paperclip source not found at: %PAPERCLIP_SRC%
  echo     This script expects to live in ^<repo^>\scripts\launchers\windows\.
  pause
  exit /b 1
)

cd /d "%PAPERCLIP_SRC%"

echo.
echo === Install Paperclip ===
echo Source:  %PAPERCLIP_SRC%
echo Data:    %DATA_DIR%
echo.

REM Check the origin remote and warn if it isn't the expected fork. We don't
REM hard-fail because Barry/Tony might temporarily test a different fork.
for /f "delims=" %%R in ('git -C "%PAPERCLIP_SRC%" remote get-url origin 2^>nul') do set "ORIGIN_URL=%%R"
echo Remote:  %ORIGIN_URL%
echo %ORIGIN_URL% | findstr /i "barrycarrjr/paperclip" >nul
if errorlevel 1 (
  echo.
  echo [!] origin remote is not barrycarrjr/paperclip.
  echo     If you intended to switch from upstream, run migrate-from-upstream.bat first.
  echo     Continuing in 10 seconds. Press Ctrl-C to abort.
  timeout /t 10 >nul
)

echo.
echo [1/4] pnpm install
call pnpm --dir "%PAPERCLIP_SRC%" install
if errorlevel 1 goto :install_failed

echo.
echo [2/4] pnpm build:runtime ^(skips in-repo example/scaffold plugins^)
call pnpm --dir "%PAPERCLIP_SRC%" build:runtime
if errorlevel 1 goto :install_failed

echo.
if exist "%DATA_DIR%\db" (
  echo [3/4] pnpm db:migrate ^(existing data dir^)
  call pnpm --dir "%PAPERCLIP_SRC%" db:migrate
) else (
  echo [3/4] paperclipai onboard --yes ^(fresh install^)
  call pnpm --dir "%PAPERCLIP_SRC%" --filter paperclipai exec tsx src/index.ts onboard --yes
)
if errorlevel 1 goto :install_failed

echo.
echo [4/4] Recording install location at %INSTALL_MARKER%
if not exist "%USERPROFILE%\.paperclip" mkdir "%USERPROFILE%\.paperclip"
for /f "delims=" %%C in ('git -C "%PAPERCLIP_SRC%" rev-parse HEAD 2^>nul') do set "GIT_COMMIT=%%C"
for /f "delims=" %%B in ('git -C "%PAPERCLIP_SRC%" branch --show-current 2^>nul') do set "GIT_BRANCH=%%B"
powershell -NoProfile -Command "$existing = if (Test-Path $env:INSTALL_MARKER) { try { Get-Content $env:INSTALL_MARKER -Raw | ConvertFrom-Json } catch { $null } } else { $null }; $now = (Get-Date).ToString('o'); $obj = [ordered]@{ repoPath = $env:PAPERCLIP_SRC; remote = $env:ORIGIN_URL; branch = $env:GIT_BRANCH; commit = $env:GIT_COMMIT; installedAt = if ($existing -and $existing.installedAt) { $existing.installedAt } else { $now }; lastUpdated = $now }; $obj | ConvertTo-Json | Set-Content -Path $env:INSTALL_MARKER -Encoding UTF8"

echo.
echo ==========================================================
echo   Paperclip installed.
echo.
echo   Source:    %PAPERCLIP_SRC%
echo   Data:      %DATA_DIR%
echo   Commit:    %GIT_COMMIT%
echo   Branch:    %GIT_BRANCH%
echo.
echo   Next: double-click paperclip.exe to start the server (no terminal window).
echo         Or launch-paperclip.bat if you want verbose console output.
echo ==========================================================
echo.
pause
endlocal
exit /b 0

:install_failed
echo.
echo [!] Install failed. See errors above.
pause
endlocal
exit /b 1
