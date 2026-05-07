@echo off
REM === Stop paperclip ===
REM Kills the paperclip server (whatever process is listening on port 3100)
REM along with its descendants, plus any embedded postgres whose command
REM line references %USERPROFILE%\.paperclip\.
REM
REM Strictly port + process-tree based — does NOT regex-match command lines,
REM so it cannot accidentally kill Claude Code, JetBrains TS server, your
REM shell, or any other unrelated tool that happens to run tsx/esbuild/etc.
REM
REM Leaves your data dir alone.

title Stop Paperclip
echo Stopping paperclip processes...

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-paperclip.ps1"

timeout /t 2 /nobreak > nul

echo.
echo Done. Port 3100 should be free.
echo Run launch-paperclip.bat to start again.
pause
