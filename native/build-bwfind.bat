@echo off
REM Builds the live match scanner: native\bwfind.exe
REM
REM Needs Visual Studio Build Tools (any 2019+ edition). Run this from a plain
REM cmd prompt - it locates and enters the x64 developer environment itself.
REM
REM Unlike build-stats.bat, this is a single translation unit with no vendored
REM dependencies (no CascLib, no OpenBW) - it only reads the running game's
REM memory (ReadProcessMemory + psapi.lib), it never touches replay files.

setlocal enabledelayedexpansion
set ROOT=%~dp0

if defined VSCMD_ARG_TGT_ARCH goto :havevs
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "!VSWHERE!" (
  echo Could not find vswhere.exe. Install Visual Studio Build Tools with "Desktop development with C++".
  exit /b 1
)
for /f "usebackq tokens=*" %%i in (`""!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath"`) do set VSPATH=%%i
if not defined VSPATH (
  echo Could not find Visual Studio Build Tools. Install "Desktop development with C++".
  exit /b 1
)
call "!VSPATH!\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 || exit /b 1
:havevs

echo Compiling scanner...
cl /nologo /std:c++17 /EHsc /O2 /MT /DNDEBUG "%ROOT%src\bwfind.cpp" /Fe"%ROOT%bwfind.exe" /link psapi.lib
if errorlevel 1 exit /b 1

echo.
echo Done: %ROOT%bwfind.exe
endlocal
