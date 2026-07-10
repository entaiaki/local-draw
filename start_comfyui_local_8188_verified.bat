@echo off
setlocal
cd /d E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4
REM Alternate verified Hermes-safe launch used during setup on port 8188.
set PYTHONPATH=
set VIRTUAL_ENV=
set PYTHONNOUSERSITE=1
"E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4\python\python.exe" -s main.py --listen 127.0.0.1 --port 8188
