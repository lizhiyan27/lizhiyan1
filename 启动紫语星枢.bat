@echo off
cd /d "%~dp0"
if exist "紫语星枢.exe" (
  start "" "紫语星枢.exe"
) else (
  start "" "node_modules\electron\dist\electron.exe" "%~dp0"
)
