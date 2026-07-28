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
#   3. The embedded postgres: the postmaster (identified by the paperclip data
#      dir on its command line), its worker children, and separately any
#      orphaned embedded-postgres worker, whether left behind by an earlier
#      crashed or half-finished run or orphaned by this stop itself.
#
# Does NOT regex-match command lines globally for "tsx" / "esbuild" /
# "paperclip" — that previous approach was too broad and would kill
# Claude Code, JetBrains TS server, and unrelated build watchers. The
# parent-chain walk above is anchored at the listener PID, so it can
# only reach our own spawn chain.

# Run with -WhatIf to see exactly what would be killed without touching
# anything. Worth doing before assuming this script is the reason something
# died, and it is how the process-matching above is verified by hand.
[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'SilentlyContinue'

$paperclipDir = Join-Path $env:USERPROFILE '.paperclip'
$victims = [System.Collections.Generic.HashSet[int]]::new()

# This script lives at <repo>\scripts\launchers\windows\, so go up 3 levels to
# reach the checkout that owns the embedded-postgres binaries.
$repoModulesDir = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path 'node_modules'

# Case-insensitive substring test that treats / and \ as the same separator.
# embedded-postgres is inconsistent about this: the postmaster is spawned with
# backslashes (`-D C:\Users\me\.paperclip\...`) while its workers get forward
# slashes (`"C:/Users/me/paperclip/node_modules/..."`), so a raw Contains()
# against either form silently misses half the processes.
function Test-PathTextContains {
    param([string]$Haystack, [string]$Needle)
    if (-not $Haystack -or -not $Needle) { return $false }
    return $Haystack.ToLower().Replace('\', '/').Contains($Needle.ToLower().Replace('\', '/'))
}

# Embedded-postgres processes belonging to THIS repo whose parent process is
# gone. Takes its own fresh process snapshot on every call, because it is used
# both before the kill (to find leftovers from an earlier run) and again after
# (to catch workers orphaned by the kill itself).
function Get-OrphanedEmbeddedPostgres {
    $procs = Get-CimInstance Win32_Process
    $alive = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($p in $procs) { [void]$alive.Add([int]$p.ProcessId) }
    return @($procs | Where-Object {
        $_.Name -match '^postgres' -and
        -not $alive.Contains([int]$_.ParentProcessId) -and
        ((Test-PathTextContains -Haystack $_.CommandLine -Needle $script:repoModulesDir) -or
         (Test-PathTextContains -Haystack $_.ExecutablePath -Needle $script:repoModulesDir))
    })
}

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

# Snapshot of the postgres processes for pass 2a below.
$pgProcs = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^postgres' })

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

# 2. Postgres. Two cases, because they present very differently.
#
# 2a. A live database. Only the postmaster carries the data dir on its command
#     line (`postgres.exe -D <datadir> -p <port>`); its worker children are
#     spawned as `postgres.exe --forkchild="io_worker" <n>` with no data dir on
#     them at all, so they never match here on their own. Stop-Process does not
#     cascade to children on Windows, and an io_worker can outlive the
#     postmaster we just killed, so collect the children explicitly.
foreach ($pg in $pgProcs) {
    if (-not (Test-PathTextContains -Haystack $pg.CommandLine -Needle $paperclipDir)) { continue }
    if ($victims.Add([int]$pg.ProcessId)) {
        Write-Host "  found postgres postmaster PID $($pg.ProcessId)"
    }
    Get-AllDescendants -ParentPid $pg.ProcessId
}

# 2b. An orphan left behind by an earlier half-finished run. When a postmaster
#     dies without taking its workers with it (a killed `pnpm db:migrate`, an
#     update console that was closed mid-build), the surviving io_worker keeps
#     the postgres port bound and the data dir's postmaster.pid in place, which
#     blocks the next start. 2a cannot see it, so it needs its own sweep: an
#     embedded-postgres binary belonging to THIS repo whose parent process is
#     gone. A healthy postmaster always has a live parent (the server, or the
#     migrate run that spawned it) and a healthy worker always has a live
#     postmaster, so a dead parent is unambiguously garbage. Anchoring on this
#     repo's own node_modules keeps the sweep away from a system-wide
#     PostgreSQL install or another app's embedded database.
#
#     Match on the command line, not just ExecutablePath: Windows leaves
#     ExecutablePath empty on most of these forked children (22 of 23 in the
#     case this was written for), so keying off it alone finds almost nothing.
#     The command line always carries the full binary path.
foreach ($pg in (Get-OrphanedEmbeddedPostgres)) {
    if ($victims.Add([int]$pg.ProcessId)) {
        Write-Host "  found orphaned postgres PID $($pg.ProcessId) (parent $($pg.ParentProcessId) is gone)"
    }
    Get-AllDescendants -ParentPid $pg.ProcessId
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
        if ($WhatIfPreference) {
            Write-Host "  would kill $($proc.Name) PID $Target"
            $script:killed++
            return
        }
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

# Phase 3: postgres workers orphaned by the kill we just did. Force-killing the
# postmaster does not reliably take its io_workers with it, and the ones that
# survive are re-parented to nothing. Without this pass they sit around until
# the NEXT stop runs, which is how they quietly pile up (23 of them had
# accumulated on the machine this was written for). Re-scanning after the kill
# is what lets a single stop leave the box actually clean.
# Skipped under -WhatIf: nothing was killed, so there is nothing new to find
# and the pre-kill pass above already listed every existing orphan.
if (-not $WhatIfPreference) {
    Start-Sleep -Milliseconds 750
    foreach ($pg in (Get-OrphanedEmbeddedPostgres)) {
        Write-Host "  sweeping postgres worker orphaned by this stop: PID $($pg.ProcessId)"
        Kill-Pid -Target $pg.ProcessId
    }
}

Write-Host "  total killed: $killed"
