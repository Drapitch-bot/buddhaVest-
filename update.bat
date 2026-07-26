@echo off
REM ── מפרסם עדכון OTA לערוץ preview ─────────────────────────────────
REM
REM למה קובץ ולא פקודה: הדבקה של שורת eas ארוכה ב-PowerShell נכפלה
REM שוב ושוב, וכתוצאה מכך --branch הופיע פעמיים ו-eas נכשל.
REM כאן יש מילה אחת להקליד, ואין דגלים שיכולים להיכפל.
REM
REM שימוש:   update.bat
REM          update.bat "הודעה משלך"

setlocal
set MSG=%~1
if "%MSG%"=="" set MSG=Update

echo.
echo   מפרסם ל-branch: preview
echo   הודעה: %MSG%
echo.

call eas update --branch preview --message "%MSG%"

echo.
if errorlevel 1 (
  echo   נכשל. אם כתוב "Flag --branch can only be specified once" —
  echo   השורה נכפלה בהדבקה. הקלד update.bat ידנית ונסה שוב.
) else (
  echo   הצליח. סגור את האפליקציה בטלפון לגמרי ופתח מחדש.
)
endlocal
