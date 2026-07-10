@echo off
setlocal
cd /d E:\AI\natureDrawImage
start "ComfyUI 8186" cmd /k start_comfyui_local.bat
timeout /t 8 /nobreak >nul
start "natureDrawImage backend 8080" cmd /k start_naturedraw_server.bat
