@echo off
REM Quick run script - assumes build.bat has been run at least once

if not exist spiro.exe (
    echo spiro.exe not found. Running build.bat first...
    call build.bat
    exit /b
)

if not exist .env (
    echo Creating .env from .env.example...
    copy .env.example .env
)

echo Loading environment variables from .env...
for /f "usebackq tokens=1,* delims==" %%a in (.env) do (
    echo %%a | findstr /r "^#" >nul
    if errorlevel 1 (
        if not "%%a"=="" (
            set "%%a=%%b"
        )
    )
)

if "%PORT%"=="" set PORT=8484

echo Starting server on http://localhost:%PORT%
echo Press Ctrl+C to stop the server
echo.

spiro.exe
