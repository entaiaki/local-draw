import { Router, Request, Response } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { QueueItem, RunRequest } from '../types/index.js';
import { loadLimits, loadConfig, saveJson, loadJson } from '../services/config.js';

const router = Router();
const config = loadConfig();

// In-memory queue state
let queueIdCounter = 0;
let queuedUserIds: Record<number, number> = {};  // user_id -> count
const queueItems: QueueItem[] = [];

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
  if (!body.direct_prompt && !body.workflow_path && !body.inline_workflow) {
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

  let cleared = 0;
  for (const qi of queueItems) {
    if (qi.status === 'pending') {
      qi.status = 'cancelled';
      qi.finished_at = Date.now() / 1000;
      queuedUserIds[qi.user_id] = Math.max(0, (queuedUserIds[qi.user_id] || 0) - 1);
      if (queuedUserIds[qi.user_id] === 0) delete queuedUserIds[qi.user_id];
      cleared++;
    }
  }
  res.json({ ok: true, cleared });
});

export { router as queueRouter, queueItems, queuedUserIds };
