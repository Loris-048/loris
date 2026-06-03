@echo off
title Loris Server
echo ========================================================
echo   Starting Loris secure local server...
echo ========================================================
echo.

:: Launch the default browser to open the local page
start http://localhost:3000

:: Run the Node.js backend
node server.js

pause
