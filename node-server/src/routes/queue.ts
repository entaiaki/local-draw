import express, { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { verifyToken } from '../middleware/auth.js';
import { QueueItem, RunRequest } from '../types/index.js';
import { loadLimits, loadConfig, saveJson, loadJson } from '../services/config.js';
import { resetRunner } from '../services/runner.js';

const router = Router();
router.use(express.json({ limit: "50mb" }));
const config = loadConfig();

// Queue persistence
const QUEUE_STATE_FILE = config.state_file.replace('state.json', 'queue_state.json');

function saveQueueState(): void {
  try { fs.writeFileSync(QUEUE_STATE_FILE, JSON.stringify({ idCounter: queueIdCounter, userIds: queuedUserIds, items: queueItems }, null, 2), 'utf-8'); } catch {}
}
function loadQueueState(): void {
  try {
    if (fs.existsSync(QUEUE_STATE_FILE)) {
      const d = JSON.parse(fs.readFileSync(QUEUE_STATE_FILE, 'utf-8'));
      queueIdCounter = d.idCounter || 0;
      queuedUserIds = d.userIds || {};
      queueItems.length = 0;
      for (const i of d.items || []) queueItems.push(i);
    }
  } catch {}
}

// In-memory queue state
let queueIdCounter = 0;
let queuedUserIds: Record<number, number> = {};  // user_id -> count
const queueItems: QueueItem[] = [];
loadQueueState();
// 启动时：恢复可能已完成的 running 任务，清理卡死的，重启 pending
(async () => {
  const comfyApi = axios.create({ baseURL: config.comfyui_api, timeout: 10000 });
  for (const qi of queueItems) {
    if ((qi.status === 'running' || qi.status === 'waiting') && (qi.params as any)?._prompt_id) {
      const pid = (qi.params as any)._prompt_id;
      try {
        const r = await comfyApi.get(`/api/history/${pid}`);
        if (r.data?.[pid]) {
          qi.status = 'done';
          qi.finished_at = Date.now() / 1000;
          const outputs = r.data[pid].outputs || {};
          for (const [, out] of Object.entries(outputs)) {
            const o = out as any;
            if (o?.images) {
              for (const img of o.images) {
                const relPath = img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename;
                try { const { setCreatorMap } = await import('../services/runner.js'); setCreatorMap(relPath, qi.user_id); } catch {}
              }
            }
          }
          continue;
        }
      } catch {}
    }
    if (qi.status === 'running') {
      qi.status = 'failed';
      qi.error = '服务重启，任务终止';
      qi.finished_at = Date.now() / 1000;
      const cur = queuedUserIds[qi.user_id] || 0;
      if (cur > 1) queuedUserIds[qi.user_id] = cur - 1;
      else delete queuedUserIds[qi.user_id];
    }
  }
  saveQueueState();
  // 重新启动所有 pending + waiting + failed 任务
  for (const qi of queueItems) {
    if (qi.status === 'pending' || qi.status === 'waiting' || qi.status === 'failed') {
      qi.status = 'pending';
      qi.started_at = null;
      qi.finished_at = null;
      qi.error = null;
      (async () => {
        try { const { runQueueTask } = await import('../services/runner.js'); await runQueueTask(qi); } catch {}
      })();
    }
  }
})();

// Queue semaphore (simple lock)
let semLocked = false;
let semQueue: (() => void)[] = [];

async function acquireSem(): Promise<void> {
  if (!semLocked) {
    semLocked = true;
    return;
  }
  return new Promise(resolve => {
    semQueue.push(resolve);
  });
}

function releaseSem(): void {
  if (semQueue.length > 0) {
    const next = semQueue.shift()!;
    next();
  } else {
    semLocked = false;
  }
}

function queuePosition(itemId: number): number {
  let pos = 1;
  for (const qi of queueItems) {
    if (qi.status !== 'pending' && qi.status !== 'waiting' && qi.status !== 'running') continue;
    if (qi.id === itemId) return pos;
    pos++;
  }
  return 0;
}

// POST /api/draw/queue
router.post('/queue', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: 'token 无效或已过期' });
  if (user.role !== 'admin' && user.role !== 'user') return res.status(403).json({ detail: '已禁止生图' });

  // Cooldown check (simplified)
  const limits = loadLimits(config.limits_file);
  const maxQ = limits.max_queue_per_user || 1;
  const currentQ = queuedUserIds[user.id] || 0;
  if (currentQ >= maxQ) {
    return res.status(429).json({ detail: `你的队列已满（最多 ${maxQ} 个），请等待后再试` });
  }

  const body = req.body as Record<string, unknown>;
  queueIdCounter++;
  const itemId = queueIdCounter;

  // Validate workflow
  if (!body.direct_prompt && !body.workflow_path && !body.inline_workflow && !body.image1_name) {
    return res.status(400).json({ detail: '未指定工作流' });
  }

  const item: QueueItem = {
    id: itemId,
    user_id: user.id,
    params: body,
    status: 'pending',
    created_at: Date.now() / 1000,
    started_at: null,
    finished_at: null,
    error: null,
  };
  queueItems.push(item);
  queuedUserIds[user.id] = currentQ + 1;
  saveQueueState();
  try { import('../services/runner.js').then(() => { try { import('../routes/status.js').then(m => m.broadcast({ type: 'queue_update', ts: Date.now() })); } catch {} }); } catch {}

  const position = queueItems.filter(qi => qi.status === 'pending' || qi.status === 'waiting' || qi.status === 'running').length;

  // Start background runner
  (async () => {
    try {
      const { runQueueTask } = await import('../services/runner.js');
      await runQueueTask(item);
    } catch {}
  })();

  res.json({ queued: true, position, item_id: itemId });
});

// GET /api/draw/my-queue
router.get('/my-queue', (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: 'token 无效或已过期' });

  const now = Date.now() / 1000;
  const items = queueItems
    .filter(qi => qi.user_id === user.id && (now - qi.created_at) < 7200)
    .map(qi => ({
      id: qi.id,
      status: qi.status,
      created_at: qi.created_at,
      started_at: qi.started_at,
      finished_at: qi.finished_at,
      error: qi.error,
      position: qi.status === 'pending' || qi.status === 'waiting' ? queuePosition(qi.id) : null,
    }));

  res.json({ items, total: items.length });
});

// DELETE /api/draw/queue (admin)
router.delete('/queue', (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user || user.role !== 'admin') return res.status(403).json({ detail: '需要管理员权限' });

  // 直接删除队列文件，重置内存状态
  queueItems.length = 0;
  queuedUserIds = {};
  queueIdCounter = 0;
  resetRunner();
  try { if (fs.existsSync(QUEUE_STATE_FILE)) fs.unlinkSync(QUEUE_STATE_FILE); } catch {}
  res.json({ ok: true, cleared: 0 });
});

export { router as queueRouter, queueItems, queuedUserIds, saveQueueState };
