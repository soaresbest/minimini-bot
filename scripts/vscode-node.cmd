@echo off
setlocal
set "NODE_FILE="
call :accept_node "%USERPROFILE%\.minimini-bot\runtime\node\node.exe"
if defined NODE_FILE goto run
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_FILE call :accept_node "%%I"
if not defined NODE_FILE (
  echo Erro: Node.js 24 nao encontrado. Pressione F5 novamente para preparar o ambiente. 1>&2
  exit /b 1
)
:run
"%NODE_FILE%" %*
exit /b %ERRORLEVEL%

:accept_node
if not exist "%~1" exit /b 0
set "CANDIDATE_VERSION="
for /f "delims=" %%V in ('""%~1" --version 2^>nul"') do set "CANDIDATE_VERSION=%%V"
if "%CANDIDATE_VERSION:~0,4%"=="v24." set "NODE_FILE=%~1"
exit /b 0
