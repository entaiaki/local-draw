import express, { Router, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../services/config.js';
import { queueItems, queuedUserIds } from './queue.js';

const router = Router();
router.use(express.json({ limit: "50mb" }));
let wss: WebSocketServer;
let activeCount = 0;
let activeStatus: Record<string, unknown> | null = null;

export function setupWsStatus(server: WebSocketServer, config: AppConfig) {
  wss = server;
  server.on('connection', (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: 'status', online: server.clients.size, active: activeCount, busy: activeCount > 0, ...(activeStatus || {}) }));
    ws.on('close', () => broadcast({ type: 'online', count: server.clients.size }));
  });
}

export function broadcast(msg: Record<string, unknown>) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

export function setActive(count: number, status?: Record<string, unknown>) {
  activeCount = count;
  if (status) activeStatus = { ...activeStatus, ...status, active: count };
  broadcast({ type: 'status', online: wss?.clients?.size || 0, active: count, busy: count > 0, ...(activeStatus || {}) });
}

export function resetActive() {
  activeCount = 0; activeStatus = null;
  broadcast({ type: 'status', online: wss?.clients?.size || 0, active: 0, busy: false });
}

function verifyToken(token: string, secret: string): any {
  try { return jwt.verify(token, Buffer.from(secret, 'utf-8')); } catch { return null; }
}

function loadCreatorMap(filePath: string): Record<string, number> {
  const map: Record<string, number> = {};
  try {
    if (fs.existsSync(filePath)) {
      for (const ln of fs.readFileSync(filePath, 'utf-8').split('\n')) {
        const parts = ln.split('\t');
        if (parts.length === 2 && /^\d+$/.test(parts[1].trim())) map[parts[0].trim()] = parseInt(parts[1].trim());
      }
    }
  } catch {}
  return map;
}

// GET /api/_diag
router.get('/_diag', (req: Request, res: Response) => {
  res.json({ active_count: activeCount, active_status: activeStatus, subscribers: wss?.clients?.size || 0 });
});

// GET /api/draw/my-images
router.get('/my-images', (req: Request, res: Response) => {
  const cfg = loadConfig();
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, cfg.jwt_secret);
  if (!user?.id) return res.status(401).json({ detail: 'unauthorized' });

  const cmap = loadCreatorMap(cfg.creator_map_file);
  const items: { path: string; mtime: number }[] = [];
  const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

  for (const [relPath, uid] of Object.entries(cmap)) {
    if (uid !== user.id) continue;
    const relNorm = relPath.replace(/\\/g, '/').replace(/^\//, '');
    if (relNorm.includes('..')) continue;
    for (const baseDir of [cfg.output_dir, cfg.archive_dir]) {
      const fp = path.resolve(baseDir, relNorm);
      if (fp.startsWith(path.resolve(baseDir)) && fs.existsSync(fp) && exts.includes(path.extname(fp).toLowerCase())) {
        try { items.push({ path: relPath, mtime: fs.statSync(fp).mtimeMs / 1000 }); } catch {}
        break;
      }
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  res.json({ items, total: items.length });
});

// GET /api/draw/debug
router.get('/debug', async (req: Request, res: Response) => {
  const cfg = loadConfig();
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, cfg.jwt_secret);
  if (!user || user.role !== 'admin') return res.status(403).json({ detail: '需要管理员权限' });
  const now = Date.now() / 1000;
  // Queue stats
  const stats: Record<string, number> = { pending: 0, waiting: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const qi of queueItems) { const s = qi.status; stats[s] = (stats[s] || 0) + 1; }
  // Stuck items (>30 min)
  const stuck = queueItems.filter(qi => (qi.status === 'pending' && now - qi.created_at > 1800) || (qi.status === 'running' && qi.started_at != null && now - qi.started_at > 1800));
  // Recent items
  const recent = [...queueItems].reverse().slice(0, 20);
  res.json({
    active: { count: activeCount, status: activeStatus, semaphore_locked: activeCount > 0, subscribers: wss?.clients?.size || 0 },
    queue_stats: stats,
    queue_users: Object.entries(queuedUserIds).map(([uid, c]) => [parseInt(uid), c]),
    stuck: stuck.map(qi => ({ id: qi.id, user_id: qi.user_id, status: qi.status })),
    // 包含 prompt 和图引用
    recent_items_full: recent.map(qi => ({
      id: qi.id, user_id: qi.user_id, status: qi.status,
      created_ago: Math.round(now - qi.created_at),
      started_ago: qi.started_at ? Math.round(now - qi.started_at) : null,
      error: qi.error,
      llm_output: String((qi.params as any)?._llm_output || ''),
      nl_prompt: String((qi.params as any)?.nl_prompt || ''),
      negative_prompt: String((qi.params as any)?.negative_prompt || ''),
      rewrite: Boolean((qi.params as any)?.rewrite),
      image1: String((qi.params as any)?.image1_name || ''),
      image2: String((qi.params as any)?.image2_name || ''),
      image2: (qi.params as any)?.image2_name || null,
    })),
    recent_items: recent.map(qi => ({ id: qi.id, user_id: qi.user_id, status: qi.status, created_ago: Math.round(now - qi.created_at), started_ago: qi.started_at ? Math.round(now - qi.started_at) : null, error: qi.error, nl_prompt: String((qi.params as any)?.nl_prompt || (qi.params as any)?.direct_prompt || ''), llm_output: String((qi.params as any)?._llm_output || ''), image1: (qi.params as any)?.image1_name || null, image2: (qi.params as any)?.image2_name || null, type: (qi.params as any)?.image1_name ? 'img2img' : 'txt2img' })),
    recent_items_count: recent.length,
  });
});

export { router as statusRouter };
