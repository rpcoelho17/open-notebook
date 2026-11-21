@echo off
title Stop Open Notebook
echo Stopping Open Notebook services...

taskkill /FI "WINDOWTITLE eq Open Notebook - *" /T /F >nul 2>&1
wsl -d Ubuntu -- bash -lc "pkill -x surreal || true" >nul 2>&1

echo All Open Notebook services stopped.
timeout /t 2 /nobreak >nul
