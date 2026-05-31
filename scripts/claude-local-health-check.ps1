<#
.SYNOPSIS
  Daily health check for Paperclip's claude_local adapter authentication.

.DESCRIPTION
  Runs a real `claude --print` liveness probe using the same CLI and
  CLAUDE_CODE_OAUTH_TOKEN the claude_local adapter uses. On failure (a dead /
  revoked / expired subscription token -> HTTP 401) -- or when a known token
  expiry is near -- it raises a Windows toast and, if configured, posts to
  Slack. The goal is to catch a dead token BEFORE agents start 401ing.

  `claude auth status` is intentionally NOT used: it reports stored metadata
  and returns loggedIn:true even when the token is dead. Only a live call tells
  the truth.

  Auth model: set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) as a user
  env var; both the adapter and this probe read it. See
  docs/adapters/claude-local.md.

.PARAMETER Install
  Register a daily Scheduled Task that runs this script in the interactive
  session (so toasts display), then exit.

.PARAMETER Uninstall
  Remove the scheduled task, then exit.

.PARAMETER At
  Time of day (HH:mm) for the scheduled task. Default 08:00.

.PARAMETER ExpiryWarnDays
  Warn this many days before a known token expiry. Default 21.

.NOTES
  Slack:  set $env:PAPERCLIP_HEALTH_SLACK_WEBHOOK to a Slack incoming-webhook URL
          (machine/user env var) to also receive Slack alerts. If unset, the
          check is toast + log only.
  Expiry: optionally set $env:CLAUDE_CODE_OAUTH_TOKEN_EXPIRES to the token's ISO
          expiry date (e.g. 2027-05-31) to get a heads-up before it lapses.
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Uninstall,
  [string]$At = "08:00",
  [int]$ExpiryWarnDays = 21
)

$ErrorActionPreference = "Stop"
$TaskName = "Paperclip claude_local auth health check"
$ScriptPath = $MyInvocation.MyCommand.Path

function Show-Toast {
  param([string]$Title, [string]$Message, [string]$Level = "Warning")
  # NotifyIcon balloon: renders as a toast on Win10/11 with no extra module.
  # Only displays in an interactive logon session (hence the Scheduled Task
  # runs with LogonType Interactive).
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $sysIcon = if ($Level -eq "Error") { [System.Drawing.SystemIcons]::Error } else { [System.Drawing.SystemIcons]::Warning }
    $tipIcon = if ($Level -eq "Error") { [System.Windows.Forms.ToolTipIcon]::Error } else { [System.Windows.Forms.ToolTipIcon]::Warning }
    $ni = New-Object System.Windows.Forms.NotifyIcon
    $ni.Icon = $sysIcon
    $ni.BalloonTipIcon = $tipIcon
    $ni.BalloonTipTitle = $Title
    $ni.BalloonTipText = $Message
    $ni.Visible = $true
    $ni.ShowBalloonTip(10000)
    Start-Sleep -Seconds 7
    $ni.Dispose()
    return $true
  } catch {
    Write-Warning "Toast failed: $($_.Exception.Message)"
    return $false
  }
}

function Send-Slack {
  param([string]$Message)
  $hook = $env:PAPERCLIP_HEALTH_SLACK_WEBHOOK
  if ([string]::IsNullOrWhiteSpace($hook)) { return $false }
  try {
    $body = @{ text = $Message } | ConvertTo-Json -Depth 4
    Invoke-RestMethod -Uri $hook -Method Post -ContentType "application/json" -Body $body -TimeoutSec 15 | Out-Null
    return $true
  } catch {
    Write-Warning "Slack post failed: $($_.Exception.Message)"
    return $false
  }
}

function Write-Log {
  param([string]$Line)
  $logDir = Join-Path $env:USERPROFILE ".paperclip"
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  Add-Content -Path (Join-Path $logDir "claude-local-health.log") -Value "$stamp  $Line"
}

function Install-Task {
  $ps = (Get-Command powershell.exe).Source
  $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
  $trigger = New-ScheduledTaskTrigger -Daily -At $At
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "Registered daily task '$TaskName' at $At (runs as $env:USERNAME, interactive)."
}

function Uninstall-Task {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed task '$TaskName'."
}

if ($Install) { Install-Task; exit 0 }
if ($Uninstall) { Uninstall-Task; exit 0 }

# --------------------------- run the health check ---------------------------
$problems = @()

# 1) Optional expiry heads-up (only if the operator recorded the expiry date).
$expRaw = $env:CLAUDE_CODE_OAUTH_TOKEN_EXPIRES
if (-not [string]::IsNullOrWhiteSpace($expRaw)) {
  try {
    $exp = [datetime]::Parse($expRaw)
    $days = [int][math]::Floor(($exp - (Get-Date)).TotalDays)
    if ($days -le 0) {
      $problems += "Claude token EXPIRED on $($exp.ToString('yyyy-MM-dd'))."
    } elseif ($days -le $ExpiryWarnDays) {
      $problems += "Claude token expires in $days day(s) ($($exp.ToString('yyyy-MM-dd'))); run 'claude setup-token' to rotate."
    }
  } catch {
    Write-Warning "Could not parse CLAUDE_CODE_OAUTH_TOKEN_EXPIRES='$expRaw'."
  }
}

# 2) Live liveness probe -- the ground truth.
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
  $problems += "claude CLI not found on PATH."
} else {
  try {
    # No --model: use the CLI's configured default so a healthy call reliably
    # returns is_error:false (a model id this CLI version rejects would otherwise
    # read as inconclusive). No 2>&1 (PS 5.1 wraps native stderr in error
    # records); the result JSON, including any api_error_status, is on stdout.
    $out = ("Reply with only: OK" | & $claude.Source --print --output-format json) -join "`n"
    $authDead = $false
    $healthy = $false
    try {
      $j = $out | ConvertFrom-Json
      if ($j.api_error_status -eq 401) {
        $authDead = $true
      } elseif ($j.is_error -eq $true -and $j.result -match "authenticat|credential|log ?in|unauthorized") {
        $authDead = $true
      } elseif ($j.is_error -eq $false) {
        $healthy = $true
      }
    } catch {
      if ($out -match "\b401\b|invalid authentication|credential|please (log ?in|run .?claude)|unauthorized") { $authDead = $true }
    }
    if ($authDead) {
      $problems += "claude_local auth probe FAILED (401 / invalid credentials). Run 'claude setup-token' and set CLAUDE_CODE_OAUTH_TOKEN."
    } elseif (-not $healthy) {
      # Transient (rate limit / overloaded) or other non-auth error: log only,
      # don't raise an alert -- those clear on their own and would be noise.
      $flat = ($out -replace '\s+', ' ').Trim()
      Write-Log ("Probe inconclusive (non-auth): " + $flat.Substring(0, [math]::Min(200, $flat.Length)))
    }
  } catch {
    $problems += "claude_local auth probe error: $($_.Exception.Message)"
  }
}

if ($problems.Count -eq 0) {
  Write-Log "OK - claude_local auth healthy."
  Write-Host "OK - claude_local auth healthy."
  exit 0
}

$summary = "Paperclip claude_local auth needs attention:`n- " + ($problems -join "`n- ")
Write-Log ("ALERT - " + ($problems -join " | "))
$toastOk = Show-Toast -Title "Paperclip: Claude auth needs attention" -Message ($problems -join "  ") -Level "Error"
$slackOk = Send-Slack -Message $summary
Write-Host $summary
Write-Host ("[toast: " + $(if ($toastOk) { "shown" } else { "failed" }) + "] [slack: " + $(if ($slackOk) { "sent" } else { "not configured / failed" }) + "]")
exit 1
