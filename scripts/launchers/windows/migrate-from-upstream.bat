@echo off
REM === Migrate from upstream paperclipai/paperclip to barrycarrjr fork ===
REM One-time switch for clones that currently have origin pointing at the
REM upstream repo. Performs:
REM   1. Sanity check: origin must be paperclipai/paperclip.
REM   2. Stop the running server.
REM   3. Full data backup via backup-data.bat.
REM   4. Re-point origin to barrycarrjr/paperclip.
REM   5. git fetch + reset --hard origin/master.
REM   6. Hand off to install-paperclip.bat (install + build + migrate + marker).
REM
REM SAFETY: this is destructive to local commits and uncommitted changes
REM in the repo. The data dir at %USERPROFILE%\.paperclip\ is backed up
REM beforehand. Re-run is safe but unnecessary once the remote is repointed.

setlocal
title Migrate from upstream to fork

set "FORK_URL=https://github.com/barrycarrjr/paperclip.git"
for %%I in ("%~dp0..\..\..") do set "PAPERCLIP_SRC=%%~fI"

if not exist "%PAPERCLIP_SRC%\package.json" (
  echo [!] Paperclip source not found at: %PAPERCLIP_SRC%
  pause
  exit /b 1
)

cd /d "%PAPERCLIP_SRC%"

for /f "delims=" %%R in ('git -C "%PAPERCLIP_SRC%" remote get-url origin 2^>nul') do set "ORIGIN_URL=%%R"

echo.
echo === Migrate paperclip clone from upstream to fork ===
echo Source:        %PAPERCLIP_SRC%
echo Current origin: %ORIGIN_URL%
echo Target origin:  %FORK_URL%
echo.

echo %ORIGIN_URL% | findstr /i "paperclipai/paperclip" >nul
if errorlevel 1 (
  echo %ORIGIN_URL% | findstr /i "barrycarrjr/paperclip" >nul
  if not errorlevel 1 (
    echo [i] origin already points at barrycarrjr/paperclip. Nothing to migrate.
    echo     If you just want to update, run update-paperclip.bat instead.
    pause
    exit /b 0
  )
  echo [!] origin is neither paperclipai/paperclip nor barrycarrjr/paperclip.
  echo     Refusing to repoint automatically — fix manually first.
  pause
  exit /b 1
)

echo This will:
echo   - back up your data dir to %%USERPROFILE%%\paperclip-backups\
echo   - DISCARD any local commits on this clone (reset --hard origin/master)
echo   - re-point origin to %FORK_URL%
echo   - reinstall, rebuild, and run new migrations
echo.
choice /M "Proceed"
if errorlevel 2 (
  echo Aborted.
  pause
  exit /b 0
)

echo.
echo [1/5] Stopping running server (if any)
REM `< nul` feeds EOF to stdin so the trailing `pause` in stop-paperclip.bat
REM returns immediately instead of waiting for a keypress.
call "%~dp0stop-paperclip.bat" < nul >nul 2>&1
timeout /t 1 /nobreak >nul

echo.
echo [2/5] Backing up data dir
call "%~dp0backup-data.bat"
if errorlevel 1 (
  echo [!] Backup failed. Aborting migration so your data stays safe.
  pause
  exit /b 1
)

echo.
echo [3/5] Re-pointing origin to %FORK_URL%
git -C "%PAPERCLIP_SRC%" remote set-url origin "%FORK_URL%"
if errorlevel 1 goto :migrate_failed

echo.
echo [4/5] Fetching fork and resetting to origin/master
git -C "%PAPERCLIP_SRC%" fetch origin
if errorlevel 1 goto :migrate_failed
git -C "%PAPERCLIP_SRC%" checkout master 2>nul
git -C "%PAPERCLIP_SRC%" reset --hard origin/master
if errorlevel 1 goto :migrate_failed

echo.
echo [5/5] Handing off to install-paperclip.bat
call "%~dp0install-paperclip.bat"
if errorlevel 1 goto :migrate_failed

echo.
echo ==========================================================
echo   Migration complete. You are now on the fork.
echo   Run launch-paperclip.bat to start.
echo ==========================================================
echo.
pause
endlocal
exit /b 0

:migrate_failed
echo.
echo [!] Migration step failed. Your data backup is intact under
echo     %%USERPROFILE%%\paperclip-backups\. Review errors above.
pause
endlocal
exit /b 1
