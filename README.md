# local-draw — 本地自然语言生图全栈项目

> 🎨 一句中文，出一张图。2x.nz/draw 的本地完整复刻，单仓库全栈。

基于 [afoim/natureDrawImage](https://github.com/afoim/natureDrawImage)（后端）+ [afoim/svaf](https://github.com/afoim/svaf)（前端 /draw 部分），适配本地绘世启动器 ComfyUI。

## 架构

```
用户: "我想画一个原神的胡桃，赛博朋克风格，横屏尺寸"
  │
  ▼  frontend/  (SvelteKit :5173)
  │   AI 绘图助手聊天 · 画廊 · 工作流/角色/画风选择 · img2img
  ▼  node-server/  (Express + TS :8080)
  │   /api/assistant/chat → LLM 解析 → 生图卡片
  │   /api/draw/queue → 队列 → runner.ts 工作流注入
  ▼  ComfyUI  (绘世启动器 :8186, RTX 5090)
      Flux Kontext · SDXL/Pony · LoRA
```

## 目录结构

```
├── node-server/        # Express + TypeScript 后端（队列/画廊/工作流/助手）
├── frontend/           # SvelteKit 主前端（源自 svaf /draw，完整功能）
├── web/                # 轻量助手 demo 前端（Svelte 5 + Vite，可独立跑）
├── tools/
│   └── civitai_scraper/  # CivitAI 提示词爬虫（角色库建设）
├── workflow_staging/   # 工作流暂存区（civitai 下载 + 兼容性报告）
├── reverse_2x_draw/    # 2x.nz/draw 线上版逆向分析材料
├── start_all_local.bat # 一键启动
└── LOCAL_DEPLOYMENT.md # 本地部署笔记
```

## 快速开始

```bat
:: 1. 绘世启动器启动 ComfyUI（端口 8186）
:: 2. 后端
start_naturedraw_server.bat        :: :8080
:: 3. 前端
cd frontend && pnpm install && pnpm dev   :: :5173
```

健康检查：`:8080/health` · `:8186/system_stats`

本地 JWT：`cd node-server && node scripts/generate_local_token.cjs`

## 本地化改动（相对 afoim 原版）

- ComfyUI 端口 8186（绘世启动器），config.ts 自动从父目录加载 .env
- 新增 `/api/assistant/chat` 绘图助手路由（模板 prompt 工程，可升级 LLM）
- 前后端合并进单仓库（原 svaf 为独立仓库）
- 工作流暂存区 + 兼容性扫描报告
- 2x.nz 线上版逆向材料（API 清单 / 助手交互规格）

## Related

- [comfy-ui-agent](https://github.com/entaiaki/comfy-ui-agent) — ComfyUI 工作流智能编排框架（独立工具库）
- [ai-image-platform](https://github.com/entaiaki/ai-image-platform) — Spring Boot 企业级生图平台（独立项目）
