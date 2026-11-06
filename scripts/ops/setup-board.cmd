@echo off
rem One-time: add the "project" scope to your gh login (approve in the browser), then build the board.
"C:\Program Files\GitHub CLI\gh.exe" auth refresh -h github.com -s project,read:project
if errorlevel 1 (echo gh auth refresh failed & pause & exit /b 1)
node "%~dp0create-project-board.mjs"
pause
