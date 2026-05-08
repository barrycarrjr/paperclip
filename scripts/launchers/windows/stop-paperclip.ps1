# Stop paperclip — strictly port-based + process-tree-based.
# Kills:
#   1. The PID listening on port 3100 (the paperclip server) and ALL its
#      descendant processes.
#   2. The pnpm/tsx wrapper chain BETWEEN the listener and paperclip.exe.
#      We walk parents up from the listener and kill any ancestor whose
#      command line contains the paperclip launch signature
#      ("--filter paperclipai exec tsx" or "tsx src/index.ts run").
#      Without this, when we kill the listener the orphaned pnpm sees its
#      tsx child died and prints a misleading
#      `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "tsx" not found`
#      into the daily log. Killing the whole launch chain at once avoids
#      that. We deliberately stop walking before paperclip.exe (the tray)
#      and before any process that doesn't carry the launch signature, so
#      a stray cmd / powershell / IDE the user is in never gets touched.
#   3. Any embedded-postgres whose command line references the paperclip
#      data dir (%USERPROFILE%\.paperclip).
#
# Does NOT regex-match command lines globally for "tsx" / "esbuild" /
# "paperclip" — that previous approach was too broad and would kill
# Claude Code, JetBrains TS server, and unrelated build watchers. The
# parent-chain walk above is anchored at the listener PID, so it can
# only reach our own spawn chain.

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

# Walk the parent chain UP from a PID, collecting ancestors whose command
# line carries the paperclip launch signature. The walk is ANCHORED at the
# listener PID, so we can only ever traverse our own spawn chain — we
# can't accidentally reach an unrelated process. Stops at the first
# ancestor whose cmdline doesn't contain "tsx" — that's paperclip.exe
# (the tray) in the normal flow, or the launch-paperclip.bat cmd window in
# the manual-launch flow. Both correctly survive the kill.
function Get-LaunchChainAncestors {
    param([int]$ChildPid)
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$ChildPid"
    while ($current -and $current.ParentProcessId -gt 4) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($current.ParentProcessId)"
        if (-not $parent -or -not $parent.CommandLine) { break }
        if ($parent.CommandLine.ToLower().IndexOf('tsx') -lt 0) { break }
        [void]$script:victims.Add([int]$parent.ProcessId)
        $current = $parent
    }
}

# 1. Server on port 3100 + descendants + launch-chain ancestors
$serverConn = Get-NetTCPConnection -LocalPort 3100 -State Listen | Select-Object -First 1
if ($serverConn) {
    $serverPid = [int]$serverConn.OwningProcess
    [void]$victims.Add($serverPid)
    Get-AllDescendants -ParentPid $serverPid
    Get-LaunchChainAncestors -ChildPid $serverPid
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

# Kill ancestors FIRST, then the listener + descendants. This order matters:
# the misleading "Command 'tsx' not found" comes from the orphaned pnpm
# detecting its tsx grandchild died and printing an error. If we kill pnpm
# (and the cmd wrappers) before killing the listener, those processes never
# get the chance to observe the death and emit the noise.
$ancestorPids = [System.Collections.Generic.HashSet[int]]::new()
if ($serverConn) {
    $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
    while ($cur -and $cur.ParentProcessId -gt 4) {
        $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)"
        if (-not $par -or -not $par.CommandLine) { break }
        if ($par.CommandLine.ToLower().IndexOf('tsx') -lt 0) { break }
        if ($victims.Contains([int]$par.ProcessId)) {
            [void]$ancestorPids.Add([int]$par.ProcessId)
        }
        $cur = $par
    }
}

$killed = 0
function Kill-Pid {
    param([int]$Target)
    try {
        $proc = Get-Process -Id $Target -ErrorAction Stop
        Write-Host "  killing $($proc.Name) PID $Target"
        Stop-Process -Id $Target -Force
        $script:killed++
    } catch {
        # already gone
    }
}

# Phase 1: ancestors — silences the misleading log noise.
foreach ($vpid in $ancestorPids) { Kill-Pid -Target $vpid }
# Phase 2: everything else (listener, descendants, postgres).
foreach ($vpid in $victims) {
    if ($ancestorPids.Contains([int]$vpid)) { continue }
    Kill-Pid -Target $vpid
}

Write-Host "  total killed: $killed"
