@echo off
rem Asks for a value with set /p, for tests of console scripts.
set /p "answer=Pick a number: "
echo PICKED %answer%
if "%answer%"=="" exit /b 3
exit /b 0
