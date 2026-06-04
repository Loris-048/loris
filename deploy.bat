@echo off
title Loris Git Deployer
cd /d "%~dp0"
"%~dp0node.exe" deploy.js
pause
