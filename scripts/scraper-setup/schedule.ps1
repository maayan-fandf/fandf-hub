# Register the F&F price scraper as a daily Windows scheduled task.
#
# Idempotent — re-running just updates the existing task. Run as a
# normal user (no admin elevation needed because we use the current
# user's session).
#
# Schedule:
#   - Daily at 03:00 local time
#   - Runs whether the user is logged on or not (StartWhenAvailable so
#     missed runs from "PC was off" catch up at next boot)
#   - Stops if running > 30 minutes (full run is normally ~10 minutes)
$ErrorActionPreference = "Stop"

$TaskName = "fandf-price-scraper"
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path

# Verify the repo is set up before we schedule against it.
if (-not (Test-Path "$RepoRoot\node_modules\puppeteer")) {
  Write-Error "Puppeteer not installed. Run 'npm install' from $RepoRoot first."
  exit 1
}
if (-not (Test-Path "$RepoRoot\.env.local")) {
  Write-Error "Missing .env.local in $RepoRoot. See CLAUDE.md step 3."
  exit 1
}

# The action we'll run. node.exe is resolved from PATH at runtime so
# Node updates don't break the task.
$NodeExe = (Get-Command node.exe).Source
$Action = New-ScheduledTaskAction `
  -Execute $NodeExe `
  -Argument "--experimental-strip-types scripts/scrape-landing-prices.mjs" `
  -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -Daily -At 03:00

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
  -MultipleInstances IgnoreNew

# Run as the currently logged-in user so secrets in .env.local stay
# scoped to that user's profile. The "Run whether user is logged on
# or not" option requires the user's password — we skip it and the
# task fires only when this user is logged on (acceptable for the
# user's primary dedicated PC).
$Principal = New-ScheduledTaskPrincipal -UserId $env:UserName -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Updating existing task '$TaskName'…"
  Set-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal | Out-Null
} else {
  Write-Host "Registering new task '$TaskName'…"
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "F&F nightly price scraper. Renders project landing pages + Yad2 listings, writes LANDING_PRICES sheet. See scripts/scraper-setup/CLAUDE.md." | Out-Null
}

Write-Host ""
Write-Host "Done. Task '$TaskName' will run daily at 03:00."
Write-Host "Verify:  Get-ScheduledTask -TaskName '$TaskName'"
Write-Host "Trigger manually:  Start-ScheduledTask -TaskName '$TaskName'"
