@echo off
cd /d "%~dp0"

if not exist venv (
    echo Creating virtual environment...
    python -m venv venv
)

call venv\Scripts\activate

echo Installing/updating dependencies...
pip install -q -r requirements.txt

echo.
echo Starting BuddhaVest API server...
echo Open http://127.0.0.1:8000/docs in your browser to test it.
echo Press CTRL+C to stop the server.
echo.

uvicorn main:app
