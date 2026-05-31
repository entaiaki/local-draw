# natureDrawImage（single 分支）

> 单体 Node.js/Express 后端，支持多人共用显卡，集成 LLM 聊天、钱包、队列、管理员面板。

本分支将原 FastAPI 单文件后端的核心逻辑迁移至 Express + TypeScript，并新增角色扮演聊天、WebSocket 队列、钱包积分、授权管理等企业级特性。

与 `main` 分支差异：

| | `main`（FastAPI 单体） | `backend`（Express） |
|---|---|---|
| 后端框架 | FastAPI + Python | Express + TypeScript + tsx |
| 前端 | Tailwind CDN 单页 HTML | SvelteKit 独立前端仓库 |
| 鉴权 | 仅反代层 | JWT + 角色（user/admin） |
| 生图模型 | WAI 工作流 | WAI + Anima 双模式 |
| LLM 功能 | prompt 翻译 | 翻译 + 角色扮演聊天 |
| 通知 | 无 | QQ 群 Bot 通知 |
| 队列 | WebSocket 直通 | 持久化队列 + 轮询 |
| 钱包 | 无 | 积分充值 + 扣费 |
| 管理员 | 单页管理面板 | 独立管理路由 + 协作者 |
| 软删除 | 无 | 图片列表支持 deleted 标记 |

无须运行 ComfyUI 即可启动开发。

```bash
cd node-server
npm install
npm run dev
```

详见 `node-server/src/`。
