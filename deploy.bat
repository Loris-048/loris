@echo off
title Loris Git Deployer
echo ========================================================
echo   Loris Auto-Compiler and GitHub Pages Deployer
echo ========================================================
echo.

:: 1. Run build script
echo [1/3] Running modular code packaging...
cd /d "%~dp0Loirs"
node build.js
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Build failed! Deployment aborted.
    pause
    exit /b %errorlevel%
)
cd /d "%~dp0"
echo.

:: 2. Check Git Remote Origin
echo [2/3] Checking Git remote configuration...
git remote get-url origin >nul 2>&1
if %errorlevel% neq 0 (
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
    git remote add origin %repo_url%
    echo [SUCCESS] Linked remote origin to: %repo_url%
    echo.
) else (
    echo [SUCCESS] GitHub repository is already linked.
)

:: 3. Git Add, Commit and Push
echo [3/3] Committing and uploading latest index.html to GitHub...
git add .
git commit -m "Auto-build and deploy: updated mobile-optimized layouts and collapsible headers"
echo.
echo Pushing changes to GitHub Pages branch (main)...
git push origin main
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Push failed! Please check your network, SSH keys, or GitHub login.
    pause
    exit /b %errorlevel%
)

echo.
echo ========================================================
echo   🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!
echo   Please refresh your GitHub Pages URL in 10-15 seconds!
echo ========================================================
echo.
pause
