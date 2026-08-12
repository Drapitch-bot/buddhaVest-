@echo off
REM ---------------------------------------------------------------
REM  ci.bat - run the GitHub Actions workflow HERE, before pushing.
REM
REM  Runs every step in .github\workflows\ci.yml, exactly as written.
REM  Not a copy of the checks - it reads the same file GitHub reads,
REM  so it cannot drift out of step with what actually runs there.
REM
REM  Usage:  .\ci.bat            all jobs
REM          .\ci.bat python     server only  (faster)
REM          .\ci.bat javascript app only
REM
REM  Needs bash, which comes with Git for Windows.
REM
REM  ASCII ONLY - ON PURPOSE. See the note in push.bat: cmd.exe reads
REM  a .bat by BYTE OFFSET, so a codepage switch mid-file corrupts
REM  every line after it.
REM ---------------------------------------------------------------

setlocal
cd /d "%~dp0"

node scripts\run-ci.js %1
endlocal & exit /b %errorlevel%
