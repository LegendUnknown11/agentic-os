# Register (or replace) this workspace's three routines as Windows scheduled
# tasks. Idempotent: -Force replaces a task of the same name.
#
#   powershell -ExecutionPolicy Bypass -File .claude\routines\register.ps1 -WhatIf
#   powershell -ExecutionPolicy Bypass -File .claude\routines\register.ps1
#   powershell -ExecutionPolicy Bypass -File .claude\routines\register.ps1 -Unregister
#
# Run it with -WhatIf first: that prints what each task would get and registers
# nothing. The routine bodies live in run.cmd, not here; see README.md for what
# each one does and why.
#
# Register-ScheduledTask rather than schtasks.exe. Two reasons, both measured
# on this machine rather than assumed:
#   - schtasks caps /TR at 261 characters, and an inline claude command line
#     assembled 313 and 478 for two of these three routines. That is why the
#     bodies moved into run.cmd, and it is no longer a constraint here.
#   - passing a /TR containing quoted paths through PowerShell 5.1's native
#     argument handling corrupted it ("Invalid argument/option"). The cmdlets
#     hand the argument string to COM untouched; verified byte-identical on
#     round trip through Get-ScheduledTask.
#
# ASCII only, everywhere in this file: Windows PowerShell 5.1 reads a BOM-less
# file as ANSI, where an em dash decodes into a CP1252 right curly quote --
# which PowerShell accepts as a string delimiter, so one stray dash in a
# comment or a message breaks the whole script's parse.
param([switch]$Unregister, [switch]$WhatIf)

$ErrorActionPreference = 'Stop'

# The repo root is two levels up from this script, whatever directory it is
# invoked from.
$Repo   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Runner = Join-Path $PSScriptRoot 'run.cmd'

# One task path, so these are inspectable as a group and nothing else on the
# machine is in it. -TaskPath creates the folder on first registration.
$TaskPath = '\AgenticOS\'

$Routines = @(
  @{ Name = 'handoff-sweep'; Trigger = { New-ScheduledTaskTrigger -Daily -At 09:00 }; When = 'daily 09:00' },
  @{ Name = 'branch-record'; Trigger = { New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 09:15 }; When = 'Mondays 09:15' },
  @{ Name = 'gate-log';      Trigger = { New-ScheduledTaskTrigger -Daily -At 02:00 }; When = 'daily 02:00' }
)

if ($Unregister) {
  foreach ($r in $Routines) {
    Write-Host "removing $TaskPath$($r.Name)"
    if ($WhatIf) { continue }
    try { Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $r.Name -Confirm:$false }
    catch { Write-Host "  not registered" }
  }
  Write-Host 'done'
  return
}

if (-not (Test-Path $Runner)) { throw "run.cmd is missing beside this script: $Runner" }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Warning 'claude is not on PATH. gate-log will still run; the two model routines will log an error and exit.'
}

foreach ($r in $Routines) {
  # cmd.exe because Task Scheduler calls CreateProcess, which will not launch a
  # .cmd directly. /s is the documented "strip the outer pair of quotes and take
  # the rest verbatim" rule, which is what keeps a repo path containing a space
  # intact -- and this one has one.
  $arg = "/s /c `"`"$Runner`" $($r.Name)`""
  Write-Host "registering $TaskPath$($r.Name)  ($($r.When))"
  if ($WhatIf) { Write-Host "  cmd.exe $arg"; continue }
  $action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg -WorkingDirectory $Repo
  $trigger = & $r.Trigger
  Register-ScheduledTask -TaskName $r.Name -TaskPath $TaskPath `
    -Action $action -Trigger $trigger -Description "Agentic OS routine: $($r.Name)" -Force | Out-Null
}

Write-Host ''
Write-Host "registered under $TaskPath - logs in $Repo\.kingdom\routines"
Write-Host "inspect:  Get-ScheduledTask -TaskPath '$TaskPath'"
Write-Host "run now:  Start-ScheduledTask -TaskPath '$TaskPath' -TaskName gate-log"
Write-Host "remove:   .\.claude\routines\register.ps1 -Unregister"
