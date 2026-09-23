@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "INSTALL_RESULT=%ERRORLEVEL%"
if not defined CI pause
exit /b %INSTALL_RESULT%
