# natureDrawImage

> 给老婆套个壳，让她在浏览器里跑。

一个塞进 ComfyUI 前面的轻量级网页控制台，主打**多人共用一台显卡**的场景：每个浏览器各选各的工作流、各写各的 prompt，但同一时刻只有一个人在用 GPU，其它人能实时看到当前任务进度。

仓库：<https://github.com/afoim/natureDrawImage>

—— 单文件 FastAPI 后端 + Tailwind CDN 前端，无构建步骤，`uv run` 起飞。

## 它能做什么

- **工作流管理**：列出 / 搜索 ComfyUI 已保存的工作流，每个工作流可配同名缩略图
- **三种 prompt 写法**：
  - 直接 Tag：自己写 / 复制工作流内置 prompt
  - 自然语言翻译：LM Studio 把中/英文描述翻译成 SD/Pony/Illustrious tag
  - 改写模式：让 LLM 基于现有 prompt 整体重写（智能增删）
  - 覆写模式：忽略工作流内置 prompt，只用你写的
- **LM Studio 流式输出**直接显示在页面上
- **自定义分辨率**：覆盖工作流里所有 `width/height` 节点（含 EmptyLatent / ModelSamplingFlux 等），留空走默认；提供 `832×1216 / 1024×1024 / 512×512` 一键预设
- **WebSocket 实时进度**：节点名 + 步进进度条 + 取消按钮
- **全局并发锁**：同一时刻只允许一个生图任务，其它页面在状态横幅里看到当前进度，但不会污染本地工作流
- **ComfyUI 输出目录浏览**：分页加载、原生 `loading="lazy"`，配 GLightbox 灯箱，左右键翻图，**打开后异步注入该图的正向 prompt**，一键复制 / 填回输入框
- **18+ 年龄确认弹窗** + 全屏遮罩，年龄确认前看不到任何已生成图
- **热重载**开发模式

## 速览

```
┌─ 全局任务进度（其它人正在跑 → 此处可见）
├─ 当前工作流 [缩略图] [节点/连线统计]
├─ 工作流卡片网格 [图][模型][自定义文本]
├─ 生图表单
│  ├─ 直接 Tag / 自然语言描述
│  ├─ ☑ 改写模式  ☐ 覆写模式
│  ├─ 内置 prompt 预览（一键复制到 Tag 框）
│  ├─ 宽×高 + 预设按钮
│  └─ ▶ 开始生成 / ✕ 取消
├─ 进度区（日志 + LLM 流式 + 进度条）
├─ 结果区（本次生成的图）
└─ 输出目录画廊（懒加载 + 灯箱 + Prompt 注入）
```

## 安装与启动

需要 Python 3.10+。推荐用 [uv](https://github.com/astral-sh/uv)。

```bash
uv pip install -r web/requirements.txt
# 或 pip install -r web/requirements.txt
```

```bash
# 默认 127.0.0.1:8080
uv run web/app.py

# 监听所有地址（局域网共享）
uv run web/app.py --host 0.0.0.0

# 开发：保存 .py 自动重启
uv run web/app.py --host 0.0.0.0 --reload
```

打开 <http://127.0.0.1:8080>，第一次会弹 18+ 确认。

## 配置

打开 `web/app.py`，顶部就是全部配置：

```python
COMFYUI_HOST = "127.0.0.1"
COMFYUI_PORT = 8000

LMS_HOST = "127.0.0.1"     # LM Studio
LMS_PORT = 1234

WEB_HOST = "127.0.0.1"
WEB_PORT = 8080

# ComfyUI 输出目录（只读浏览，严格防穿越）
OUTPUT_DIR_STR = r"C:\Users\acofo\Documents\ComfyUI\output"
```

LM Studio 需要开启 OpenAI 兼容服务（默认 `http://127.0.0.1:1234/v1`）并加载任意聊天模型。如果你不需要 LLM 翻译/改写，纯 Tag 模式不会触发它。

## 工作流缩略图

把图片放到 `web/thumbnails/`，文件名与工作流匹配（去掉 `.json`）：

- `flux/portrait.json` → `web/thumbnails/flux/portrait.png`（保留子目录）
- 或 `web/thumbnails/portrait.png`（仅 basename）

支持 `.png .jpg .jpeg .webp .gif`。

约定俗成：工作流命名建议 `[模型] - [自定义文本].json`，如 `WAI - 莫宁.json`，前端会自动拆分两行显示。

## 目录结构

```
web/
├── app.py                  FastAPI 后端（单文件，~800 行）
├── requirements.txt
├── static/
│   ├── index.html          前端（单文件 + Tailwind/GLightbox CDN）
│   └── favicon.avif
└── thumbnails/             工作流缩略图
```

工作流选择是**纯前端**的，存在浏览器 `localStorage` 里——后端不持久化任何"当前工作流"状态，所以多人共用一个后端时不会互相覆盖。

## API

| 路径 | 说明 |
|---|---|
| `GET  /api/workflows` | 列出所有工作流（含 `thumbnail` 布尔） |
| `GET  /api/workflows/current?path=` | 工作流摘要 + 默认分辨率 + 内置正向 prompt |
| `GET  /api/thumbnail?path=` | 工作流缩略图 |
| `GET  /api/output/list?limit=&offset=` | 列 ComfyUI 输出目录（按 mtime 倒序，分页） |
| `GET  /api/output/file?path=` | 取输出图（防路径穿越） |
| `GET  /api/output/meta?path=` | 读 PNG 元数据，提取正向 prompt |
| `GET  /api/image?filename=&subfolder=&type=` | 代理 ComfyUI 实时输出图 |
| `POST /api/translate` | 一次性 LLM 翻译（CLI/脚本可调） |
| `POST /api/interrupt` | 中断当前任务 |
| `WS   /ws/run` | 提交生图任务 + 接收进度 |
| `WS   /ws/status` | 订阅全局任务状态（多页同步） |

`/ws/run` 客户端首包：

```jsonc
{
  "workflow_path": "flux/portrait.json",
  "direct_prompt": "",
  "nl_prompt": "",
  "rewrite": true,
  "override": false,
  "width": null,
  "height": null
}
```

服务端推送：

```jsonc
{"type": "log",       "message": "..."}
{"type": "llm_start"}
{"type": "llm_chunk", "delta": "..."}
{"type": "llm_done",  "text": "..."}
{"type": "prompt_id", "prompt_id": "...", "final_prompt": "..."}
{"type": "progress",  "node": "KSampler", "value": 10, "max": 20, "done": 3, "total": 8}
{"type": "image",     "url": "/api/image?...", "filename": "...", "subfolder": "", "image_type": "output"}
{"type": "done",      "final_prompt": "...", "count": 1}
{"type": "error",     "message": "..."}
```

## 安全

- 输出目录浏览只读，路径校验三重防护：拒绝绝对路径、拒绝 `..` 段、`Path.resolve().relative_to(OUTPUT_DIR.resolve())` 必须通过
- 缩略图同样走防穿越校验
- 18+ 弹窗在交互前用全屏不透明遮罩盖住所有图

但请注意：本工具**没有用户系统**，假定运行在你信任的网络环境（本机 / 内网 / VPN）。不要把 `--host 0.0.0.0` 直接暴露到公网。

## 常用资源

- [danbooru-artist 画师库](https://www.downloadmost.com/NoobAI-XL/danbooru-artist/)：换画风用，格式 `by xxx` 或 `(by xxx:1.2)`
- [danbooru-character 角色库](https://www.downloadmost.com/NoobAI-XL/danbooru-character/)：换角色用，建议配合无 Lora 工作流
- [新手教程 · 从零开始造老婆](https://2x.nz/posts/ai-wife/)

## 来源

后端核心（`workflow_to_prompt_api` 等）移植自 `dev/comfyui.py`，一个 NoneBot Telegram 插件，原本只服务于一个聊天里的特定 chat。这个项目把它扒出来，套上一层 web 控制台，让本机/局域网里更多人能用。

## License

[LICENSE](./LICENSE)
