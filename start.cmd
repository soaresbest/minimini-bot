@echo off
setlocal
set "PSModulePath="
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "START_RESULT=%ERRORLEVEL%"
if not defined CI pause
exit /b %START_RESULT%
