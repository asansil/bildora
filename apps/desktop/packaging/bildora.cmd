@echo off
rem The bildora command: the app's own binary, running as Node, so nothing else needs installing.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0Bildora.exe" "%~dp0resources\app.asar\node_modules\@bildora\cli\dist\bin.js" %*
exit /b %ERRORLEVEL%
