@echo off
cd /d "%~dp0"
set "LAN_IP="
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /C:"IPv4"') do (
  set "LAN_IP=%%A"
  goto got_ip
)
:got_ip
set "LAN_IP=%LAN_IP: =%"
if "%LAN_IP%"=="" set "LAN_IP=127.0.0.1"

echo Starting sample label system...
echo.
echo This computer: http://localhost:8080
echo LAN access:    http://%LAN_IP%:8080
echo.
echo Keep this window open while using the system.
echo Press Ctrl+C to stop the service.
echo.
netstat -ano | findstr /R /C:":8080 .*LISTENING" >nul
if not errorlevel 1 (
  echo The service is already running.
  echo Open: http://%LAN_IP%:8080
  echo.
  pause
  exit /b
)

if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" server.js
) else (
  node server.js
)
pause
