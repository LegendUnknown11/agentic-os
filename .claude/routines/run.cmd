@echo off
REM The routine bodies. register.ps1 points every scheduled task at this one
REM file, because schtasks caps /TR at 261 characters and an inline claude
REM command line blows past that -- measured 313 and 478 for two of these three
REM before they moved here.
REM
REM   run.cmd handoff-sweep | branch-record | gate-log
REM
REM ASCII only, like register.ps1: cmd is no more forgiving about a stray
REM CP1252 quote than PowerShell 5.1 is.
setlocal

REM A routine's cwd decides which CLAUDE.md, which skills and which
REM package.json it sees, so resolve the repo from this script rather than
REM trusting whatever was current when the scheduler fired.
cd /d "%~dp0..\.." || exit /b 1

if not exist ".kingdom\routines" mkdir ".kingdom\routines"
set "LOG=.kingdom\routines\%~1.log"
>>"%LOG%" echo [%DATE% %TIME%] %~1

if /i "%~1"=="handoff-sweep" goto handoff_sweep
if /i "%~1"=="branch-record" goto branch_record
if /i "%~1"=="gate-log"      goto gate_log

REM Degrade visibly, per HANDOFF.md operating rule 3: a typo in a task
REM definition must say so in the log rather than exit clean.
>>"%LOG%" echo ERROR unknown routine "%~1"
exit /b 2

REM gate-log spends no model. It runs the gate and appends the printed summary,
REM so the suite count becomes something a later session can read.
:gate_log
>>"%LOG%" 2>&1 call npm.cmd test
exit /b %ERRORLEVEL%

REM acceptEdits because correcting a contradicted claim means writing the file
REM it lives in. --permission-prompts none is the restrictive setting, not a
REM bypass: with nobody at the console, anything that would prompt is denied
REM instead of hanging the task until the next run overlaps it.
:handoff_sweep
call :need_claude || exit /b 1
>>"%LOG%" 2>&1 call "%CLAUDE%" -p "/handoff-audit" --permission-mode acceptEdits --permission-prompts none
exit /b %ERRORLEVEL%

REM Ancestry lies here: this repository squash-merges, so a merged branch does
REM not appear under `git branch -r --merged`. Read the PR record, report only.
:branch_record
call :need_claude || exit /b 1
>>"%LOG%" 2>&1 call "%CLAUDE%" -p "Run: gh pr list --state all --json headRefName,state,mergedAt. Then list every branch still present on origin whose pull request is merged. Report only; delete nothing." --allowed-tools "Bash(gh *) Bash(git *)" --permission-prompts none
exit /b %ERRORLEVEL%

REM A scheduled task does not always inherit the interactive PATH. Resolve
REM claude at run time and fail loudly into the log when it is absent.
REM
REM Every invocation above goes through `call`, including claude's. On this
REM machine `where claude` is an .exe, but an npm-installed one is a .cmd shim,
REM and one batch file invoking another WITHOUT `call` transfers control instead
REM of returning -- so the following `exit /b` is never reached. Probed both
REM ways: without `call` the follow-on line is skipped, with it the line runs.
REM src/agent.js:103 refuses .cmd/.ps1 shims outright for the same reason.
:need_claude
for /f "delims=" %%i in ('where claude 2^>nul') do set "CLAUDE=%%i"
if not defined CLAUDE (
  >>"%LOG%" echo ERROR claude is not on PATH for this task's user; routine did not run
  exit /b 1
)
exit /b 0
