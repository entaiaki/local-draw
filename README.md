# natureDrawImage Local (entaiaki/local-draw)

> 🎨 本地自然语言生图全栈 — 2x.nz/draw 本地版

基于 [afoim/natureDrawImage](https://github.com/afoim/natureDrawImage) 的 **backend 分支**，适配本地 ComfyUI（绘世启动器）部署。

## 架构

```
┌─────────────────┐     ┌──────────────────────┐     ┌────────────────┐
│  svaf-draw      │────▶│  local-draw           │────▶│  ComfyUI       │
│  SvelteKit 前端  │◀───│  Express + TS 后端    │◀───│  (绘世启动器)    │
│  (/draw 聊天界面) │     │  :8080                │     │  :8186          │
└─────────────────┘     │  + AI 绘图助手路由     │     └────────────────┘
                        │  + 队列/画廊/工作流管理 │     NVIDIA RTX 5090
                        └──────────────────────┘
```

| 组件 | 仓库 | 本地路径 |
|------|------|----------|
| 后端 | [entaiaki/local-draw](https://github.com/entaiaki/local-draw) | `E:\AI\natureDrawImage` |
| 前端 | [entaiaki/svaf-draw](https://github.com/entaiaki/svaf-draw) | `E:\AI\svaf` (sparse) |
| ComfyUI | 绘世启动器 | `E:\AI\ComfyUI-aki-v1.4` |
| 智能体框架 | [entaiaki/comfy-ui-agent](https://github.com/entaiaki/comfy-ui-agent) | 工具库，与主项目解耦 |

## 本地开发

### 前提
- ComfyUI 绘世启动器，端口 8186，cpu_vae
- Node.js 24+
- .env 在项目根目录（自动从父目录加载）

### 启动

```bat
start_all_local.bat
```
或分步：
```bat
start_comfyui_local.bat      ← 如果绘世未运行
start_naturedraw_server.bat   ← 启动后端 :8080
```

前端单独启动：
```bash
cd web && npm run dev          ← :5173，自动代理到 :8080
```

### 健康检查
```
后端:  http://127.0.0.1:8080/health  → 200
ComfyUI: http://127.0.0.1:8186/system_stats  → 200
```

### 本地鉴权
生产环境需要 JWT，开发时用本地 token：
```bat
cd node-server && node scripts/generate_local_token.cjs
```

## 相比原版的本地化改动
- ComfyUI 端口改为 8186（与绘世启动器一致）
- config.ts 自动从父目录加载 .env，避免污染 node-server
- 新增 `/api/assistant/chat` AI 绘图助手路由（无 LLM 依赖，模板 prompt 工程）
- 新增本地启动脚本 + 逆向分析材料
- 工作流暂存区（civitai 工作流 > workflow_staging/）

## Related

- [svaf-draw](https://github.com/entaiaki/svaf-draw) — 前端仓库
- [comfy-ui-agent](https://github.com/entaiaki/comfy-ui-agent) — ComfyUI 工作流智能编排框架
- [ai-image-platform](https://github.com/entaiaki/ai-image-platform) — Spring Boot 企业级生图平台（独立项目）
