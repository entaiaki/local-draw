# natureDrawImage

ComfyUI 网页控制台 + LM Studio Prompt 改写。基于 FastAPI，单文件后端，前端用 Tailwind CDN，无需构建。

仓库：<https://github.com/afoim/natureDrawImage>

## 功能

- 列出 / 搜索 / 切换 ComfyUI 已保存的工作流，可为每个工作流配缩略图
- 工作流 JSON → ComfyUI Prompt API 完整转换（含 subgraph 展开、proxyWidgets、seed widget 跳过）
- 三种 Prompt 模式：
  - `直接 Tag` — 直接把 tag 拼到工作流内置 prompt
  - `自然语言翻译` — LM Studio 把中/英文描述翻译成 SD/Pony/Illustrious tag
  - `改写模式` — 让 LLM 基于现有 prompt 增量修改
  - `句子模式` — 输出英文自然语言句子（适合 Flux/SD3）
- LM Studio 流式输出实时显示在页面上
- 自定义出图分辨率（覆盖工作流里所有 `width/height` 节点），留空使用工作流默认
- WebSocket 实时进度（节点 + 进度条）+ 取消按钮
- 本会话历史画廊，点击新标签页打开原图
- 热重载开发模式

## 目录结构

```
web/
├── app.py                FastAPI 后端（单文件）
├── requirements.txt
├── state.json            （运行时生成）当前选中的工作流
├── static/
│   ├── index.html        前端
│   └── favicon.avif
└── thumbnails/           工作流缩略图（按工作流路径同名查找）
```

## 安装与启动

```bash
pip install -r web/requirements.txt
# 或 uv：uv pip install -r web/requirements.txt
```

```bash
# 默认 127.0.0.1:8080
python -m web.app

# 监听所有地址
python -m web.app --host 0.0.0.0

# 开发：保存 .py 自动重启
python -m web.app --reload

# uv 用户也行
uv run web/app.py --host 0.0.0.0 --reload
```

打开 <http://127.0.0.1:8080>。

## 配置

编辑 `web/app.py` 顶部：

```python
COMFYUI_HOST = "127.0.0.1"
COMFYUI_PORT = 8000

LMS_HOST = "127.0.0.1"     # LM Studio
LMS_PORT = 1234

WEB_HOST = "127.0.0.1"
WEB_PORT = 8080
```

LM Studio 需要开启 OpenAI 兼容服务（默认 `http://127.0.0.1:1234/v1`），并加载一个聊天模型。

## 工作流缩略图

把图片放到 `web/thumbnails/`，文件名与工作流匹配（去掉 `.json`）：

- 工作流 `flux/portrait.json` → `web/thumbnails/flux/portrait.png`（保留子目录）
- 或 `web/thumbnails/portrait.png`（仅 basename）

支持 `.png .jpg .jpeg .webp .gif`。

## API

| 路径 | 说明 |
|---|---|
| `GET  /api/workflows` | 列出工作流（含 `thumbnail` 标志） |
| `POST /api/workflows/select` | 选中并持久化工作流 `{path}` |
| `GET  /api/workflows/current` | 当前工作流摘要 + 默认分辨率 |
| `GET  /api/thumbnail?path=...` | 工作流缩略图 |
| `GET  /api/image?filename=&subfolder=&type=` | 代理 ComfyUI 输出图 |
| `POST /api/translate` | 一次性 LLM 翻译 |
| `POST /api/interrupt` | 中断当前任务 |
| `WS   /ws/run` | 提交并实时接收进度 |

`/ws/run` 协议：

```jsonc
// → 客户端首条
{"direct_prompt": "", "nl_prompt": "", "rewrite": false,
 "sentence_mode": false, "width": null, "height": null}

// ← 服务端推送
{"type": "log", "message": "..."}
{"type": "llm_start"}
{"type": "llm_chunk", "delta": "..."}
{"type": "llm_done", "text": "..."}
{"type": "prompt_id", "prompt_id": "...", "final_prompt": "..."}
{"type": "progress", "node": "KSampler", "value": 10, "max": 20, "done": 3, "total": 8}
{"type": "image", "url": "/api/image?...", "filename": "...", "subfolder": "", "image_type": "output"}
{"type": "done", "final_prompt": "...", "count": 1}
{"type": "error", "message": "..."}
```

## 来源

后端核心（`workflow_to_prompt_api` 等）移植自 `dev/comfyui.py`（一个 NoneBot Telegram 插件）。

## License

见 [LICENSE](./LICENSE)。
