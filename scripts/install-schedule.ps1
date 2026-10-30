<#
.SYNOPSIS
    Installs (or removes) the Windows scheduled task that keeps the CTS-SAT-1 gallery up to date.

.DESCRIPTION
    Registers a per-user task that runs scripts\scheduled_update.py with the project's
    .venv\Scripts\pythonw.exe every day at the times in -At (10:00 and 22:00 local time by
    default), or every -IntervalMinutes minutes when that is given instead. The task runs
    as the current user, only while that user is logged on, stores no password and needs
    no admin rights. Re-running replaces the task. See docs\SCHEDULING.md.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 -RunNow

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 -At 08:00,20:00

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 -IntervalMinutes 30

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 -Uninstall
#>
param(
    [string[]]$At = @("10:00", "22:00"),
    [ValidateRange(1, 1440)]
    [int]$IntervalMinutes = 0,
    [string]$TaskName = "CTS-SAT-1 Gallery Update",
    [switch]$Uninstall,
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$pythonw = Join-Path $repo ".venv\Scripts\pythonw.exe"
$updateScript = Join-Path $repo "scripts\scheduled_update.py"
$logDir = Join-Path $repo "data\logs"

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -TaskPath "\" -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath "\" -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "No scheduled task named '$TaskName'; nothing to remove."
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $pythonw)) {
    Write-Host "Not found: $pythonw" -ForegroundColor Red
    Write-Host "Create the project's virtual environment first, from $repo :"
    Write-Host "    python -m venv .venv"
    Write-Host "    .venv\Scripts\python.exe -m pip install -r requirements.txt"
    Write-Host "then run this script again."
    exit 1
}

# pythonw.exe has no console, so no window flashes up on every run.
$action = New-ScheduledTaskAction -Execute "`"$pythonw`"" -Argument "`"$updateScript`"" -WorkingDirectory $repo

if ($IntervalMinutes -gt 0) {
    # First run a minute from now; with -RunNow a run starts at once, so the schedule
    # begins one interval later. (A start time already past when the task is saved would
    # count as a missed run.) The repetition gets a long finite duration because
    # -RepetitionDuration ([TimeSpan]::MaxValue) is rejected on some PS 5.1 builds.
    $start = if ($RunNow) { (Get-Date).AddMinutes($IntervalMinutes) } else { (Get-Date).AddMinutes(1) }
    $triggerParams = @{
        Once               = $true
        At                 = $start
        RepetitionInterval = (New-TimeSpan -Minutes $IntervalMinutes)
        RepetitionDuration = (New-TimeSpan -Days 3650)
    }
    $trigger = New-ScheduledTaskTrigger @triggerParams
    $when = "every $IntervalMinutes minutes"
} else {
    # One daily trigger per time, in local time, so it follows daylight saving.
    $times = foreach ($t in $At) {
        $parsed = [datetime]::MinValue
        if (-not [datetime]::TryParseExact($t, "HH:mm", $null, "None", [ref]$parsed)) {
            Write-Host "Not a time: '$t'. Write each as HH:mm, e.g. -At 10:00,22:00" -ForegroundColor Red
            exit 1
        }
        $parsed
    }
    $trigger = @($times | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ })
    $when = "every day at " + (($times | ForEach-Object { $_.ToString("HH:mm") }) -join " and ")
}

$settingsParams = @{
    MultipleInstances          = "IgnoreNew"
    StartWhenAvailable         = $true
    AllowStartIfOnBatteries    = $true
    DontStopIfGoingOnBatteries = $true
    ExecutionTimeLimit         = (New-TimeSpan -Hours 1)
}
$settings = New-ScheduledTaskSettingsSet @settingsParams

# Interactive logon: runs as you while you are logged on; no stored password, no admin rights.
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

$taskParams = @{
    TaskName    = $TaskName
    TaskPath    = "\"
    Action      = $action
    Trigger     = $trigger
    Settings    = $settings
    Principal   = $principal
    Description = "Syncs CTS-SAT-1 (FrontierSat) downlink data and rebuilds the image gallery $when (python -m cts1_gallery update; plain Python, no AI). Logs: $logDir"
    Force       = $true
}
Register-ScheduledTask @taskParams | Out-Null

if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName -TaskPath "\"
}

$info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath "\"
Write-Host "Registered scheduled task '$TaskName'."
Write-Host "  Runs:     `"$pythonw`" `"$updateScript`""
Write-Host "  When:     $when"
Write-Host ("  Next run: {0:yyyy-MM-dd HH:mm}" -f $info.NextRunTime)
if ($RunNow) {
    Write-Host "  Started:  a run is going now, in the background"
}
Write-Host "  Logs:     $logDir\update.log"
Write-Host "            $logDir\last_run.json"
