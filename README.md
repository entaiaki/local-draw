# natureDrawImage

> 给老婆套个壳，让她在浏览器里跑。

一个塞进 ComfyUI 前面的轻量级网页控制台，主打**多人共用一台显卡**的场景：每个浏览器各选各的工作流、各写各的 prompt，但同一时刻只有一个人在用 GPU，其它人能实时看到当前任务进度。

仓库：<https://github.com/afoim/natureDrawImage>

—— 单文件 FastAPI 后端 + Tailwind CDN 前端，无构建步骤，`uv run` 起飞。

## 它能做什么

- **工作流管理**：列出 / 搜索 ComfyUI 已保存的工作流，每个工作流可配同名缩略图。「无 Lora」字样的工作流自动置顶
- **三种 prompt 写法**：
  - 直接 Tag：自己写 / 复制工作流内置 prompt
  - 自然语言翻译：LM Studio 把中/英文描述翻译成 SD/Pony/Illustrious tag
  - 改写模式：让 LLM 基于现有 prompt 整体重写（智能增删）
  - 覆写模式：忽略工作流内置 prompt，只用你写的
- **本地词典注入**：启动时一次性把 `dev/zh_CN.json`（约 4000 条 zh→en）加到 LLM system prompt
- **LM Studio 流式输出**直接显示在页面上
- **自定义分辨率**：覆盖工作流里所有 `width/height` 节点；提供 `1024×1344 / 832×1216 / 1024×1024 / 512×512` 一键预设；最大 1344
- **WebSocket 实时进度**：节点名 + 步进进度条 + 取消按钮
- **GPU 状态条**（顶栏）：每 2s 调一次 `nvidia-smi`，显示 GPU/VRAM 占用、温度、功耗、风扇、频率
- **全局并发锁 + 旁观模式**：同一时刻只允许一个生图任务，其它页面在状态横幅里实时看到当前任务进度
- **ComfyUI 输出目录浏览**：分页加载，配自建灯箱，左右键翻图，**异步注入该图的正向 prompt**，可一键 Fork 工作流二改
- **Fork 工作流（临时还原）**：从输出 PNG 抽出 workflow，临时存在浏览器内存里，下一次提交直接走这份 `inline_workflow`，不写盘
- **精选展示**：站长在 `/admin` 手动维护一组「优秀作品」，可拖拽排序，游客首页置顶展示
- **18+ 年龄确认弹窗** + 全屏遮罩，年龄确认前看不到任何已生成图
- **每次生图前强制公告 + 显示图片公告**：法律/平台风险声明
- **管理控制台 `/admin`**：见下文
- **维护模式**：一键关站，所有 GET 请求统一返回 503 + 自定义维护页 HTML
- **限流配置**：单 IP 生图冷却 + 出图端点滑动窗口限流，全部在管理面板实时改
- **生图者 IP 溯源**：每张输出图的 IP 记录在 `web/creator_ips.txt`，灯箱里显示「生图者: x.x.x.x」
- **IP 封禁 / 删图**：管理面板手动维护，被封 IP WS 提交直接拒绝
- **giscus 评论区**

## 速览

```
┌─ GPU 状态条（nvidia-smi）
├─ 全局任务进度（其它人正在跑 → 此处可见）
├─ 当前工作流 [缩略图] [节点/连线统计]
├─ 工作流卡片网格
├─ 生图表单
│  ├─ 直接 Tag / 自然语言描述
│  ├─ ☑ 改写模式  ☐ 覆写模式
│  ├─ 内置 prompt 预览
│  ├─ 宽×高 + 预设按钮
│  └─ ▶ 开始生成 / ✕ 取消
├─ 进度区（日志 + LLM 流式 + 进度条）
├─ 结果区（本次生成的图）
├─ 精选展示（站长维护）
├─ 输出目录画廊（懒加载 + 自建灯箱 + Fork）
└─ 评论区
```

## 安装与启动

需要 Python 3.10+。推荐 [uv](https://github.com/astral-sh/uv)。

```bash
uv pip install -r web/requirements.txt
# 或 pip install -r web/requirements.txt
```

```bash
# 默认 127.0.0.1:8080
uv run web/app.py

# 监听所有地址（局域网 / 反向代理后端）
uv run web/app.py --host 0.0.0.0

# 已在反向代理上配置好访问控制，跳过启动确认
uv run web/app.py --host 0.0.0.0 --i-have-configured-auth

# 开发：保存 .py 自动重启
uv run web/app.py --host 0.0.0.0 --reload
```

打开 <http://127.0.0.1:8080>，第一次会弹 18+ 确认 + 公告。

> 只监听 `127.0.0.1` 时不会弹启动确认；监听非回环地址且未带 `--i-have-configured-auth` 时，会要求你在终端输入 `yes` 确认已经配好访问控制再继续启动。

## 配置

打开 `web/app.py`，顶部就是全部配置：

```python
COMFYUI_HOST = "127.0.0.1"
COMFYUI_PORT = 8000

LMS_HOST = "127.0.0.1"     # LM Studio
LMS_PORT = 1234

WEB_HOST = "127.0.0.1"
WEB_PORT = 8080

OUTPUT_DIR_STR = r"C:\Users\acofo\Documents\ComfyUI\output"
```

LM Studio 需开启 OpenAI 兼容服务（默认 `http://127.0.0.1:1234/v1`）并加载任意聊天模型。纯 Tag 模式不会触发 LLM。

`dev/zh_CN.json` 是可选的 LLM 词典，存在则注入；不存在功能不受影响。

## 部署与鉴权（重要）

**本服务自身不做任何鉴权。** `/admin` 与 `/api/admin/*` 公开可达——任何人能访问端口就能调用：封禁 IP、删图、改限流、开关维护、精选管理。

不要直接把 `--host 0.0.0.0` 暴露到公网。生产部署**必须**在反向代理上做访问控制，至少满足其一：

- **Cloudflare Access / Zero Trust**（推荐，本仓库实际部署用的就是这个）：在 Cloudflare 后台对 `/admin` 与 `/api/admin/*` 路径加身份策略
- **nginx auth_basic / auth_request**
- **IP 白名单**：防火墙 / nginx `allow/deny`
- **私有网络**：Tailscale / WireGuard

一种简单粗暴但够用的 nginx 片段：

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

启动器在监听非回环地址时会提示你确认已经配好这一步。

## 管理控制台 `/admin`

| 区块 | 功能 |
|---|---|
| 🛠️ 维护模式 | 启用开关 + 维护页文字。开启后所有 GET 走维护页，其它方法返回 503 |
| ⚙️ 限流配置 | `gen_cooldown_sec`、`image_rate_window_sec`、`image_rate_max` |
| 🚫 封禁 IP | chip 列表 + 手动添加 |
| ⭐ 精选展示 | 拖拽排序，对游客首页可见 |
| 📋 生图记录 | 全 OUTPUT_DIR 按 mtime 倒序分页；每张图卡片可：禁此 IP、加/移精选、删图 |

精选与生图记录两个区块支持折叠。删图原地移除卡片，不会跳回顶部。

## 工作流缩略图

把图片放到 `web/thumbnails/`，文件名与工作流匹配（去掉 `.json`）：

- `flux/portrait.json` → `web/thumbnails/flux/portrait.png`
- 或 `web/thumbnails/portrait.png`

支持 `.png .jpg .jpeg .webp .gif`。

约定：工作流命名建议 `[模型] - [自定义文本].json`，如 `WAI - 莫宁.json`，前端会自动拆分两行。

## 目录结构

```
web/
├── app.py                  FastAPI 后端（单文件）
├── requirements.txt
├── static/
│   ├── index.html          游客前端
│   ├── admin.html          管理控制台
│   └── favicon.avif
├── thumbnails/             工作流缩略图
├── lora_links/             Lora 链接（每个工作流可配同名 .txt）
├── creator_ips.txt         生图者 IP 映射（gitignored）
├── banned_ips.txt          封禁 IP 列表（gitignored）
├── featured.txt            精选图片相对路径（gitignored）
├── limits.json             限流配置（gitignored）
└── maintenance.json        维护模式状态（gitignored）
```

工作流选择是**纯前端**的，存在浏览器 `localStorage` 里——多人共用同一后端不会互相覆盖。

## API

### 公共

| 路径 | 说明 |
|---|---|
| `GET  /api/workflows` | 列出所有工作流 |
| `GET  /api/workflows/current?path=` | 工作流摘要 + 默认分辨率 + 内置 prompt |
| `GET  /api/thumbnail?path=` | 工作流缩略图 |
| `GET  /api/output/list?limit=&offset=` | 输出目录分页（mtime 倒序） |
| `GET  /api/output/file?path=` | 取输出图（路径穿越防护） |
| `GET  /api/output/meta?path=` | 读 PNG 元数据，提取正向 prompt |
| `GET  /api/output/featured` | 公开的精选列表 |
| `GET  /api/output/creator?path=` | 该图的生图者 IP |
| `POST /api/output/fork` | 抽出 PNG 内的 workflow |
| `GET  /api/image?...` | 代理 ComfyUI 实时输出图 |
| `GET  /api/gpu` | nvidia-smi 状态 |
| `POST /api/translate` | 一次性 LLM 翻译 |
| `POST /api/interrupt` | 中断当前任务 |
| `WS   /ws/run` | 提交生图 + 接收进度 |
| `WS   /ws/status` | 订阅全局任务状态 |

### 管理（**必须由反向代理保护**）

| 路径 | 说明 |
|---|---|
| `GET  /admin` | 管理页 |
| `GET  /api/admin/whoami` | 占位 |
| `GET  /api/admin/maintenance` / `POST` | 维护模式 |
| `GET  /api/admin/limits` / `POST` | 限流配置 |
| `GET  /api/admin/bans` | 封禁 IP 列表 |
| `POST /api/admin/ban` / `unban` | 加/解封 IP |
| `GET  /api/admin/recent?limit=&offset=` | 全输出图分页（管理用） |
| `POST /api/admin/delete` | 删图 |
| `GET  /api/admin/featured` | 精选列表 |
| `POST /api/admin/featured/{add,remove,reorder}` | 精选维护 |

`/ws/run` 客户端首包：

```jsonc
{
  "workflow_path": "flux/portrait.json",
  "inline_workflow": null,
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

## 限流与封禁

- **生图冷却**：单 IP 两次提交 `/ws/run` 间隔不少于 `gen_cooldown_sec`（默认 30s）
- **图片限流**：`/api/output/file`、`/api/image`、`/api/thumbnail` 三端点合并按 IP 滑动窗口限流（默认 60s 内 120 次），超限返回 429
- **IP 封禁**：被封 IP 提交 `/ws/run` 立即收到错误并断开。仅看图不影响
- **真实 IP 解析**：依次取 `cf-connecting-ip` → `x-forwarded-for[0]` → socket。挂在反代后请确保转发 `X-Forwarded-For`

## 安全

- 输出目录浏览只读，路径校验三重：拒绝绝对路径、拒绝 `..` 段、`Path.resolve().relative_to(OUTPUT_DIR.resolve())` 必须通过
- 缩略图同样走防穿越校验
- 18+ 弹窗 + 全屏遮罩盖住所有图直到确认
- 每次生图前公告 + 首次显示图片公告
- 全局禁止搜索引擎索引（`X-Robots-Tag`、`<meta robots>`、`/robots.txt`）

## 常用资源

- [danbooru-artist 画师库](https://www.downloadmost.com/NoobAI-XL/danbooru-artist/)：换画风，格式 `by xxx` 或 `(by xxx:1.2)`
- [danbooru-character 角色库](https://www.downloadmost.com/NoobAI-XL/danbooru-character/)：换角色，建议配合无 Lora 工作流
- [新手教程 · 从零开始造老婆](https://2x.nz/posts/ai-wife/)

## 来源

后端核心（`workflow_to_prompt_api` 等）移植自 `dev/comfyui.py`，一个 NoneBot Telegram 插件，原本只服务于一个聊天里的特定 chat。这个项目把它扒出来，套上一层 web 控制台，让本机/局域网/反代后更多人能用。

## License

[LICENSE](./LICENSE)
