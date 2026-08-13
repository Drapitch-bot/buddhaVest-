@echo off
REM ---------------------------------------------------------------
REM  push.bat - commit, push, and publish an OTA update in one go.
REM
REM  Usage:  .\push.bat "your commit message"
REM          .\push.bat                          (generic message)
REM          .\push.bat "message" ci             (run CI first, stop if red)
REM
REM  The CI gate is OPT-IN. It was briefly the default on 2026-08-12
REM  and taking the machine down, so it is off unless you ask for it.
REM  Run the checks on their own any time with:  .\ci.bat
REM
REM  ASCII ONLY - ON PURPOSE. Do not add Hebrew text or a chcp line.
REM  cmd.exe reads a .bat by BYTE OFFSET, so switching the codepage
REM  partway through shifts every following line and the rest of the
REM  file is parsed as garbage. That is what broke the first version:
REM  every echo turned into "'...' is not recognized as a command"
REM  and nothing was committed or pushed.
REM ---------------------------------------------------------------

setlocal
cd /d "%~dp0"

set "MSG=%~1"
if "%MSG%"=="" set "MSG=Update"

REM --- 0. CI gate (OPT-IN) -----------------------------------------
REM This ran automatically for about an hour on 2026-08-12 and was
REM turned back off the same day: the machine went down every time
REM push.bat was run. A gate that can take the computer with it is
REM worse than the red build it was added to prevent, so it is now
REM explicit until the cause is confirmed and ruled out.
REM
REM   .\push.bat "message" ci     run the checks first, stop if red
REM   .\push.bat "message"        push without them (previous behaviour)
REM
REM Either way you can always run them on their own:  .\ci.bat
if /i not "%~2"=="ci" goto :ciDone
echo.
echo [0/5] running the CI workflow locally
node scripts\run-ci.js
if errorlevel 1 goto :ciFailed
:ciDone

REM --- 1. stale index.lock -----------------------------------------
REM git leaves this behind when a process is interrupted, and every
REM later commit then fails with "Unable to create index.lock: File
REM exists" without saying that IS the reason. Only remove it when no
REM git process is alive, or we would be wrecking a running commit.
if not exist ".git\index.lock" goto :nolock
tasklist /fi "imagename eq git.exe" 2>nul | find /i "git.exe" >nul
if not errorlevel 1 goto :gitbusy
echo [1/5] removing stale index.lock
del /f /q ".git\index.lock"
:nolock

REM --- 2. commit ---------------------------------------------------
echo.
echo [2/5] commit: %MSG%
git add -A
if errorlevel 1 goto :fail
git diff --cached --quiet
if not errorlevel 1 goto :nochanges
git commit -m "%MSG%"
if errorlevel 1 goto :fail
goto :pushit
:nochanges
echo       nothing staged - skipping commit
:pushit

REM --- 3. push -----------------------------------------------------
echo.
echo [3/5] git push
git push
if errorlevel 1 goto :fail

REM --- 4. OTA ------------------------------------------------------
echo.
echo [4/5] eas update --branch preview
call eas update --branch preview --message "%MSG%"
if errorlevel 1 goto :fail

echo.
echo   DONE.
echo   - Force-close the app on your phone, then reopen it (pulls the OTA).
echo   - Server changes (main.py) redeploy on Render by themselves, ~1 min.
echo   - Then check SHEL.L or BP.L: the price should be about 25, not 2578.
endlocal & exit /b 0

:ciFailed
echo.
echo   CI FAILED - nothing was committed, pushed or published.
echo   GitHub would have run exactly the same steps and mailed you.
echo   Fix what is listed above, or push without the gate: .\push.bat "msg"
endlocal & exit /b 1

:gitbusy
echo.
echo   A git process is already running. Close it and try again.
endlocal & exit /b 1

:fail
echo.
echo   FAILED - see the error above. Later steps were not run.
endlocal & exit /b 1
