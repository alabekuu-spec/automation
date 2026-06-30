@echo off
setlocal EnableExtensions
title enaadam ticket grab
cd /d "%~dp0"

REM Node is installed but not on PATH on this machine - add it for this session.
set "PATH=C:\Program Files\nodejs;%PATH%"

echo ============================================================
echo    ENAADAM TICKET GRAB  -  all logged-in accounts
echo ============================================================
echo  Runs every account that has a saved login profile, watches
echo  for the event to go live, then grabs up to 2 seats each.
echo  Carted windows stay OPEN so you can pay.
echo ------------------------------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found at C:\Program Files\nodejs. Install it or fix run.bat.
  echo.
  pause
  exit /b 1
)

REM 1) Event URL ^(REQUIRED^). Paste the published event link. Blank = bare /ticket.
set "EVENT_URL="
set /p "EVENT_URL=Paste EVENT URL (blank = bare /ticket): "

REM 2) Optional scheduled start, ISO e.g. 2026-07-08T03:00:00Z. Blank = start now.
set "START_AT="
set /p "START_AT=Scheduled start time ISO (blank = start now): "

REM 3) Real-time debug dumps (screenshot + DOM + selectors on any problem).
set "DEBUG="
set /p "DBG=Enable real-time debug dumps? (y/N): "
if /I "%DBG%"=="y" set "DEBUG=true"

REM 4) Optional: specific account numbers (space separated). Blank = ALL accounts.
set "ACCTS="
set /p "ACCTS=Account numbers to run (blank = ALL logged-in): "

echo.
echo ------------------------------------------------------------
if defined EVENT_URL   echo   EVENT_URL = set
if not defined EVENT_URL echo   EVENT_URL = NOT set [bare /ticket - WATCH may not trigger]
if defined START_AT    echo   START_AT  = %START_AT%
if not defined START_AT echo   START_AT  = now
if defined DEBUG       echo   DEBUG     = on
if not defined DEBUG    echo   DEBUG     = off
if defined ACCTS       echo   ACCOUNTS  = %ACCTS%
if not defined ACCTS    echo   ACCOUNTS  = all
echo ------------------------------------------------------------
echo  About to launch browsers for the account(s) above. Each carted
echo  window stays open and the PAY NOW list appears at the end.
echo ============================================================
echo.
echo  Press any key to LAUNCH, or close this window to CANCEL.
pause >nul
echo.

node enaadam-grab.js %ACCTS%

echo.
echo ============================================================
echo   Run finished. Scroll up for the PAY NOW list (if any).
echo   Diagnostics (if a problem occurred) are in grab-shots\.
echo ============================================================
pause
endlocal
