@echo off
REM Build and run Spiro application
REM This script loads environment variables from .env file and starts the server

echo Building Spiro application...
go build -o spiro.exe
if %ERRORLEVEL% NEQ 0 (
    echo Build failed!
    pause
    exit /b 1
)

echo Build successful!
echo.

REM Check if .env file exists
if not exist .env (
    echo Creating .env from .env.example...
    copy .env.example .env
    echo.
)

echo Loading environment variables from .env...
for /f "usebackq tokens=1,* delims==" %%a in (.env) do (
    REM Skip comments and empty lines
    echo %%a | findstr /r "^#" >nul
    if errorlevel 1 (
        if not "%%a"=="" (
            set "%%a=%%b"
        )
    )
)

if "%PORT%"=="" set PORT=8484

echo Production mode: %PROD%
echo.
echo Starting server on http://localhost:%PORT%
echo Press Ctrl+C to stop the server
echo.

spiro.exe
