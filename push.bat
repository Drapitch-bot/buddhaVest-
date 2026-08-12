@echo off
REM ---------------------------------------------------------------
REM  push.bat - commit, push, and publish an OTA update in one go.
REM
REM  Usage:  .\push.bat "your commit message"
REM          .\push.bat                          (generic message)
REM          .\push.bat "message" skipci         (skip the CI gate)
REM
REM  Step 1 runs the GitHub Actions workflow locally and STOPS if
REM  anything fails. Added 2026-08-12, after a push went out red and
REM  the first anyone knew was an email from GitHub. Running the test
REM  files by hand is not the same thing: over half of ci.yml is
REM  lint-style checks on the source, and one of those was what broke.
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

REM --- 0. CI gate --------------------------------------------------
REM Nothing below this point should run against a red build. Push it
REM anyway with:  .\push.bat "message" skipci
if /i "%~2"=="skipci" goto :skipci
echo.
echo [0/5] running the CI workflow locally
node scripts\run-ci.js
if errorlevel 1 goto :ciFailed
goto :ciDone
:skipci
echo.
echo [0/5] CI gate SKIPPED at your request
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
echo   Fix what is listed above, or override with: .\push.bat "msg" skipci
endlocal & exit /b 1

:gitbusy
echo.
echo   A git process is already running. Close it and try again.
endlocal & exit /b 1

:fail
echo.
echo   FAILED - see the error above. Later steps were not run.
endlocal & exit /b 1
