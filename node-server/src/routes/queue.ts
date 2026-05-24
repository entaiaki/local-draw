import express, { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { verifyToken } from '../middleware/auth.js';
import { QueueItem, RunRequest } from '../types/index.js';
import { loadLimits, loadConfig, saveJson, loadJson } from '../services/config.js';
import { resetRunner } from '../services/runner.js';
import { deductPoints, refundPoints, loadPointsCfg } from './wallet.js';

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
// 启动时：恢复可能已完成的 running 任务，清理卡死的，重启 pending，恢复 _pending_ 元数据
(async () => {
  // 恢复 prompt_meta.json 中的 _pending_ 记录（提交了但没来得及取结果的）
  const pmFile = path.join(path.dirname(config.creator_map_file), 'prompt_meta.json');
  try {
    const pm = JSON.parse(fs.readFileSync(pmFile, 'utf-8'));
    const comfyApi2 = axios.create({ baseURL: config.comfyui_api, timeout: 10000 });
    const now = Date.now() / 1000;
    for (const [k, v] of Object.entries(pm)) {
      if (!k.startsWith('_pending_')) continue;
      const pid = k.slice(9);
      let recovered = false;
      // 1) 先查 history 看是否已完成
      try {
        const r = await comfyApi2.get(`/api/history/${pid}`);
        if (r.data?.[pid]) {
          const outputs = r.data[pid].outputs || {};
          for (const [, out] of Object.entries(outputs)) {
            const o = out as any;
            if (o?.images) {
              for (const img of o.images) {
                const relPath = img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename;
                try { const { setCreatorMap } = await import('../services/runner.js'); setCreatorMap(relPath, (v as any).user_id); } catch {}
                pm[relPath] = { prompt: (v as any).prompt, image1: (v as any).image1 || "", image2: (v as any).image2 || "" };
              }
            }
          }
          delete pm[k];
          recovered = true;
        }
      } catch {}
      // 2) 查 ComfyUI 队列，如果还在跑则不等
      if (!recovered) {
        try {
          const q = await comfyApi2.get('/api/queue');
          const all = [...(q.data?.queue_running || []), ...(q.data?.queue_pending || [])];
          const stillAlive = all.some((item: any) => Array.isArray(item) && item[1] === pid);
          if (!stillAlive) {
            // 既不在 history 也不在队列 → 丢失，保留 _pending_ 但不报错
            delete pm[k];
          }
          // 还在队列中 → 保留 _pending_，后台轮询等它完成
        } catch {}
      }
    }
    fs.writeFileSync(pmFile, JSON.stringify(pm, null, 2), 'utf-8');
    // 后台轮询剩余的 _pending_（ComfyUI 还在跑的）
    (async function pollPending() {
      const pm2 = JSON.parse(fs.readFileSync(pmFile, 'utf-8'));
      const pending = Object.entries(pm2).filter(([k]) => k.startsWith('_pending_'));
      if (pending.length === 0) return;
      for (const [k, v] of pending) {
        const pid = k.slice(9);
        try {
          const r = await comfyApi2.get(`/api/history/${pid}`);
          if (r.data?.[pid]) {
            const outputs = r.data[pid].outputs || {};
            for (const [, out] of Object.entries(outputs)) {
              const o = out as any;
              if (o?.images) {
                for (const img of o.images) {
                  const relPath = img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename;
                  try { const { setCreatorMap } = await import('../services/runner.js'); setCreatorMap(relPath, (v as any).user_id); } catch {}
                  pm2[relPath] = { prompt: (v as any).prompt, image1: (v as any).image1 || "", image2: (v as any).image2 || "" };
                }
              }
            }
            delete pm2[k];
          }
        } catch {}
      }
      fs.writeFileSync(pmFile, JSON.stringify(pm2, null, 2), 'utf-8');
      if (Object.keys(pm2).some(k => k.startsWith('_pending_'))) {
        setTimeout(pollPending, 5000);  // 5 秒后重试
      }
    })();
  } catch {}

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
      // Refund points for jobs that were running when server died
      const { refundPoints, loadPointsCfg } = await import('./wallet.js');
      const cfg = loadPointsCfg();
      const isImg2img = !!((qi.params as any)?.image1_name);
      await refundPoints(qi.user_id, isImg2img ? cfg.image_to_image : cfg.text_to_image);
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
  if (!user) return res.status(401).json({ detail: '论坛登录凭证已过期，请刷新页面或重新登录' });
  if (user.role !== 'admin' && user.role !== 'user') return res.status(403).json({ detail: '已禁止生图' });

  // Cooldown check (simplified)
  const limits = loadLimits(config.limits_file);
  const maxQ = limits.max_queue_per_user || 1;
  const currentQ = queuedUserIds[user.id] || 0;
  if (currentQ >= maxQ) {
    return res.status(429).json({ detail: `你的队列已满（最多 ${maxQ} 个），请等待后再试` });
  }

  // Points check
  let deductedCost = 0;
  const pointsCfg = loadPointsCfg();
  const isImg2img = !!(req.body as any)?.image1_name;
  const wfPath = (req.body as any)?.workflow_path as string || '';
  const isAnima = wfPath.startsWith('ANIMA/');
  deductedCost = isImg2img ? pointsCfg.image_to_image : (isAnima ? pointsCfg.text_to_image_anima : pointsCfg.text_to_image);
  if (deductedCost > 0) {
    const ptResult = await deductPoints(user.id, deductedCost);
    if (!ptResult.ok) {
      return res.status(402).json({ error: '点数不足', need: deductedCost, balance: ptResult.balance || 0 });
    }
  }

  async function refundOnFail() {
    if (deductedCost > 0) await refundPoints(user.id, deductedCost);
  }

  // Turnstile verification
  if (limits.turnstile_enabled !== false) {
    const turnstileToken = req.body?.turnstile_token as string;
    if (!turnstileToken) { await refundOnFail(); return res.status(403).json({ detail: '请完成人机验证' }); }
    try {
      const tsResp = await axios.post('https://challenges.cloudflare.com/turnstile/v0/siteverify',
        new URLSearchParams({ secret: config.turnstile_secret_key, response: turnstileToken }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!tsResp.data?.success) { await refundOnFail(); return res.status(403).json({ detail: '人机验证失败，请刷新后重试' }); }
    } catch { await refundOnFail(); return res.status(503).json({ detail: '人机验证服务不可用' }); }
  }

  const body = req.body as Record<string, unknown>;
  queueIdCounter++;
  const itemId = queueIdCounter;

  // Validate workflow
  if (!body.direct_prompt && !body.workflow_path && !body.image1_name) {
    await refundOnFail();
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
  if (!user) return res.status(401).json({ detail: '论坛登录凭证已过期，请刷新页面或重新登录' });

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
