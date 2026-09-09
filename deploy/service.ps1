<#
.SYNOPSIS
  Runs the open world in the background on Windows, on port 8089.

.DESCRIPTION
  Node cannot be a services.msc service by itself. A real service has to answer
  the Service Control Manager's handshake within thirty seconds and node.exe
  does not know how, so `sc create binPath="node.exe server.js"` installs fine
  and then fails to start with error 1053. A true service needs a wrapper.

  This uses a Scheduled Task, which is the native thing that does what a service
  is wanted for: starts at boot, runs with nobody logged in, restarts if it
  falls over, and stops and starts on demand. If NSSM is on the PATH it uses
  that instead and you get a real services.msc entry. Every verb works the same
  either way, and `status` tells you which one you have.

  Everything is verified by asking the server, not by asking Windows whether it
  thinks it started something: a task reports Running with a process that
  exited on line one.

  NOTE: this file must stay UTF-8 with a BOM, or Windows PowerShell 5.1 reads it
  as ANSI. ASCII-only text below so that a re-save without one is survivable.

.PARAMETER Action
  install | uninstall | start | stop | restart | status | logs

.EXAMPLE
  # From an elevated PowerShell:
  .\deploy\service.ps1 install
  .\deploy\service.ps1 restart
  .\deploy\service.ps1 status
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs')]
  [string] $Action = 'status',

  # 8089, not the server's own default of 8080, so the deployed copy and
  # a node server.js you start to try something out never fight over a port.
  # The one you leave running is not the one you keep restarting.
  [int] $Port = 8089,
  [string] $Bind = '127.0.0.1',
  [string] $Name = 'OpenWorld'
)

$ErrorActionPreference = 'Stop'

$Root    = Split-Path -Parent $PSScriptRoot
$LogDir  = Join-Path $Root 'logs'
$LogFile = Join-Path $LogDir 'service.log'
$Runner  = Join-Path $PSScriptRoot 'run.cmd'
$HealthUrl  = "http://127.0.0.1:$Port/healthz"

function Say  ($m) { Write-Host "  $m" }
function Warn ($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Ok   ($m) { Write-Host "  $m" -ForegroundColor Green }
function Fail ($m) { Write-Host "  x $m" -ForegroundColor Red; exit 1 }

function Test-Admin {
  $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  return $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Need-Admin {
  if (-not (Test-Admin)) {
    Fail 'this needs an elevated PowerShell - right-click, Run as administrator'
  }
}

function Get-Nssm {
  $found = Get-Command nssm.exe -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  return $null
}

function Get-Backend {
  # Whichever is actually installed wins, so status cannot lie about which one
  # is running the thing.
  if (Get-Service -Name $Name -ErrorAction SilentlyContinue) { return 'service' }
  if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) { return 'task' }
  return $null
}

function Get-Node {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { Fail 'node.exe is not on the PATH' }
  return $node.Source
}

# Ask the server, not the operating system. A Scheduled Task reports Running the
# moment it has launched something and a service reports Running once its
# wrapper is up; neither knows whether a port got bound. /healthz is the only
# answer that means the thing works.
function Test-Up {
  param([int] $TimeoutSec = 1)
  try { return Invoke-RestMethod -Uri $HealthUrl -TimeoutSec $TimeoutSec -ErrorAction Stop }
  catch { return $null }
}

function Wait-Up {
  param([int] $Seconds = 20)
  $until = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $until) {
    $health = Test-Up
    if ($health) { return $health }
    Start-Sleep -Milliseconds 400
  }
  return $null
}

function Wait-Down {
  param([int] $Seconds = 15)
  $until = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $until) {
    if (-not (Test-Up)) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

# Ask the server to close itself rather than shooting it.
#
# Windows has no SIGTERM. Stop-Process and taskkill are both TerminateProcess,
# and the handler in server.js never runs under either - so the write-ahead log
# is left for SQLite to recover on the next start. A console control event is
# the one thing that does reach it, arriving as SIGINT.
#
# CTRL_C and not CTRL_BREAK, and the difference is not cosmetic. The event goes
# to every process attached to that console, which by then includes this script.
# SetConsoleCtrlHandler(NULL, TRUE) makes the caller deaf to CTRL_C - and only
# to CTRL_C. CTRL_BREAK cannot be ignored, so the first version of this stopped
# the server and killed the PowerShell that was stopping it, half way through a
# restart. Node raises SIGINT for one and SIGBREAK for the other; server.js
# handles both, so nothing is lost by choosing the survivable one.
#
# Best-effort by design, and the return value is not evidence of anything. It
# was observed returning false while the server logged "SIGINT - closing" and
# released the port, so the event had plainly arrived; whatever the API is
# reporting there, it is not whether the process got the signal. The caller
# therefore ignores it and checks the port, which is the only account that
# settles the question either way.
#
# A scheduled task may also have no console to attach to at all, in which case
# nothing is delivered and Stop-Process finishes the job. That is a fine
# outcome - WAL recovery is exactly what it is for - it is only worth trying
# the clean stop when the clean stop is available.
function Send-CtrlBreak {
  param([int] $ProcessId)
  if (-not ('Win32.Console' -as [type])) {
    Add-Type -Namespace Win32 -Name Console -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint p);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
'@
  }
  $deaf = $false
  try {
    # Deafen ourselves BEFORE going anywhere near another console. Doing it
    # after attaching leaves a window in which the event can arrive first.
    [Win32.Console]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
    $deaf = $true
    # A process may only be attached to one console, so ours has to go first.
    [Win32.Console]::FreeConsole() | Out-Null
    if (-not [Win32.Console]::AttachConsole([uint32] $ProcessId)) {
      # Give ourselves a console back rather than leaving the shell without one.
      [Win32.Console]::AttachConsole([uint32] 0xFFFFFFFF) | Out-Null   # ATTACH_PARENT_PROCESS
      return $false
    }
    $sent = [Win32.Console]::GenerateConsoleCtrlEvent(0, 0)   # 0 = CTRL_C_EVENT
    [Win32.Console]::FreeConsole() | Out-Null
    [Win32.Console]::AttachConsole([uint32] 0xFFFFFFFF) | Out-Null
    return $sent
  } catch {
    return $false
  } finally {
    if ($deaf) { [Win32.Console]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null }
  }
}

# The launcher, so both backends start it the same way and the port lives in one
# place rather than inside a task definition nobody reads.
function Write-Runner {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $node = Get-Node
  $lines = @(
    '@echo off',
    'rem Written by deploy\service.ps1 - edit that, not this.',
    ('cd /d "' + $Root + '"'),
    ('set PORT=' + $Port),
    ('set HOST=' + $Bind),
    'set NODE_ENV=production',
    ('"' + $node + '" server.js >> "' + $LogFile + '" 2>&1')
  )
  Set-Content -Path $Runner -Value $lines -Encoding ASCII
  Say "launcher: $Runner"
}

function Install-Task {
  Write-Runner
  $action = New-ScheduledTaskAction -Execute $Runner -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  # SYSTEM, so it runs with nobody logged in - which is the whole point.
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  # RestartCount is the restartable part: if node exits for any reason the task
  # starts it again, three times, a minute apart. ExecutionTimeLimit zero means
  # never kill it for running too long - the default is three days, which would
  # take the server down one afternoon with no explanation anywhere.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Ok "installed as a scheduled task '$Name' (starts at boot, restarts on failure)"
}

function Install-Service {
  param([string] $Nssm)
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $node = Get-Node
  & $Nssm install $Name $node 'server.js' | Out-Null
  & $Nssm set $Name AppDirectory $Root | Out-Null
  & $Nssm set $Name AppEnvironmentExtra "PORT=$Port" "HOST=$Bind" 'NODE_ENV=production' | Out-Null
  & $Nssm set $Name AppStdout $LogFile | Out-Null
  & $Nssm set $Name AppStderr $LogFile | Out-Null
  & $Nssm set $Name Start SERVICE_AUTO_START | Out-Null
  # Stop it the way the server understands: CTRL_BREAK reaches the SIGBREAK
  # handler, which closes the database before exiting.
  & $Nssm set $Name AppStopMethodConsole 5000 | Out-Null
  & $Nssm set $Name AppExit Default Restart | Out-Null
  Ok "installed as a Windows service '$Name' via NSSM"
}

function Start-It {
  $backend = Get-Backend
  if ($backend -eq 'service') { Start-Service -Name $Name; return }
  if ($backend -eq 'task') { Start-ScheduledTask -TaskName $Name; return }
  Fail 'nothing is installed - run: .\deploy\service.ps1 install'
}

function Stop-It {
  $backend = Get-Backend
  if ($backend -eq 'service') {
    Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
    return
  }
  if ($backend -eq 'task') {
    Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    # Stop-ScheduledTask ends the task, and the task is the .cmd - the node
    # process underneath can outlive it and keep the port. Nothing else will be
    # listening there, so this is unambiguous: find whoever holds the port, ask
    # politely, then insist.
    $held = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $held) { Send-CtrlBreak -ProcessId $c.OwningProcess | Out-Null }
    Start-Sleep -Milliseconds 1200
    $held = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $held) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
    return
  }
  Fail 'nothing is installed'
}

switch ($Action) {

  'install' {
    Need-Admin
    if (Get-Backend) {
      Warn "'$Name' is already installed - replacing it"
      Stop-It
      Wait-Down 10 | Out-Null
      if ((Get-Backend) -eq 'service') {
        $n = Get-Nssm
        if ($n) { & $n remove $Name confirm | Out-Null } else { sc.exe delete $Name | Out-Null }
      } else {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
      }
    }
    if ($Bind -ne '127.0.0.1') {
      Warn "binding $Bind exposes this beyond the machine."
      Warn 'DELETE /api/data wipes every world, run and chronicle, and nothing asks who you are.'
      Warn 'Put it behind something that does, or keep the bind at 127.0.0.1.'
    }
    $nssm = Get-Nssm
    if ($nssm) { Install-Service -Nssm $nssm } else { Install-Task }
    Start-It
    $health = Wait-Up 25
    if (-not $health) {
      Warn "installed, but nothing answered $HealthUrl within 25s"
      Warn "look at $LogFile"
      exit 1
    }
    Ok ("up on http://" + $Bind + ":" + $Port + "  (pid " + $health.pid + ", node " + $health.node + ")")
    if (-not $health.chronicle) {
      Warn ('the chronicle is off - node:sqlite needs Node 22+, this is ' + $health.node)
      Warn 'the page still runs; nothing is kept between worlds'
    }
    Say "log: $LogFile"
  }

  'uninstall' {
    Need-Admin
    $backend = Get-Backend
    if (-not $backend) { Say "nothing installed under '$Name'"; break }
    Stop-It
    Wait-Down 10 | Out-Null
    if ($backend -eq 'service') {
      $nssm = Get-Nssm
      if ($nssm) { & $nssm remove $Name confirm | Out-Null } else { sc.exe delete $Name | Out-Null }
    } else {
      Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    }
    Ok "removed '$Name'"
    Say 'chronicle.db and logs\ are left alone'
  }

  'start' {
    Need-Admin
    Start-It
    $health = Wait-Up 25
    if ($health) { Ok ("up on http://" + $Bind + ":" + $Port + " (pid " + $health.pid + ")") }
    else { Warn "started, but nothing answered $HealthUrl - see $LogFile"; exit 1 }
  }

  'stop' {
    Need-Admin
    Stop-It
    if (Wait-Down 15) { Ok 'stopped' }
    else { Warn "something is still listening on $Port"; exit 1 }
  }

  'restart' {
    Need-Admin
    $was = Test-Up
    $wasPid = if ($was) { $was.pid } else { 0 }
    Stop-It
    if (-not (Wait-Down 15)) { Fail "it would not stop - something is still on port $Port" }
    Start-It
    $now = Wait-Up 25
    if (-not $now) { Warn "it stopped but did not come back - see $LogFile"; exit 1 }
    # A new pid is the proof. The same pid means nothing restarted and the stop
    # quietly did nothing, which is the failure worth catching.
    if ($wasPid -ne 0 -and $wasPid -eq $now.pid) {
      Warn ('same pid ' + $now.pid + ' - it never actually went down')
    } else {
      Ok ('restarted - pid ' + $wasPid + ' -> ' + $now.pid)
    }
  }

  'status' {
    $backend = Get-Backend
    if (-not $backend) {
      Say 'not installed'
    } else {
      if ($backend -eq 'service') {
        Say ("installed as a Windows service named '" + $Name + "'")
        Say ('windows says: ' + (Get-Service -Name $Name).Status)
      } else {
        Say ("installed as a scheduled task named '" + $Name + "'")
        Say ('windows says: ' + (Get-ScheduledTask -TaskName $Name).State)
      }
    }
    $health = Test-Up 2
    if ($health) {
      Ok "answering on $HealthUrl"
      $chron = if ($health.chronicle) { 'on' } else { 'OFF' }
      Say ('pid ' + $health.pid + ' - up ' + $health.uptime + 's - node ' + $health.node + ' - chronicle ' + $chron)
    } else {
      Warn "nothing answering on $HealthUrl"
    }
  }

  'logs' {
    if (Test-Path $LogFile) { Get-Content -Path $LogFile -Tail 40 }
    else { Say "no log yet at $LogFile" }
  }
}
