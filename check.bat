@echo off
REM ---------------------------------------------------------------
REM  check.bat - is the live server running the code on this machine,
REM  and is everything that should be switched on actually on?
REM
REM  Answers without trusting anybody's report. Run it whenever you
REM  are told something is "fixed".
REM
REM  ASCII ONLY - ON PURPOSE. See the note in push.bat: cmd.exe reads
REM  a .bat by BYTE OFFSET, so a codepage switch mid-file corrupts
REM  every line after it.
REM ---------------------------------------------------------------

setlocal
cd /d "%~dp0"

REM Refresh the remote ref first, otherwise "pushed to GitHub" compares
REM against whatever this machine last happened to hear about.
git fetch --quiet 2>nul

node scripts\check-live.js
endlocal & exit /b %errorlevel%
