# natureDrawImage local deployment notes

## Paths

- Project: `E:\AI\natureDrawImage`
- Backend: `E:\AI\natureDrawImage\node-server`
- Existing ComfyUI / 绘世: `E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4`
- ComfyUI launcher config: `E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4\.launcher\preference.json`

## Verified launcher settings

`preference.json` currently contains:

```json
{
  "args": {
    "listen": true,
    "port": 8186,
    "cpu_vae": true,
    "xattn_optimization": 0
  }
}
```

So this local deployment points natureDrawImage to:

```text
http://127.0.0.1:8186
```

The `.env` in project root has been configured accordingly.

## Start

Recommended:

```bat
E:\AI\natureDrawImage\start_all_local.bat
```

Or manually:

```bat
E:\AI\natureDrawImage\start_comfyui_local.bat
E:\AI\natureDrawImage\start_naturedraw_server.bat
```

If you start ComfyUI via `A绘世启动器.exe`, make sure it listens on port `8186`, then start only:

```bat
E:\AI\natureDrawImage\start_naturedraw_server.bat
```

## Verified health checks

```text
Backend: http://127.0.0.1:8080/health -> 200
ComfyUI: http://127.0.0.1:8186/system_stats -> 200
GPU: NVIDIA GeForce RTX 5090, ~31.8 GB VRAM
ComfyUI version: 0.22.3
Python: 3.10.11
```

## Local admin token

Generate a local admin JWT for testing authenticated endpoints:

```bat
cd /d E:\AI\natureDrawImage\node-server
node scripts\generate_local_token.cjs
```

Use it as:

```text
Authorization: Bearer <token>
```

## Current caveat: workflow list

`GET http://127.0.0.1:8080/api/workflows` currently returns an empty list because the app scans ComfyUI's `user/default/workflows` as category folders. Your existing workflow files are mostly under:

```text
E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4\my_workflows
```

To make them appear in natureDrawImage, copy/sync selected workflow JSON files into subfolders under:

```text
E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4\user\default\workflows\<category>\*.json
```

Do not bulk-copy untrusted workflows unless you trust their custom nodes and model paths.
