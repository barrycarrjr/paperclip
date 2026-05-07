@echo off
REM === Backup paperclip data dir ===
REM Snapshots ~/.paperclip/ to a timestamped folder under
REM %USERPROFILE%\paperclip-backups\.
REM Useful before risky operations (upgrades, migrations, schema changes).
REM
REM Note: paperclip already auto-snapshots postgres hourly to
REM ~/.paperclip/instances/default/data/backups/. This is for full-state
REM snapshots that include secrets, configs, logs, etc. — everything.

setlocal
title Backup Paperclip Data
set "SRC=%USERPROFILE%\.paperclip"
set "BACKUP_ROOT=%USERPROFILE%\paperclip-backups"

for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value ^| find "="') do set DT=%%I
set "TS=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%_%DT:~8,2%%DT:~10,2%%DT:~12,2%"
set "DEST=%BACKUP_ROOT%\paperclip-%TS%"

if not exist "%SRC%" (
  echo [!] Data dir not found at %SRC%
  pause
  exit /b 1
)

if not exist "%BACKUP_ROOT%" mkdir "%BACKUP_ROOT%"

echo.
echo Snapshotting %SRC%
echo to %DEST%
echo.
echo (May take a minute. Excludes postmaster.pid postgres lockfile.)
echo.

robocopy "%SRC%" "%DEST%" /E /COPY:DAT /NFL /NDL /R:1 /W:1 /XF postmaster.pid

echo.
echo === Backup complete ===
echo Location: %DEST%
echo.
pause
endlocal
