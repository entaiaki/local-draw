# natureDrawImage（backend 分支）

> 给老婆套个壳，让她在浏览器里跑。

Node.js/Express 后端，ComfyUI 控制台。与原 `main` 分支的区别：

- 后端框架从 Python 换为 Express + TypeScript
- 前端拆分为独立 SvelteKit 仓库
- 新增 JWT 鉴权、角色扮演聊天、钱包积分、持久化队列