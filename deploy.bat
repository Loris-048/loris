@echo off
title Loris Git Deployer
echo ========================================================
echo   Loris Auto-Compiler and GitHub Pages Deployer (No-Leak Edition)
echo ========================================================
echo.

:: 1. Run build script
echo [1/3] Running modular code packaging...
cd /d "%~dp0"
"%~dp0node.exe" build.js
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Build failed! Deployment aborted.
    pause
    exit /b %errorlevel%
)
echo.

:: 2. Get GitHub Remote URL (From the main Git repository)
echo [2/3] Checking Git remote configuration...

:: Read remote URL securely without subshells
git config --get remote.origin.url > "%~dp0temp_url.txt" 2>nul
set "repo_url="
set /p repo_url=<"%~dp0temp_url.txt"
del "%~dp0temp_url.txt" >nul 2>&1

:: Read Git identity securely without subshells
git config user.name > "%~dp0temp_name.txt" 2>nul
set "git_name="
set /p git_name=<"%~dp0temp_name.txt"
del "%~dp0temp_name.txt" >nul 2>&1

git config user.email > "%~dp0temp_email.txt" 2>nul
set "git_email="
set /p git_email=<"%~dp0temp_email.txt"
del "%~dp0temp_email.txt" >nul 2>&1

if "%git_name%"=="" set "git_name=Loris Deployer"
if "%git_email%"=="" set "git_email=deployer@loris.local"

if "%repo_url%"=="" (
    echo [NOTICE] No GitHub repository linked to this project yet!
    echo Please enter your GitHub Repository URL.
    echo (Example: https://github.com/username/repository.git)
    echo.
    set /p repo_url="Enter URL: "
    if "%repo_url%"=="" (
        echo [ERROR] No URL entered. Deployment aborted.
        pause
        exit /b 1
    )
    :: Save it in the local dev Git configuration for future use
    git remote add origin %repo_url% >nul 2>&1
    echo [SUCCESS] Linked local repository remote origin to: %repo_url%
    echo.
) else (
    echo [SUCCESS] Linked repository detected: %repo_url%
)

:: 3. Double-Track Isolated Deployment (Only deploy index.html)
echo [3/3] Committing and pushing index.html to GitHub Pages...
echo.
echo Creating secure isolated environment...

:: Set up a clean, isolated shadow folder inside temp
if exist "%~dp0temp_deploy" rmdir /s /q "%~dp0temp_deploy"
mkdir "%~dp0temp_deploy"

:: Copy index.html to the shadow folder
copy "%~dp0index.html" "%~dp0temp_deploy\index.html" >nul

:: Navigate into the shadow folder and do isolated push
cd /d "%~dp0temp_deploy"
git init
git remote add origin %repo_url%
git config user.name "%git_name%"
git config user.email "%git_email%"
git add index.html
git commit -m "Auto-deploy production: compiled mobile collapses, alignment fixes, and visual unity"
git branch -M main

echo.
echo Pushing changes securely to GitHub Pages branch (main)...
git push -f origin main
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Push failed! Please check your network or GitHub permissions.
    cd /d "%~dp0"
    rmdir /s /q "%~dp0temp_deploy"
    pause
    exit /b %errorlevel%
)

:: Clean up shadow folder
cd /d "%~dp0"
rmdir /s /q "%~dp0temp_deploy"

echo.
echo ========================================================
echo   🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!
echo   All development files are 100% SECURE on your computer!
echo   Only index.html was uploaded to your GitHub Pages!
echo ========================================================
echo.
pause
