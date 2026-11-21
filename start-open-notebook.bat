@echo off
title Open Notebook Launcher
setlocal

set "ROOT=C:\FILES\Code\open-notebook"
set "PY=%ROOT%\.venv\Scripts\python.exe"

echo Starting Open Notebook stack...

echo [1/5] Starting SurrealDB (WSL :8000)...
start "Open Notebook - SurrealDB" /min wsl -d Ubuntu -- bash -lc "pkill -x surreal || true; exec surreal db start --bind 0.0.0.0:8000 --log info --user root --pass root rocksdb:/root/open-notebook-surreal/mydatabase.db"

timeout /t 2 /nobreak >nul

echo [2/5] Starting Codex + Whisper + Kokoro + Exa Bridge (:8088)...
start "Open Notebook - Voice & LLM Bridge" /min cmd /k "cd /d %ROOT% && "%PY%" "%ROOT%\scripts\codex_subscription_bridge.py" 8088"

echo [3/5] Starting Open Notebook FastAPI Backend (:5055)...
start "Open Notebook - API" /min cmd /k "cd /d %ROOT% && "%PY%" run_api.py"

echo [4/5] Starting Open Notebook Background Worker...
start "Open Notebook - Worker" /min cmd /k "cd /d %ROOT% && "%PY%" -c "import sys; from dotenv import load_dotenv; load_dotenv('.env'); from surreal_commands.cli.worker import main; sys.argv = ['surreal-commands-worker', '--import-modules', 'commands', '--max-tasks', '5']; main()""

echo [5/5] Starting Next.js Frontend (:3000)...
start "Open Notebook - Frontend" /min cmd /k "cd /d %ROOT%\frontend && npm.cmd run dev"

echo.
echo Waiting for services to come online...
timeout /t 5 /nobreak >nul

start "" "http://localhost:3000"

echo.
echo All 5 Open Notebook services launched (minimized in your taskbar).
echo Run stop-open-notebook.bat anytime to shut them all down.
timeout /t 4 /nobreak >nul
endlocal
