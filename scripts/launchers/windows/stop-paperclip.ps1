# Stop paperclip — strictly port-based + process-tree-based.
# Kills only:
#   1. The PID listening on port 3100 (the paperclip server) and ALL its
#      descendant processes.
#   2. Any embedded-postgres whose command line references the paperclip
#      data dir (%USERPROFILE%\.paperclip).
#
# Does NOT regex-match command lines for "tsx" / "esbuild" / "paperclip"
# etc — that previous approach was too broad and would kill Claude Code,
# JetBrains TS server, and unrelated build watchers.

$ErrorActionPreference = 'SilentlyContinue'

$paperclipDir = Join-Path $env:USERPROFILE '.paperclip'
$victims = [System.Collections.Generic.HashSet[int]]::new()

# Recursive descendants of a given PID
function Get-AllDescendants {
    param([int]$ParentPid)
    $kids = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ParentPid }
    foreach ($k in $kids) {
        [void]$script:victims.Add([int]$k.ProcessId)
        Get-AllDescendants -ParentPid $k.ProcessId
    }
}

# 1. Server on port 3100 + descendants
$serverConn = Get-NetTCPConnection -LocalPort 3100 -State Listen | Select-Object -First 1
if ($serverConn) {
    $serverPid = [int]$serverConn.OwningProcess
    [void]$victims.Add($serverPid)
    Get-AllDescendants -ParentPid $serverPid
    Write-Host "  found server PID $serverPid on port 3100"
} else {
    Write-Host "  nothing listening on port 3100"
}

# 2. Orphaned postgres processes whose data dir is in our paperclip tree
$pgProcs = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^postgres' -and
    $_.CommandLine -and
    $_.CommandLine.ToLower().Contains($paperclipDir.ToLower())
}
foreach ($pg in $pgProcs) {
    if ($victims.Add([int]$pg.ProcessId)) {
        Write-Host "  found orphaned postgres PID $($pg.ProcessId) ($($pg.Name))"
    }
}

# Kill everything in $victims
$killed = 0
foreach ($vpid in $victims) {
    try {
        $proc = Get-Process -Id $vpid -ErrorAction Stop
        Write-Host "  killing $($proc.Name) PID $vpid"
        Stop-Process -Id $vpid -Force
        $killed++
    } catch {
        # already gone
    }
}

Write-Host "  total killed: $killed"
