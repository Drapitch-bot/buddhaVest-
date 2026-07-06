@echo off
cd /d "%~dp0"

if not exist venv (
    echo Creating virtual environment...
    python -m venv venv
)

call venv\Scripts\activate

echo Installing/updating dependencies...
pip install -q -r requirements.txt

if not exist cloudflared.exe (
    echo.
    echo ============================================================
    echo  לא נמצא cloudflared.exe בתיקייה הזו.
    echo.
    echo  כדי להשתמש בקישור משותף, צריך להוריד אותו פעם אחת:
    echo  1. גש לכתובת:
    echo     https://github.com/cloudflare/cloudflared/releases/latest
    echo  2. הורד את הקובץ: cloudflared-windows-amd64.exe
    echo  3. שנה את שמו ל: cloudflared.exe
    echo  4. העבר אותו לתיקייה הזו:
    echo     %~dp0
    echo  5. הרץ את הקובץ הזה שוב.
    echo ============================================================
    pause
    exit /b 1
)

echo.
echo מפעיל את שרת BuddhaVest...
start "BuddhaVest - Server (do not close)" cmd /k "call venv\Scripts\activate && uvicorn main:app --host 0.0.0.0"

timeout /t 4 /nobreak >nul

echo.
echo ============================================================
echo  נפתח עוד חלון - הקישור המשותף שלך יופיע שם, ויראה כמו:
echo    https://xxxxx-xxxx-xxxx.trycloudflare.com
echo.
echo  העתק את הקישור הזה ושלח למי שתרצה.
echo  שני החלונות חייבים להישאר פתוחים כל עוד רוצים שהקישור יעבוד.
echo ============================================================
echo.
start "BuddhaVest - Shareable Link (do not close)" cmd /k "cloudflared.exe tunnel --url http://localhost:8000"
