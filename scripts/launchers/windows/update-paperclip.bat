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
REM   7. 5-second auto-restart with cancel option, then relaunch paperclip.exe.

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

REM Activate the in-repo pre-commit hook (.githooks/pre-commit). Normally
REM package.json's `prepare` script does this on `pnpm install`, but we skip
REM install below when the lockfile hasn't changed — and a pull-only update
REM would otherwise leave a freshly-cloned dev without an active hook.
REM `git config` is idempotent, so running it on every update is harmless.
if exist "%PAPERCLIP_SRC%\.githooks\pre-commit" (
  git -C "%PAPERCLIP_SRC%" config core.hooksPath .githooks >nul 2>&1
)

REM Safe update. After build and migrate, the new version is started once as a
REM trial and must answer healthy on /api/health before the real relaunch. If
REM it does not, the checkout goes back to the commit installed before this
REM run. Shared logic: scripts\launchers\update-guard.mjs.
REM
REM Keep every byte ABOVE the git pull line unchanged. cmd re-reads this file
REM by position after each command, and the pull replaces the file mid-run,
REM so the run carries on at its old position in the NEW file. That is also
REM why the rollback point is recorded here, from the installed commit in
REM install.json, rather than from HEAD before the pull.
set "UPDATE_GUARD=%~dp0..\update-guard.mjs"
node "%UPDATE_GUARD%" record-previous --from-install-record
if errorlevel 1 goto :record_previous_failed

echo.
echo [3/6] pnpm install (only if lockfile changed)
if "!LOCK_BEFORE!"=="!LOCK_AFTER!" (
  echo       lockfile unchanged — skipping
) else (
  call pnpm --dir "%PAPERCLIP_SRC%" install
  if !errorlevel! neq 0 goto :prepare_failed
)

echo.
echo [4/6] pnpm build:runtime ^(skips in-repo example/scaffold plugins^)
call pnpm --dir "%PAPERCLIP_SRC%" build:runtime
if !errorlevel! neq 0 goto :prepare_failed

echo.
echo [5/6] Database backup, then pnpm db:migrate
REM The server is already stopped, so a live backup cannot connect. This
REM copies the stopped embedded database folder instead.
node "%UPDATE_GUARD%" cold-backup
if !errorlevel! neq 0 goto :backup_failed
call pnpm --dir "%PAPERCLIP_SRC%" db:migrate
if !errorlevel! neq 0 goto :update_failed

echo.
echo [6/6] Trial start of the new version, then refreshing install marker
node "%UPDATE_GUARD%" trial-start --launcher windows
if !errorlevel! neq 0 goto :trial_failed
if not exist "%USERPROFILE%\.paperclip" mkdir "%USERPROFILE%\.paperclip"
for /f "delims=" %%C in ('git -C "%PAPERCLIP_SRC%" rev-parse HEAD 2^>nul') do set "GIT_COMMIT=%%C"
for /f "delims=" %%B in ('git -C "%PAPERCLIP_SRC%" branch --show-current 2^>nul') do set "GIT_BRANCH=%%B"
for /f "delims=" %%R in ('git -C "%PAPERCLIP_SRC%" remote get-url origin 2^>nul') do set "ORIGIN_URL=%%R"
REM The marker is now written by update-guard.mjs, which keeps fields it does
REM not own that the PowerShell version below dropped. It clears this update's
REM rollback point (previousCommit), which a later run must not reuse.
REM powershell -NoProfile -Command "$existing = if (Test-Path $env:INSTALL_MARKER) { try { Get-Content $env:INSTALL_MARKER -Raw | ConvertFrom-Json } catch { $null } } else { $null }; $now = (Get-Date).ToString('o'); $obj = [ordered]@{ repoPath = $env:PAPERCLIP_SRC; remote = $env:ORIGIN_URL; branch = $env:GIT_BRANCH; commit = $env:GIT_COMMIT; installedAt = if ($existing -and $existing.installedAt) { $existing.installedAt } else { $now }; lastUpdated = $now }; $obj | ConvertTo-Json | Set-Content -Path $env:INSTALL_MARKER -Encoding UTF8"
node "%UPDATE_GUARD%" record-install
if errorlevel 1 (
  echo.
  echo [!] The update worked, but the install record could not be refreshed:
  echo     %INSTALL_MARKER%
  echo     The error is above. The next update will not be able to roll back
  echo     automatically until an update or rebuild refreshes it.
)
REM Each cold copy is the whole database folder. Keep only the newest two.
node "%UPDATE_GUARD%" prune-cold-backups
if errorlevel 1 echo [!] Old cold database copies could not be removed. They are the cold-* folders in the backup folder.

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

echo.
echo Restarting Paperclip and waiting for it to become healthy...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-paperclip.ps1" -Port 3100 -RestartAfterMaintenance
if errorlevel 1 goto :restart_failed

echo Update and restart complete.
endlocal
exit /b 0

:trial_failed
echo.
echo ==========================================================
echo   [ERROR] THE UPDATED PAPERCLIP DID NOT START
echo ==========================================================
echo   The reason and the server's last output are above.
echo   Rolling back to the version installed before this update.
echo   Migrations are not undone and the database is not restored.
echo.
set "ROLLBACK_CONTEXT=trial"
goto :roll_back

:prepare_failed
echo.
echo ==========================================================
echo   [ERROR] INSTALLING OR BUILDING THE NEW VERSION FAILED
echo ==========================================================
echo   The reason is above. The database has not been migrated yet, so the
echo   update does not start the new version, which would migrate it with
echo   no backup and no trial. Returning to the version installed before
echo   this update.
echo.
echo   Exit code 3221225477 usually means Windows Defender locked a file
echo   mid-copy. If so, add Defender exclusions for %PAPERCLIP_SRC% and
echo   %USERPROFILE%\.paperclip, then run this update again.
echo.
set "ROLLBACK_CONTEXT=prepare"
goto :roll_back

:backup_failed
echo.
echo ==========================================================
echo   [ERROR] THE DATABASE BACKUP FAILED
echo ==========================================================
echo   The reason is above. The database has not been migrated yet, so the
echo   update stops here rather than start the new version, which would
echo   migrate the database with no backup. Returning to the version
echo   installed before this update.
echo.
set "ROLLBACK_CONTEXT=backup"
goto :roll_back

:roll_back
REM Everything from the rollback to the end of the run is ONE parenthesised
REM block. git reset --keep can replace this very file with the previous
REM version's copy, and cmd reads a running batch file by byte position, so a
REM line read after the reset could come from the middle of the old file.
REM cmd reads and parses a whole block before it runs any of it, so nothing
REM after the reset is read from disk. Inside the block: use !var! for values
REM set in it, keep parentheses out of echo text, and never call or goto.
(
  node "%UPDATE_GUARD%" rollback
  set "ROLLBACK_RESULT=!errorlevel!"
  set "RESTART=1"
  echo.
  if "!ROLLBACK_RESULT!"=="0" (
    echo   Rolled back. Starting the previous version again.
  ) else if not "!ROLLBACK_CONTEXT!"=="trial" (
    set "RESTART=0"
    if "!ROLLBACK_RESULT!"=="2" (
      echo   [ERROR] No earlier version is recorded, so nothing was rolled back.
    ) else (
      echo   [ERROR] Rolling back also failed. See the errors above.
    )
    echo.
    echo   Paperclip has NOT been restarted. The files now in the checkout
    echo   would migrate the database with no backup. Fix the problem above,
    echo   then run this update again.
  ) else if "!ROLLBACK_RESULT!"=="2" (
    echo   [ERROR] No earlier version is recorded, so nothing was rolled back.
    echo       Trying to start the updated version anyway.
  ) else (
    echo   [ERROR] Rolling back also failed. See the errors above.
    echo       Trying to start Paperclip from the files now in the checkout.
  )
  if "!RESTART!"=="1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-paperclip.ps1" -Port 3100 -RestartAfterMaintenance
    if errorlevel 1 (
      echo.
      echo [ERROR] Paperclip did not come back. Fix the error above, then run
      echo     rebuild-paperclip.bat or double-click paperclip.exe.
    ) else (
      echo.
      echo Paperclip is running again, but the update did not go through.
    )
  )
  pause
  endlocal
  exit /b 1
)

:record_previous_failed
echo.
echo ==========================================================
echo   [ERROR] COULD NOT RECORD THE VERSION TO RETURN TO
echo ==========================================================
echo   The reason is above. The update stopped before building anything,
echo   because without that record a failed update could not be rolled back.
echo.
echo   Paperclip has NOT been restarted. The checkout already holds the new
echo   version's files, not yet built, and starting them would migrate the
echo   database with no backup. Fix the problem above, then run this update
echo   again. The download is already done, so it carries on from here.
echo ==========================================================
pause
endlocal
exit /b 1

:update_failed
echo.
echo ==========================================================
echo   [!] UPDATE FAILED
echo ==========================================================
echo.
echo   The update did not complete. See the errors above.
echo.
echo   Most common causes on Windows:
echo.
echo   1. Windows Defender real-time scan locked a file mid-copy.
echo      Exit code 3221225477 ^(0xC0000005^) is the telltale.
echo      Fix: add a Defender exclusion for the Paperclip folders.
echo      Run PowerShell *as Administrator* and execute:
echo.
echo         Add-MpPreference -ExclusionPath '%PAPERCLIP_SRC%'
echo         Add-MpPreference -ExclusionPath '%USERPROFILE%\.paperclip'
echo.
echo   2. A leftover Paperclip child process is holding files open.
echo      Fix: run stop-paperclip.bat, then re-run this update. That script
echo           targets only verified Paperclip process trees.
echo.
echo   3. pnpm install needed elevated rights ^(rare^).
echo      Fix: re-run paperclip-update from an elevated terminal.
echo.
echo   Paperclip will now attempt to come back online using the files that are
echo   currently installed. The update error above will remain on screen.
echo ==========================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-paperclip.ps1" -Port 3100 -RestartAfterMaintenance
if errorlevel 1 (
  echo.
  echo [!] Automatic recovery also failed. Double-click paperclip.exe after
  echo     resolving the update error above.
) else (
  echo.
  echo Paperclip is back online; the update itself still needs attention.
)
pause
endlocal
exit /b 1

:restart_failed
echo.
echo ==========================================================
echo   [!] UPDATE FINISHED, BUT PAPERCLIP DID NOT RESTART
echo ==========================================================
echo   The build and migrations completed successfully.
echo   Double-click paperclip.exe or inspect the launcher log under:
echo   %USERPROFILE%\.paperclip\logs\
echo ==========================================================
pause
endlocal
exit /b 1
