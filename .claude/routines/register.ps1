# Register (or replace) this workspace's three routines as Windows scheduled
# tasks. Idempotent: schtasks /F replaces a task of the same name.
#
#   powershell -ExecutionPolicy Bypass -File .claude\routines\register.ps1 -WhatIf
#   powershell -ExecutionPolicy Bypass -File .claude\routines\register.ps1
#   powershell -ExecutionPolicy Bypass -File .claude\routines\register.ps1 -Unregister
#
# Run it with -WhatIf first: that prints the exact command line each task would
# get and registers nothing. See README.md for what each routine does and why.
param([switch]$Unregister, [switch]$WhatIf)

$ErrorActionPreference = 'Stop'

# The repo root is two levels up from this script, whatever directory it is
# invoked from. A routine that resolved paths from the caller's cwd would run
# against whatever happened to be current when the scheduler fired.
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Logs = Join-Path $Repo '.kingdom\routines'

# One task-name prefix, so `schtasks /Query /TN AgenticOS\<name>` reaches
# exactly these and nothing else on the machine.
$Prefix = 'AgenticOS'

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude -and -not $Unregister) {
  throw 'claude is not on PATH; the two model routines cannot be registered.'
}

# `--permission-prompts none` is the restrictive setting, not a bypass: with no
# human at the console, anything that would prompt is denied instead of hanging
# the task until the next run overlaps it. handoff-sweep additionally gets
# acceptEdits because correcting a contradicted claim means writing the file it
# lives in; branch-record gets a two-command allowlist and edits nothing.
$Routines = @(
  @{
    Name  = 'handoff-sweep'
    Sched = @('/SC', 'DAILY', '/ST', '09:00')
    Cmd   = "`"$claude`" -p `"/handoff-audit`" --permission-mode acceptEdits --permission-prompts none"
  },
  @{
    Name  = 'branch-record'
    Sched = @('/SC', 'WEEKLY', '/D', 'MON', '/ST', '09:15')
    Cmd   = "`"$claude`" -p `"Run: gh pr list --state all --json headRefName,state,mergedAt. Then list every branch still present on origin whose pull request is merged. Report only; delete nothing.`" --allowed-tools `"Bash(gh *) Bash(git *)`" --permission-prompts none"
  },
  @{
    Name  = 'gate-log'
    Sched = @('/SC', 'DAILY', '/ST', '02:00')
    Cmd   = 'npm.cmd test'
  }
)

if ($Unregister) {
  foreach ($r in $Routines) {
    $tn = "$Prefix\$($r.Name)"
    Write-Host "removing $tn"
    if (-not $WhatIf) { schtasks /Delete /TN $tn /F 2>$null | Out-Null }
  }
  Write-Host 'done'
  return
}

if (-not $WhatIf) { New-Item -ItemType Directory -Force -Path $Logs | Out-Null }

foreach ($r in $Routines) {
  $tn  = "$Prefix\$($r.Name)"
  $log = Join-Path $Logs "$($r.Name).log"
  # cd into the repo first: a routine's cwd decides which CLAUDE.md, which
  # skills and which package.json it sees.
  $line = "cd /d `"$Repo`" && echo [%DATE% %TIME%] $($r.Name) >> `"$log`" && $($r.Cmd) >> `"$log`" 2>&1"
  # cmd /s /c, not /c: /s is the documented "strip the outer pair of quotes and
  # take the rest verbatim" rule. Plain /c re-parses the embedded quotes and
  # mangles a repo path containing a space, which this one does.
  $tr   = "cmd /s /c `"$line`""
  Write-Host "registering $tn  ($($r.Sched -join ' '))"
  if ($WhatIf) { Write-Host "  $tr"; continue }
  schtasks /Create /TN $tn /TR $tr /F @($r.Sched) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "schtasks failed for $tn (exit $LASTEXITCODE)" }
}

Write-Host ''
# ASCII only below this line, and everywhere in this file: Windows PowerShell
# 5.1 reads a BOM-less file as ANSI, where an em dash decodes into a CP1252
# right curly quote -- which PowerShell accepts as a string delimiter, so one
# stray dash in a comment or a message breaks the whole script's parse.
Write-Host "registered under $Prefix\ - logs in $Logs"
Write-Host "inspect:  schtasks /Query /TN $Prefix\handoff-sweep /V /FO LIST"
Write-Host "run now:  schtasks /Run   /TN $Prefix\gate-log"
