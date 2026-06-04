@echo off
title Loris Server
echo ========================================================
echo   Starting Loris secure local server...
echo ========================================================
echo.

:: Launch the default browser to open the local page
start http://localhost:3005

:: Run the Node.js backend
cd /d "%~dp0"
"%~dp0node.exe" server.js

pause
