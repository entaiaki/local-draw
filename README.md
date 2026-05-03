# natureDrawImage

> 给老婆套个壳，让她在浏览器里跑。

一个塞进 ComfyUI 前面的轻量级网页控制台，主打**多人共用一台显卡**的场景：每个浏览器各选各的工作流、各写各的 prompt，但同一时刻只有一个人在用 GPU，其它人能实时看到当前任务进度。

仓库：<https://github.com/afoim/natureDrawImage>

—— 单文件 FastAPI 后端 + Tailwind CDN 前端，无构建步骤，`uv run` 起飞。

## 它能做什么

- **工作流管理**：列出 / 搜索 ComfyUI 已保存的工作流，支持缩略图、Lora 链接配置。「无 Lora」字样的工作流自动置顶
- **画风一键切换**：管理员预配画风卡片（tags + 缩略图），用户点击即选，tags 自动追加到 prompt 最前面
- **两种 prompt 写法**：
  - 直接 Tag：选择工作流后内置 prompt 自动填入，可直接编辑
  - 自然语言翻译：LLM 把中/英文描述翻译成 SD/Pony/Illustrious tag
  - 改写模式：让 LLM 基于现有 prompt 整体重写（智能增删）
- **多 LLM 后端**：支持 LM Studio（本地）、Google AI Studio、自定义 OpenAI 兼容 API，管理面板切换
- **分辨率管理**：管理员配置允许的分辨率预设，前端只能从预设中选择，后端强制校验
- **WebSocket 实时进度**：节点名 + 步进进度条 + 取消按钮
- **GPU 状态条**（顶栏）：轮询 `nvidia-smi`，显示 GPU/VRAM 占用、温度、功耗、风扇、频率
- **全局并发锁 + 旁观模式**：同一时刻只允许一个生图任务，其它页面在状态横幅里实时看到当前任务进度
- **ComfyUI 输出目录浏览**：分页加载，自建灯箱，左右键翻图，异步注入正向 prompt，可一键 Fork 工作流二改
- **Fork 工作流**：从输出 PNG 抽出 workflow，临时存在浏览器内存里提交生图；Fork 时自动匹配并还原画风选择
- **精选展示**：站长在 `/admin` 维护一组「优秀作品」，可拖拽排序、自定义提示语，游客首页可折叠展示
- **18+ 年龄确认弹窗** + 全屏遮罩，确认前看不到任何已生成图
- **公告系统**：管理员可开关公告、设置标题和内容
- **举报系统**：用户可举报图片，管理员可删图 / 封禁生图者 / 封禁举报者 / 驳回
- **限流配置**：单 IP 生图冷却 + 出图端点滑动窗口限流，全部在管理面板实时改
- **生图者 IP 溯源**：每张输出图的 IP 记录在 `web/creator_ips.txt`，灯箱里显示
- **IP 封禁 / 删图 / 批量删图**：管理面板手动维护，被封 IP 提交直接拒绝
- **giscus 评论区**
- **WebP 自动转码**：输出图、缩略图自动转 WebP 节省带宽
- **全局禁止搜索引擎索引**

## 速览

```
┌─ GPU 状态条（nvidia-smi）
├─ 公告横幅
├─ 全局任务进度（其它人正在跑 → 此处可见）
├─ 工作流卡片网格（搜索 + 选中高亮）
├─ 画风卡片（一键切换，有别名的优先显示）
├─ 生图表单
│  ├─ 直接 Tag（工作流内置 prompt 自动填入）
│  ├─ 自然语言描述（LLM 翻译/改写）
│  ├─ ☑ 改写模式
│  ├─ 分辨率预设按钮
│  └─ ▶ 开始生成 / ✕ 取消
├─ 进度区（日志 + LLM 流式 + 进度条）
├─ 结果区（本次生成的图）
├─ 精选展示（站长维护，可折叠）
├─ 输出目录画廊（懒加载 + 灯箱 + Fork）
└─ 评论区
```

## 前置要求

- **Python 3.10+**
- **ComfyUI** 已安装并正常运行
- **NVIDIA GPU**（用于 `nvidia-smi` 状态显示）
- **LLM 服务**（可选）：LM Studio / Google AI Studio / 任意 OpenAI 兼容 API

## 部署步骤

### 1. 安装依赖

推荐 [uv](https://github.com/astral-sh/uv)：

```bash
uv pip install -r web/requirements.txt
```

或用 pip：

```bash
pip install -r web/requirements.txt
```

依赖列表（`web/requirements.txt`）：

```
fastapi
uvicorn[standard]
httpx
websockets
pydantic
pillow
```

### 2. 修改配置

打开 `web/app.py`，修改顶部配置（**只需改这几行**）：

```python
# ========== IP / 端口配置 ==========
COMFYUI_HOST = "127.0.0.1"
COMFYUI_PORT = 8000

LMS_HOST = "127.0.0.1"     # LM Studio（可选）
LMS_PORT = 1234

WEB_HOST = "127.0.0.1"
WEB_PORT = 8080

# ComfyUI 输出目录（只读浏览）
OUTPUT_DIR_STR = r"C:\Users\acofo\Documents\ComfyUI\output"
# ComfyUI 工作流目录（自动扫描）
COMFYUI_WORKFLOWS_DIR = r"C:\Users\acofo\Documents\ComfyUI\user\default\workflows"
# ===================================
```

- `OUTPUT_DIR_STR`：改成你的 ComfyUI 实际输出目录
- `COMFYUI_WORKFLOWS_DIR`：改成你的 ComfyUI 工作流目录（通常是 `ComfyUI/user/default/workflows`）
- `COMFYUI_PORT`：改成你的 ComfyUI 端口（ComfyUI 默认 8188，确认你的实际端口）

### 3. 启动

```bash
# 默认只监听 127.0.0.1:8080（本机访问）
uv run web/app.py

# 监听所有地址（局域网 / 反向代理后端）
uv run web/app.py --host 0.0.0.0

# 已配好反向代理鉴权，跳过启动确认
uv run web/app.py --host 0.0.0.0 --i-have-configured-auth

# 开发模式：保存 .py 自动重启
uv run web/app.py --host 0.0.0.0 --reload
```

打开 <http://127.0.0.1:8080>。

> 只监听 `127.0.0.1` 时不会弹启动确认；监听非回环地址且未带 `--i-have-configured-auth` 时，会要求你在终端输入 `yes` 确认已经配好访问控制再继续启动。

### 4. 配置反向代理鉴权（生产部署必须）

**本服务自身不做任何鉴权。** `/admin` 与 `/api/admin/*` 公开可达——任何人能访问端口就能调用。

不要直接把 `--host 0.0.0.0` 暴露到公网。生产部署**必须**在反向代理上做访问控制，至少满足其一：

- **Cloudflare Access / Zero Trust**（推荐）
- **nginx auth_basic / auth_request**
- **IP 白名单**
- **私有网络**（Tailscale / WireGuard）

nginx 示例：

```nginx
location ~ ^/(admin|api/admin) {
  auth_basic "admin only";
  auth_basic_user_file /etc/nginx/.htpasswd;
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header X-Forwarded-For $remote_addr;
}
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header X-Forwarded-For $remote_addr;
}
```

### 5. 后续配置（管理面板）

以下配置全部在 `/admin` 管理面板中在线完成，无需改代码：

- **画风**：添加画风卡片（tags + 缩略图）
- **分辨率**：配置允许的分辨率预设
- **工作流缩略图 & Lora 链接**：为工作流上传缩略图、配置 Lora 链接、重命名工作流
- **LLM**：切换 LLM 服务商、配置 API Key
- **限流**：调整生图冷却、图片限流参数
- **公告**：开关公告、设置内容
- **精选**：维护精选展示

## 管理控制台 `/admin`

| 区块 | 功能 |
|---|---|
| 📢 公告管理 | 开关公告 + 标题 / 内容编辑 |
| 📐 分辨率管理 | 增删分辨率预设（宽 × 高 + 标签），自动保存 |
| 🖌️ 画风管理 | 增删画风卡片（tags + 别名 + 缩略图上传），自动保存 |
| 🔗 工作流缩略图 & Lora 链接 | 自动扫描 ComfyUI 目录，上传缩略图、配置链接、重命名工作流 |
| 🤖 LLM 配置 | LM Studio / Google AI Studio / 自定义 API 切换，测试连接 |
| ⚙️ 限流配置 | 生图冷却、图片限流、举报限制、GPU 轮询间隔、精选提示语 |
| 🚫 封禁 IP | 时间线显示、手动封禁/解封、查看某 IP 生图记录、批量删图 |
| 📝 举报管理 | 待处理举报列表，支持删图/封禁/驳回 |
| ⭐ 精选展示 | 拖拽排序 |
| 📋 生图记录 | 全部输出图分页浏览，每张图可：封禁 IP、加/移精选、删图 |

## 目录结构

```
web/
├── app.py                  FastAPI 后端（单文件）
├── requirements.txt        Python 依赖
├── workflow_meta.json      工作流元数据（缩略图 + Lora 链接映射）
├── static/
│   ├── index.html          用户前端
│   ├── admin.html          管理控制台
│   └── favicon.avif
├── thumbnails/             工作流缩略图
├── style_thumbnails/       画风缩略图
├── lora_links/             Lora 链接（旧方式，已被 workflow_meta.json 取代）
├── creator_ips.txt         生图者 IP 映射（gitignored）
├── banned_ips.txt          封禁 IP 列表（gitignored）
├── featured.txt            精选图片路径（gitignored）
├── limits.json             限流 + 精选提示语配置（gitignored）
├── styles.json             画风配置（gitignored）
├── resolutions.json        分辨率预设（gitignored）
├── llm_config.json         LLM 服务商配置（gitignored）
├── announcement.json       公告配置（gitignored）
└── reports.json            举报记录（gitignored）
```

## API

### 公共

| 路径 | 说明 |
|---|---|
| `GET  /api/workflows` | 列出所有工作流 |
| `GET  /api/workflows/current?path=` | 工作流摘要 + 默认分辨率 + 内置 prompt |
| `GET  /api/thumbnail?path=` | 工作流缩略图 |
| `GET  /api/styles` | 画风列表 |
| `GET  /api/resolutions` | 分辨率预设列表 |
| `GET  /api/style_thumbnail?name=` | 画风缩略图 |
| `GET  /api/output/list?limit=&offset=` | 输出目录分页（mtime 倒序） |
| `GET  /api/output/file?path=` | 取输出图（自动 WebP 转码，`?full=1` 取原图） |
| `GET  /api/output/meta?path=` | 读 PNG 元数据，提取正向 prompt |
| `GET  /api/output/featured` | 精选列表 + 提示语 |
| `GET  /api/output/creator?path=` | 该图的生图者 IP |
| `POST /api/output/fork` | 抽出 PNG 内的 workflow |
| `GET  /api/image?...` | 代理 ComfyUI 实时输出图 |
| `GET  /api/gpu` | nvidia-smi 状态 |
| `GET  /api/announcement` | 当前公告 |
| `POST /api/translate` | LLM 翻译 |
| `POST /api/interrupt` | 中断当前任务 |
| `POST /api/report` | 举报图片 |
| `WS   /ws/run` | 提交生图 + 接收进度 |
| `WS   /ws/status` | 订阅全局任务状态 |

### 管理（**必须由反向代理保护**）

| 路径 | 说明 |
|---|---|
| `GET  /admin` | 管理页 |
| `GET  /api/admin/limits` / `POST` | 限流配置 |
| `GET  /api/admin/styles` / `POST` | 画风管理 |
| `GET  /api/admin/resolutions` / `POST` | 分辨率预设 |
| `GET  /api/admin/workflow_meta` / `POST` | 工作流缩略图 & Lora 链接 |
| `GET  /api/admin/workflow_files` | 扫描 ComfyUI 工作流目录 |
| `POST /api/admin/workflow_rename` | 重命名工作流（通过 ComfyUI API） |
| `POST /api/admin/wf_thumbnail` | 上传工作流缩略图 |
| `POST /api/admin/style_thumbnail` | 上传画风缩略图 |
| `GET  /api/admin/llm` / `POST` | LLM 配置 |
| `POST /api/admin/llm/test` | 测试 LLM 连接 |
| `POST /api/admin/llm/models` | 获取可用模型列表 |
| `GET  /api/admin/announcement` / `POST` | 公告管理 |
| `GET  /api/admin/bans` | 封禁 IP 列表 |
| `POST /api/admin/ban` / `unban` | 加/解封 IP |
| `GET  /api/admin/images_by_ip?ip=` | 查看某 IP 的生图记录 |
| `GET  /api/admin/recent?limit=&offset=` | 全输出图分页（管理用） |
| `POST /api/admin/delete` | 删图 |
| `POST /api/admin/delete_batch` | 批量删图 |
| `GET  /api/admin/featured` | 精选列表 |
| `POST /api/admin/featured/{add,remove,reorder}` | 精选维护 |
| `GET  /api/admin/reports` | 待处理举报 |
| `POST /api/admin/report/resolve` | 处理举报 |
| `POST /api/admin/gc` | 手动触发垃圾回收 |
| `POST /api/admin/force-restart` | 强制重启后端 |

### `/ws/run` 协议

客户端首包：

```jsonc
{
  "workflow_path": "WAI - 莫宁.json",
  "inline_workflow": null,
  "direct_prompt": "1girl, ...",
  "nl_prompt": "",
  "rewrite": true,
  "width": null,
  "height": null,
  "style_tags": ""
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

## 限流与封禁

- **生图冷却**：单 IP 两次提交 `/ws/run` 间隔不少于 `gen_cooldown_sec`（默认 30s）
- **图片限流**：`/api/output/file`、`/api/image`、`/api/thumbnail` 三端点合并按 IP 滑动窗口限流（默认 60s 内 120 次），超限返回 429
- **IP 封禁**：被封 IP 提交 `/ws/run` 立即收到错误并断开。仅看图不影响
- **真实 IP 解析**：依次取 `cf-connecting-ip` → `x-forwarded-for[0]` → socket。挂在反代后请确保转发 `X-Forwarded-For`

## 安全

- 输出目录浏览只读，路径校验：拒绝绝对路径、拒绝 `..` 段、`Path.is_relative_to()` 校验
- 上传文件流式写入，256KB 分块边写边校验大小（上限 5MB）
- `lora_link` 强制 `http://` 或 `https://` 协议
- 所有用户输入 HTML 转义后再渲染
- 18+ 弹窗 + 全屏遮罩盖住所有图直到确认
- 全局禁止搜索引擎索引（`X-Robots-Tag`、`<meta robots>`、`/robots.txt`）

## 常用资源

- [danbooru-artist 画师库](https://www.downloadmost.com/NoobAI-XL/danbooru-artist/)：换画风，格式 `by xxx` 或 `(by xxx:1.2)`
- [danbooru-character 角色库](https://www.downloadmost.com/NoobAI-XL/danbooru-character/)：换角色，建议配合无 Lora 工作流
- [新手教程 · 从零开始造老婆](https://2x.nz/posts/ai-wife/)

## 来源

后端核心（`workflow_to_prompt_api` 等）移植自 `dev/comfyui.py`，一个 NoneBot Telegram 插件。这个项目把它扒出来，套上一层 web 控制台，让本机/局域网/反代后更多人能用。

## License

[LICENSE](./LICENSE)
