@echo off
rem One-time: add the "project" scope to your gh login (approve in the browser), preview, then build/sync the board.
set GH=gh
where gh >nul 2>nul || set GH="C:\Program Files\GitHub CLI\gh.exe"
%GH% auth refresh -h github.com -s project,read:project
if errorlevel 1 (echo gh auth refresh failed & pause & exit /b 1)
node "%~dp0create-project-board.mjs" --dry-run
echo.
choice /M "Apply this plan to the live board"
if errorlevel 2 (echo Cancelled. & pause & exit /b 0)
node "%~dp0create-project-board.mjs"
pause
