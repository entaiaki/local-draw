@echo off
setlocal
cd /d E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4
REM Match 绘世启动器 .launcher\preference.json: listen=true, port=8186, cpu_vae=true.
REM Clear inherited Python env so Hermes/other venv packages do not shadow ComfyUI embedded Python.
set PYTHONPATH=
set VIRTUAL_ENV=
set PYTHONNOUSERSITE=1
"E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4\python\python.exe" -s main.py --listen 127.0.0.1 --port 8186 --cpu-vae
