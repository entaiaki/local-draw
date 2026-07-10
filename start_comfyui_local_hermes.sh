#!/usr/bin/env bash
set -euo pipefail
cd '/e/AI/ComfyUI-aki-v1.4/ComfyUI-aki-v1.4'
# Match 绘世启动器 .launcher/preference.json: listen=true, port=8186, cpu_vae=true.
# Hermes/venv-safe launcher: avoid leaking Hermes PYTHONPATH into ComfyUI embedded Python.
env -u PYTHONPATH -u VIRTUAL_ENV PYTHONNOUSERSITE=1 './python/python.exe' -s main.py --listen 127.0.0.1 --port 8186 --cpu-vae
