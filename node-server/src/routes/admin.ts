import express, { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { loadConfig, loadLimits, saveJson, DEFAULT_LIMITS, loadJson } from '../services/config.js';
import { Limits, LlmConfig } from '../types/index.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const router = Router();
router.use(express.json({ limit: '50mb' }));
const config = loadConfig();

// GET /api/draw/admin/limits
router.get('/limits', requireAdmin, (req: Request, res: Response) => {
  const limits = loadLimits(config.limits_file);
  res.json({ limits, defaults: DEFAULT_LIMITS });
});

// POST /api/draw/admin/limits
router.post('/limits', requireAdmin, (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const current = loadLimits(config.limits_file);
  const merged = { ...current };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (body[key] !== undefined) {
      (merged as any)[key] = body[key];
    }
  }
  saveJson(config.limits_file, merged);
  res.json({ limits: merged });
});

// GET /api/draw/admin/llm_config
router.get('/llm_config', requireAdmin, (req: Request, res: Response) => {
  const llmConfig = loadJson<LlmConfig>(config.llm_config_file, {
    provider: 'local',
    local_endpoint: config.lms_api,
    google_api_key: '',
    google_model: 'gemma-4-31b-it',
    google_thinking: 'off',
    custom_endpoint: '',
    custom_api_key: '',
    custom_model: '',
    llm_stream: true,
  });
  res.json({ config: llmConfig });
});

// POST /api/draw/admin/llm_config
router.post('/llm_config', requireAdmin, (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  saveJson(config.llm_config_file, body);
  res.json({ ok: true });
});

// POST /api/draw/admin/llm_config/test
router.post('/llm_config/test', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { loadConfig } = await import('../services/config.js');
    const cfg = loadConfig();
    const llmCfg = loadJson<any>(cfg.llm_config_file, { provider: 'local' });
    const { translatePrompt } = await import('../services/llm.js');
    const result = await translatePrompt('一个女孩在花园里站着', undefined, undefined, config);
    res.json({ ok: true, provider: llmCfg.provider || 'local', reply: result.positive.slice(0, 500) });
  } catch (e: any) {
    res.json({ ok: false, provider: '', error: (e.message || String(e)).slice(0, 500) });
  }
});

// GET /api/draw/admin/draw-banned
router.get('/draw-banned', requireAdmin, (req: Request, res: Response) => {
  const bannedFile = config.creator_map_file.replace('creator_users.txt', 'banned_users.txt');
  const banned = loadJson<number[]>(bannedFile, []);
  res.json({ banned });
});

// POST /api/draw/admin/draw-ban
router.post('/draw-ban', requireAdmin, (req: Request, res: Response) => {
  const { user_id } = req.body as { user_id?: number };
  if (!user_id) return res.status(400).json({ error: 'need user_id' });
  const bannedFile = config.creator_map_file.replace('creator_users.txt', 'banned_users.txt');
  const banned = loadJson<number[]>(bannedFile, []);
  if (!banned.includes(user_id)) banned.push(user_id);
  saveJson(bannedFile, banned);
  res.json({ ok: true, banned });
});

// POST /api/draw/admin/draw-unban
router.post('/draw-unban', requireAdmin, (req: Request, res: Response) => {
  const { user_id } = req.body as { user_id?: number };
  if (!user_id) return res.status(400).json({ error: 'need user_id' });
  const bannedFile = config.creator_map_file.replace('creator_users.txt', 'banned_users.txt');
  const banned = loadJson<number[]>(bannedFile, []);
  const updated = banned.filter((id: number) => id !== user_id);
  saveJson(bannedFile, updated);
  res.json({ ok: true, banned: updated });
});

// GET /api/draw/admin/featured
router.get('/featured', requireAdmin, (req: Request, res: Response) => {
  const featuredFile = config.creator_map_file.replace('creator_users.txt', 'featured.txt');
  const paths = loadJson<string[]>(featuredFile, []);
  res.json({ items: paths });
});

// POST /api/draw/admin/featured/add
router.post('/featured/add', requireAdmin, (req: Request, res: Response) => {
  const { path: imagePath } = req.body as { path?: string };
  if (!imagePath) return res.status(400).json({ error: 'need path' });
  const featuredFile = config.creator_map_file.replace('creator_users.txt', 'featured.txt');
  const paths = loadJson<string[]>(featuredFile, []);
  if (!paths.includes(imagePath)) paths.push(imagePath);
  saveJson(featuredFile, paths);
  res.json({ ok: true, items: paths });
});

// POST /api/draw/admin/featured/remove
router.post('/featured/remove', requireAdmin, (req: Request, res: Response) => {
  const { path: imagePath } = req.body as { path?: string };
  if (!imagePath) return res.status(400).json({ error: 'need path' });
  const featuredFile = config.creator_map_file.replace('creator_users.txt', 'featured.txt');
  const paths = loadJson<string[]>(featuredFile, []);
  const idx = paths.indexOf(imagePath);
  if (idx >= 0) paths.splice(idx, 1);
  saveJson(featuredFile, paths);
  res.json({ ok: true, items: paths });
});

// POST /api/draw/admin/featured/reorder
router.post('/featured/reorder', requireAdmin, (req: Request, res: Response) => {
  const { items } = req.body as { items?: string[] };
  if (!items) return res.status(400).json({ error: 'need items' });
  const featuredFile = config.creator_map_file.replace('creator_users.txt', 'featured.txt');
  saveJson(featuredFile, items);
  res.json({ ok: true, items });
});

// GET /api/draw/admin/announcement
router.get('/announcement', requireAdmin, (req, res) => {
  const f = config.creator_map_file.replace('creator_users.txt', 'announcement.json');
  try { const d = JSON.parse(fs.readFileSync(f, 'utf-8')); res.json({ announcement: d }); } catch { res.json({ announcement: { enabled: false, title: '', content: '' } }); }
});

// POST /api/draw/admin/announcement
router.post('/announcement', requireAdmin, (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'empty body' });
  const data = req.body.announcement || req.body;
  const f = config.creator_map_file.replace('creator_users.txt', 'announcement.json');
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf-8');
  res.json({ ok: true });
});

// GET /api/draw/admin/recent
router.get('/recent', requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit as string) || 200;
  const offset = parseInt(req.query.offset as string) || 0;
  // Load creator_map
  const cmap: Record<string, string> = {};
  try { for (const ln of fs.readFileSync(config.creator_map_file, 'utf-8').split('\n')) { const p = ln.split('\t'); if (p.length === 2) cmap[p[0].trim()] = p[1].trim(); } } catch {}
  // Load queue state for prompt/original image info
  // 加载 prompt 元数据
  const promptMetaFile = path.join(path.dirname(config.creator_map_file), 'prompt_meta.json');
  let promptMeta: Record<string, any> = {};
  try { promptMeta = JSON.parse(fs.readFileSync(promptMetaFile, 'utf-8')); } catch {}

  const seen = new Set<string>();
  const items: any[] = [];
  const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  for (const baseDir of [config.output_dir, config.archive_dir]) {
    if (!fs.existsSync(baseDir)) continue;
    for (const f of fs.readdirSync(baseDir).filter((f: string) => exts.includes(path.extname(f).toLowerCase()))) {
      if (seen.has(f)) continue;
      seen.add(f);
      try {
        const s = fs.statSync(path.join(baseDir, f));
        const uid = cmap[f] || '';
        const m = promptMeta[f] || {};
        items.push({ path: f, mtime: s.mtimeMs / 1000, size: s.size, creator_id: uid, user_id: uid, prompt: String(m.prompt || ''), nl_prompt: String(m.nl_prompt || ''), negative_prompt: String(m.negative_prompt || ''), rewrite: Boolean(m.rewrite), image1: String(m.image1 || ''), image2: String(m.image2 || '') });
      } catch {}
    }
  }
  items.sort((a: any, b: any) => (b.mtime || 0) - (a.mtime || 0));
  res.json({ items: items.slice(offset, offset + limit), total: items.length });
});

// GET /api/draw/admin/images_by_user
router.get('/images_by_user', requireAdmin, (req, res) => {
  const uid = parseInt(req.query.user_id as string);
  const cmap: Record<string, number> = {};
  try { for (const ln of fs.readFileSync(config.creator_map_file, 'utf-8').split('\n')) { const p = ln.split('\t'); if (p.length === 2) cmap[p[0].trim()] = parseInt(p[1].trim()); } } catch {}
  const items = Object.entries(cmap).filter(([, v]) => v === uid).map(([k]) => ({ path: k }));
  res.json({ items, total: items.length });
});

// DELETE /api/draw/admin/delete
router.delete('/delete', requireAdmin, (req, res) => {
  const { path: imagePath } = req.body || {};
  if (!imagePath) return res.status(400).json({ error: 'need path' });
  let deleted = 0, failed = 0;
  const dirs = [config.output_dir, config.archive_dir];
  for (const dir of dirs) {
    const fp = path.resolve(dir, imagePath.replace(/\\/g, '/').replace(/^\//, ''));
    if (fp.startsWith(path.resolve(dir)) && fs.existsSync(fp)) {
      try { fs.unlinkSync(fp); deleted++; } catch { failed++; }
    }
  }
  res.json({ ok: true, deleted, failed });
});

// POST /api/draw/admin/delete_batch
router.post('/delete_batch', requireAdmin, (req, res) => {
  const { paths } = req.body || {};
  if (!Array.isArray(paths)) return res.status(400).json({ error: 'need paths array' });
  let deleted = 0, failed = 0;
  for (const p of paths) {
    for (const dir of [config.output_dir, config.archive_dir]) {
      const fp = path.resolve(dir, String(p).replace(/\\/g, '/').replace(/^\//, ''));
      if (fp.startsWith(path.resolve(dir)) && fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); deleted++; } catch { failed++; }
      }
    }
  }
  res.json({ ok: true, deleted, failed });
});

// GET /api/draw/admin/gc
router.get('/gc', requireAdmin, (req, res) => {
  // Simplified GC - just report
  res.json({ cleaned: { orphaned_files: 0, stale_queue: 0 } });
});

// POST /api/draw/admin/gc
router.post('/gc', requireAdmin, (req, res) => {
  res.json({ cleaned: { orphaned_files: 0, stale_queue: 0 } });
});

// GET /api/draw/admin/reports
router.get('/reports', requireAdmin, (req, res) => {
  const f = config.creator_map_file.replace('creator_users.txt', 'reports.json');
  try { res.json(JSON.parse(fs.readFileSync(f, 'utf-8'))); } catch { res.json([]); }
});

// POST /api/draw/admin/report/resolve
router.post('/report/resolve', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

// GET /api/draw/admin/recommendations
router.get('/recommendations', requireAdmin, (req, res) => {
  const f = config.creator_map_file.replace('creator_users.txt', 'recommendations.json');
  try { const d = JSON.parse(fs.readFileSync(f, 'utf-8')); res.json({ items: d, total: d.length }); } catch { res.json({ items: [], total: 0 }); }
});

// POST /api/draw/admin/recommendations/resolve
router.post('/recommendations/resolve', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

// GET /api/draw/admin/workflow_files
router.get('/workflow_files', requireAdmin, async (req, res) => {
  try {
    const r = await axios.get(`http://${config.comfyui_host}:${config.comfyui_port}/api/userdata`, {
      params: { dir: 'workflows', recurse: 'true', split: 'false', full_info: 'true' }, headers: { 'Comfy-User': '' }
    });
    res.json(r.data);
  } catch { res.json({ workflows: [], category_order: [] }); }
});

// GET /api/draw/admin/workflow_meta
router.get('/workflow_meta', requireAdmin, (req, res) => {
  const f = config.creator_map_file.replace('creator_users.txt', 'workflow_meta.json');
  try { res.json(JSON.parse(fs.readFileSync(f, 'utf-8'))); } catch { res.json([]); }
});

// POST /api/draw/admin/workflow_rename
router.post('/workflow_rename', requireAdmin, (req, res) => { res.json({ ok: true }); });

// GET /api/draw/admin/style_thumbnail
router.get('/style_thumbnail', (req, res) => {
  const name = req.query.name as string;
  if (!name) return res.status(404).json({ error: 'no style' });
  const thumbDir = config.thumb_dir || path.join(process.cwd(), '..', 'web', 'thumbnails');
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const fp = path.resolve(thumbDir, name + ext);
    if (fp.startsWith(path.resolve(thumbDir)) && fs.existsSync(fp)) return res.sendFile(fp);
  }
  res.status(404).json({ error: 'not found' });
});

// GET /api/draw/admin/styles
router.get('/styles', requireAdmin, (req, res) => {
  const sf = path.join(path.dirname(config.creator_map_file), 'styles.json');
  try { res.json(JSON.parse(fs.readFileSync(sf, 'utf-8'))); } catch { res.json({ styles: [] }); }
});

export { router as adminRouter };
