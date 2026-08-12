@echo off
REM Builds the replay simulator: native\bwstats.exe
REM
REM Needs Visual Studio Build Tools (any 2019+ edition). Run this from a plain
REM cmd prompt - it locates and enters the x64 developer environment itself.
REM
REM Built /O2: the simulator re-runs an entire game frame by frame, and an
REM unoptimized build is slow enough to matter on a 30-minute replay. Both
REM compile steps must agree on the CRT (/MT here) or the link fails. /MT also
REM means the exe carries the CRT and needs no redistributable, which matters
REM because this binary gets embedded into the shipped overlay exe.

setlocal enabledelayedexpansion
set ROOT=%~dp0
set OBJ=%ROOT%build

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

if not exist "%OBJ%\casc" mkdir "%OBJ%\casc"
if not exist "%OBJ%\stats" mkdir "%OBJ%\stats"

REM CascLib first, as a unity build via its own aggregator files. Only needs
REM rebuilding if the vendored copy changes, but it is cheap enough to always do.
echo Compiling CascLib...
cl /nologo /c /EHsc /std:c++17 /O2 /MT /DNDEBUG ^
  /I"%ROOT%vendor\casclib\src" /Fo"%OBJ%\casc\\" ^
  "%ROOT%vendor\casclib\sources-c.c" "%ROOT%vendor\casclib\sources-cpp.cpp"
if errorlevel 1 exit /b 1

echo Compiling simulator...
cl /nologo /EHsc /std:c++17 /O2 /MT /DNDEBUG ^
  /I"%ROOT%vendor\openbw" /I"%ROOT%vendor\casclib\src" /I"%ROOT%src" ^
  /Fo"%OBJ%\stats\\" /Fe"%ROOT%bwstats.exe" ^
  "%ROOT%src\main.cpp" "%OBJ%\casc\sources-c.obj" "%OBJ%\casc\sources-cpp.obj"
if errorlevel 1 exit /b 1

echo.
echo Done: %ROOT%bwstats.exe
endlocal
