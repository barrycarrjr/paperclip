@echo off
REM === Stop paperclip ===
REM Kills the running paperclip server and its embedded postgres + dev-runner children.
REM Leaves your data dir alone.

title Stop Paperclip
echo Stopping paperclip processes...

powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -match 'paperclip|tsx|esbuild|cross-env' -or $_.Name -match 'postgres') -and $_.CommandLine -notmatch 'JetBrains|claude\.exe|ai-os|MCP' } | ForEach-Object { Write-Host '  killing' $_.Name 'PID' $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

timeout /t 2 /nobreak > nul

echo.
echo Done. Port 3100 should be free.
echo Run launch-paperclip.bat to start again.
pause
