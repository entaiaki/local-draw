import express, { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { loadConfig } from '../services/config.js';
import sharp from 'sharp';

const router = Router();
router.use(express.json({ limit: "50mb" }));
const config = loadConfig();
const OUTPUT_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const THUMB_DIR = path.join(process.cwd(), 'thumbnails');

function resolveOutputPath(rel: string): string | null {
  if (!rel) return null;
  const relNorm = rel.replace(/\\/g, '/').replace(/^\//, '');
  if (relNorm.includes('..')) return null;
  for (const baseDir of [config.output_dir, config.archive_dir]) {
    const candidate = path.resolve(baseDir, relNorm);
    if (candidate.startsWith(path.resolve(baseDir)) && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function loadCreatorMap(): Record<string, number> {
  const map: Record<string, number> = {};
  try {
    if (fs.existsSync(config.creator_map_file)) {
      for (const ln of fs.readFileSync(config.creator_map_file, 'utf-8').split('\n')) {
        const parts = ln.split('\t');
        if (parts.length === 2 && /^\d+$/.test(parts[1].trim())) map[parts[0].trim()] = parseInt(parts[1].trim());
      }
    }
  } catch {}
  return map;
}

// GET /api/output/file
router.get('/file', async (req: Request, res: Response) => {
  const fp = resolveOutputPath(req.query.path as string);
  if (!fp) return res.status(404).json({ error: 'not found' });
  const ext = path.extname(fp).toLowerCase();
  if (!OUTPUT_IMAGE_EXTS.includes(ext)) return res.status(400).json({ error: 'not an image' });
  // raw=1: 跳过压缩，直接下载原图
  if (req.query.raw === '1') {
    const filename = path.basename(fp);
    const mt: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
    return res.sendFile(fp, {
      headers: {
        'Content-Type': mt[ext] || 'image/png',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-cache'
      }
    });
  }
  // 自动压缩（WebP 优先）
  try {
    const stat = fs.statSync(fp);
    if (stat.size > 50 * 1024) {
      const accept = (req.headers.accept || '').toLowerCase();
      const preferWebp = accept.includes('image/webp');
      const pipeline = sharp(fp, { animated: ext === '.gif' }).rotate();
      if (preferWebp) {
        const buf = await pipeline.webp({ quality: 75, effort: 0 }).toBuffer();
        if (buf.length < stat.size * 0.8) { res.type('image/webp').send(buf); return; }
      } else {
        const buf = await pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
        if (buf.length < stat.size * 0.8) { res.type('image/jpeg').send(buf); return; }
      }
    }
  } catch {}
  const mt: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
  res.sendFile(fp, { headers: { 'Content-Type': mt[ext] || 'image/png' } });
});

// GET /api/output/list
router.get('/list', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 500;
  const offset = parseInt(req.query.offset as string) || 0;
  const cmap = loadCreatorMap();
  const items: { path: string; mtime: number | null; creator_id: string }[] = [];
  const seen = new Set<string>();
  if (fs.existsSync(config.output_dir)) {
    for (const f of fs.readdirSync(config.output_dir).filter(f => OUTPUT_IMAGE_EXTS.includes(path.extname(f).toLowerCase()))) {
      if (seen.has(f)) continue; seen.add(f);
      try { const s = fs.statSync(path.join(config.output_dir, f)); items.push({ path: f, mtime: s.mtimeMs / 1000, creator_id: String(cmap[f] || ''), user_id: String(cmap[f] || '') }); } catch {}
    }
  }
  items.sort((a: any, b: any) => (b.mtime || 0) - (a.mtime || 0));
  const page = items.slice(offset, offset + limit);
  res.json({ items: page, total: items.length });
});

// GET /api/output/featured
router.get('/featured', (req: Request, res: Response) => {
  const featuredFile = config.creator_map_file.replace('creator_users.txt', 'featured.txt');
  let paths: string[] = [];
  try {
    if (fs.existsSync(featuredFile)) {
      const raw = fs.readFileSync(featuredFile, 'utf-8').trim();
      // 支持 JSON 数组和纯文本（每行一个路径）两种格式
      if (raw.startsWith('[')) paths = JSON.parse(raw);
      else paths = raw.split('\n').map(l => l.trim()).filter(Boolean);
    }
  } catch {}
  const cmap = loadCreatorMap();
  const items = paths.map((p: string) => ({ path: p, creator_id: String(cmap[p] || '?') }));
  res.json({ items, total: items.length });
});

// GET /api/thumbnail
router.get('/thumbnail', (req: Request, res: Response) => {
  const p = req.query.path as string;
  if (!p) return res.status(404).json({ error: 'no thumbnail' });
  // Try thumbnails directory first, then fallback to original
  for (const sub of ['', 'thumbnails/']) {
    const fp = path.resolve(sub ? THUMB_DIR : config.output_dir, path.basename(p));
    if (fs.existsSync(fp)) return res.sendFile(fp);
  }
  const orig = resolveOutputPath(p);
  if (orig) return res.sendFile(orig);
  res.status(404).json({ error: 'not found' });
});


// POST /api/output/fork — fork
router.post('/fork', async (req, res) => {
  const fp = resolveOutputPath(req.body?.path);
  if (!fp) return res.status(404).json({ error: 'not found' });
  const basename = path.basename(fp);
  const pmFile = path.join(path.dirname(config.creator_map_file), 'prompt_meta.json');
  try {
    const pm = JSON.parse(fs.readFileSync(pmFile, 'utf-8'));
    const meta = pm[basename];
    if (meta?.image1) return res.status(400).json({ error: 'img2img 不支持 fork' });
    let wfPath = meta?.workflow_path || '';
    if (wfPath && wfPath !== 'fork') {
      const { workflowToPromptApi } = await import('../services/runner.js');
      const tail = wfPath.replace(/\\\\/g, '/').split('/').map((p: string) => encodeURIComponent(p)).join('%2F');
      const url = `http://${config.comfyui_host}:${config.comfyui_port}/api/userdata/workflows%2F${tail}`;
      const r = await (await import('axios')).default.get(url, { headers: { 'Comfy-User': '' }, timeout: 10000 });
      const { prompt_dict, positive_ref, negative_ref } = workflowToPromptApi(r.data);
      let bp = '', bn = '';
      if (positive_ref) { const v = prompt_dict[positive_ref[0]]?.inputs?.[positive_ref[1]]; if (typeof v === 'string') bp = v; }
      if (negative_ref) { const v = prompt_dict[negative_ref[0]]?.inputs?.[negative_ref[1]]; if (typeof v === 'string') bn = v; }
      const wfName = wfPath.replace(/\.json$/i, '').split('/').pop() || '';
	      return res.json({ workflow_api: prompt_dict, workflow_path: wfPath, workflow_name: wfName, builtin_prompt: meta?.prompt || bp || '', builtin_negative_prompt: meta?.negative_prompt || bn || '', seed: Math.floor(Math.random() * 2147483647) + 1 });
    }
    // 有 metadata 但无 workflow_path 时拒绝
    if (!meta?.workflow_path) return res.status(400).json({ error: '该图片无工作流信息，无法 Fork' });
  } catch {}
  res.json({ workflow_api: null, builtin_prompt: '', builtin_negative_prompt: '', seed: Math.floor(Math.random() * 2147483647) + 1 });
});

router.get('/my-recommendations', (req: Request, res: Response) => {
  const recFile = config.creator_map_file.replace('creator_users.txt', 'recommendations.json');
  try {
    const data = JSON.parse(fs.readFileSync(recFile, 'utf-8'));
    res.json({ items: data, total: data.length });
  } catch { res.json({ items: [], total: 0 }); }
});

// POST /api/draw/recommend
router.post('/recommend', (req: Request, res: Response) => {
  const { image_path, reason } = req.body || {};
  if (!image_path) return res.status(400).json({ error: 'need image_path' });
  const recFile = config.creator_map_file.replace('creator_users.txt', 'recommendations.json');
  let items: any[] = [];
  try { items = JSON.parse(fs.readFileSync(recFile, 'utf-8')); } catch {}
  items.push({ image_path, reason: reason || '', status: 'pending', created_at: Date.now() / 1000 });
  fs.writeFileSync(recFile, JSON.stringify(items, null, 2), 'utf-8');
  res.json({ ok: true });
});

// DELETE /api/draw/my-images
router.delete('/my-images', (req: Request, res: Response) => {
  const cfg = loadConfig();
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const jwt = require('jsonwebtoken');
  let user: any = null;
  try { user = jwt.verify(token, Buffer.from(cfg.jwt_secret, 'utf-8')); } catch {}
  if (!user?.id) return res.status(401).json({ detail: 'unauthorized' });

  const relPath = req.body?.path as string;
  if (!relPath) return res.status(400).json({ error: 'need path' });

  // Record to deleted list (keep UID and file, just mark as deleted for admin)
  try {
    const df = path.join(path.dirname(cfg.creator_map_file), 'deleted_images.json');
    let deleted: string[] = [];
    try { deleted = JSON.parse(fs.readFileSync(df, 'utf-8')); } catch {}
    if (!deleted.includes(relPath)) deleted.push(relPath);
    fs.writeFileSync(df, JSON.stringify(deleted, null, 2), 'utf-8');
  } catch {}
  res.json({ ok: true });
});

export { router as imageRouter };
