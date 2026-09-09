# Stop paperclip — port-based + verified process-tree-based.
# Kills:
#   1. The PID listening on the configured port (3100 by default), ALL its
#      descendants, and the verified pnpm/tsx wrapper chain between that PID
#      and paperclip.exe.
#   2. Every launch tree from this checkout carrying the exact production
#      command signature. This catches a stale sibling that previously fell
#      forward to 3101 during a restart race, without touching `pnpm dev` or
#      unrelated Node/tsx processes.
#      Without the wrapper cleanup, an orphaned pnpm can print a misleading
#      `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "tsx" not found` after its
#      child dies. The tray itself and unrelated shells/IDEs are excluded.
#   3. The embedded postgres: the postmaster (identified by the paperclip data
#      dir on its command line), its worker children, and separately any
#      orphaned embedded-postgres worker, whether left behind by an earlier
#      crashed or half-finished run or orphaned by this stop itself.
#
# Does NOT broadly match command lines for "tsx" / "esbuild" / "paperclip" —
# that would kill Claude Code, JetBrains TS server, and unrelated build
# watchers. The only global launch scan requires both this checkout's absolute
# path and the complete Paperclip production command signature.

# Run with -WhatIf to see exactly what would be killed without touching
# anything. Worth doing before assuming this script is the reason something
# died, and it is how the process-matching above is verified by hand.
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3100
)

$ErrorActionPreference = 'SilentlyContinue'

$paperclipDir = Join-Path $env:USERPROFILE '.paperclip'
$victims = [System.Collections.Generic.HashSet[int]]::new()

# Build one process graph up front. The old recursive walk queried every
# Windows process again for every child it visited; a normal Paperclip tree
# includes the server, plugin workers, esbuild, and postgres workers, so that
# turned a restart into roughly a minute of apparent inactivity.
$processSnapshot = @(Get-CimInstance Win32_Process)
$processById = @{}
$childrenByParent = @{}
foreach ($process in $processSnapshot) {
    $processId = [int]$process.ProcessId
    $parentId = [int]$process.ParentProcessId
    $processById[$processId] = $process
    if (-not $childrenByParent.ContainsKey($parentId)) {
        $childrenByParent[$parentId] = [System.Collections.Generic.List[object]]::new()
    }
    $childrenByParent[$parentId].Add($process)
}

# This script lives at <repo>\scripts\launchers\windows\, so go up 3 levels to
# reach the checkout that owns the server and embedded-postgres binaries.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$repoModulesDir = Join-Path $repoRoot 'node_modules'

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

# Is $Child genuinely a child of $Parent, or is the link an artefact?
#
# Windows does NOT clear ParentProcessId when a parent exits, and it reuses
# PIDs aggressively. So a long-running process whose real parent died hours ago
# keeps pointing at that dead PID, and the moment something new is given that
# PID the orphan appears to be its child. Walking children blindly therefore
# reaches arbitrary unrelated processes.
#
# This is not hypothetical: a stop run on 2026-08-07 killed two AdobeCollabSync
# processes this way, and a snapshot of the same machine showed a bash.exe
# claiming a node.exe parent that had been created two and a half hours AFTER
# it. A real child is always created at or after its parent, so comparing
# creation times rejects the reused-PID pairs and keeps the genuine ones.
function Test-RealParent {
    param($Parent, $Child)
    if (-not $Parent -or -not $Child) { return $false }
    if (-not $Parent.CreationDate -or -not $Child.CreationDate) { return $false }
    return $Child.CreationDate -ge $Parent.CreationDate
}

# Recursive descendants of a given PID, skipping reused-PID impostors.
function Get-AllDescendants {
    param([int]$ParentPid)
    $parent = $script:processById[$ParentPid]
    if (-not $parent) { return }
    $kids = $script:childrenByParent[$ParentPid]
    if (-not $kids) { return }
    foreach ($k in $kids) {
        if (-not (Test-RealParent -Parent $parent -Child $k)) {
            Write-Host "  skipping PID $($k.ProcessId) ($($k.Name)): older than the PID $ParentPid that claims it"
            continue
        }
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
    $current = $script:processById[$ChildPid]
    while ($current -and $current.ParentProcessId -gt 4) {
        $parent = $script:processById[[int]$current.ParentProcessId]
        if (-not $parent -or -not $parent.CommandLine) { break }
        if (-not (Test-RealParent -Parent $parent -Child $current)) { break }
        if ($parent.CommandLine.ToLower().IndexOf('tsx') -lt 0) { break }
        [void]$script:victims.Add([int]$parent.ProcessId)
        $current = $parent
    }
}

# True only for the launcher production command from THIS checkout. Matching
# both the repo path and the complete command signature is deliberately much
# narrower than looking globally for `node`, `tsx`, or `paperclip`.
function Test-IsPaperclipLaunchProcess {
    param($Process)
    if (-not $Process -or -not $Process.CommandLine) { return $false }
    if (-not (Test-PathTextContains -Haystack $Process.CommandLine -Needle $script:repoRoot)) {
        return $false
    }
    $normalized = (($Process.CommandLine.ToLower() -replace '["'']', '') -replace '\s+', ' ').Trim()
    return $normalized.Contains('--filter paperclipai exec tsx src/index.ts run')
}

# Snapshot of the postgres processes for pass 3a below.
$pgProcs = @($processSnapshot | Where-Object { $_.Name -match '^postgres' })

# 1. Server on the configured port + descendants + launch-chain ancestors.
$serverConn = Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -First 1
if ($serverConn) {
    $serverPid = [int]$serverConn.OwningProcess
    [void]$victims.Add($serverPid)
    Get-AllDescendants -ParentPid $serverPid
    Get-LaunchChainAncestors -ChildPid $serverPid
    Write-Host "  found server PID $serverPid on port $Port"
} else {
    Write-Host "  nothing listening on port $Port"
}

# 2. Exact launcher production trees from this checkout. Normally this finds
# the same chain as step 1. It also finds stale siblings on a fallback port,
# which is the state an interrupted or older restart could leave behind.
$launchRootPids = [System.Collections.Generic.HashSet[int]]::new()
$launchProcesses = @($processSnapshot | Where-Object {
    Test-IsPaperclipLaunchProcess -Process $_
})
$launchCandidatePids = [System.Collections.Generic.HashSet[int]]::new()
foreach ($launchProcess in $launchProcesses) {
    [void]$launchCandidatePids.Add([int]$launchProcess.ProcessId)
}
foreach ($launchProcess in $launchProcesses) {
    # Both the outer cmd.exe and its pnpm node child carry the full signature.
    # Keep only the highest matching process so each tree is traversed once.
    $parent = $processById[[int]$launchProcess.ParentProcessId]
    if ($parent -and
        $launchCandidatePids.Contains([int]$parent.ProcessId) -and
        (Test-RealParent -Parent $parent -Child $launchProcess)) {
        continue
    }
    $launchPid = [int]$launchProcess.ProcessId
    if ($launchRootPids.Add($launchPid)) {
        Write-Host "  found Paperclip launch process PID $launchPid"
    }
    [void]$victims.Add($launchPid)
    Get-AllDescendants -ParentPid $launchPid
}

# 3. Postgres. Two cases, because they present very differently.
#
# 3a. A live database. Only the postmaster carries the data dir on its command
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

# 3b. An orphan left behind by an earlier half-finished run. When a postmaster
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
    $cur = $processById[$serverPid]
    while ($cur -and $cur.ParentProcessId -gt 4) {
        $par = $processById[[int]$cur.ParentProcessId]
        if (-not $par -or -not $par.CommandLine) { break }
        if (-not (Test-RealParent -Parent $par -Child $cur)) { break }
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

# Phase 1: launch roots and listener ancestors — silences misleading wrapper
# errors before any child notices that the listener disappeared.
foreach ($vpid in $launchRootPids) { Kill-Pid -Target $vpid }
foreach ($vpid in $ancestorPids) {
    if ($launchRootPids.Contains([int]$vpid)) { continue }
    Kill-Pid -Target $vpid
}
# Phase 2: everything else (listener, descendants, postgres).
foreach ($vpid in $victims) {
    if ($launchRootPids.Contains([int]$vpid) -or $ancestorPids.Contains([int]$vpid)) { continue }
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
