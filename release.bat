@echo off
REM ---------------------------------------------------------------
REM  release.bat - publish an OTA to the LIVE (Play Store) users.
REM
REM  Usage:  .\release.bat "what changed"
REM
REM  push.bat   -> branch "preview"     = the APK on your own phone
REM  release.bat-> branch "production"  = people who installed from Play
REM
REM  These are two separate channels. An update published to preview is
REM  invisible to Play Store users, and vice versa. Every OTA from
REM  sessions 6-8 went to preview only - fine while nothing was live,
REM  but once the app is on Play, a fix has to go to BOTH or store
REM  users keep the bug.
REM
REM  ASCII ONLY - ON PURPOSE. See the note in push.bat.
REM ---------------------------------------------------------------

setlocal
cd /d "%~dp0"

set "MSG=%~1"
if "%MSG%"=="" set "MSG=Update"

echo.
echo   Publishing to branch: production  (LIVE Play Store users)
echo   Message: %MSG%
echo.
echo   Press Ctrl+C now if you meant .\push.bat (your own test phone).
timeout /t 5

call eas update --branch production --message "%MSG%"
if errorlevel 1 goto :fail

echo.
echo   DONE - live users get this on their next app launch.
endlocal & exit /b 0

:fail
echo.
echo   FAILED - see the error above.
endlocal & exit /b 1
