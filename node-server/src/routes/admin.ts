import express, { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { loadConfig, loadLimits, saveJson, DEFAULT_LIMITS, loadJson } from '../services/config.js';
import { Limits } from '../types/index.js';
import fs from 'fs';
import path from 'path';

interface BanEntry {
  user_id: number;
  reason: string;
  banned_at: number;
  banned_until: number;
}
function loadBans(): BanEntry[] {
  try {
    const f = path.join(path.dirname(config.creator_map_file), 'banned_users.txt');
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'number') {
        const migrated = raw.map((id: number) => ({ user_id: id, reason: '违规行为', banned_at: Math.floor(Date.now() / 1000) - 86400 * 365, banned_until: Math.floor(Date.now() / 1000) + 86400 * 30 }));
        saveBans(migrated);
        return migrated;
      }
      return raw;
    }
  } catch {}
  return [];
}
function saveBans(bans: BanEntry[]): void {
  const f = path.join(path.dirname(config.creator_map_file), 'banned_users.txt');
  fs.writeFileSync(f, JSON.stringify(bans, null, 2), 'utf-8');
}
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

const DEFAULT_PROFILES = [
  { name: 'Google Gemini', provider: 'google', google_api_key: '', google_model: 'gemma-4-31b-it', google_thinking: 'off', llm_stream: true },
  { name: 'Custom', provider: 'custom', custom_endpoint: '', custom_api_key: '', custom_model: '', llm_stream: true },
];
const KEY_FIELDS = new Set(['google_api_key', 'custom_api_key']);

function maskProfiles(profiles: any[]): any[] {
  return profiles.map(p => {
    const mp = { ...p };
    for (const k of KEY_FIELDS) {
      if (k in mp) mp[k] = mp[k] ? '***' : '';
    }
    return mp;
  });
}

function migrateLlmConfig(d: any): any {
  if (d.profiles && Array.isArray(d.profiles)) return d;
  // 旧格式 -> 放入 profile[0]
  const p0: any = { name: '配置1', provider: 'custom', custom_endpoint: '', custom_api_key: '', custom_model: '', llm_stream: true };
  for (const k of ['local_endpoint', 'google_api_key', 'google_model', 'google_thinking',
                    'custom_endpoint', 'custom_api_key', 'custom_model', 'llm_stream', 'provider']) {
    if (d[k] !== undefined) p0[k] = d[k];
  }
  // local → custom（local_endpoint 转为 custom_endpoint）
  if (d.provider === 'local') {
    p0.provider = 'custom';
    p0.custom_endpoint = d.local_endpoint || '';
    delete p0.local_endpoint;
    for (const k of ['google_api_key', 'google_model', 'google_thinking']) delete p0[k];
  }
  return { profiles: [p0], active: 0 };
}

// GET /api/draw/admin/llm_config
router.get('/llm_config', requireAdmin, (req: Request, res: Response) => {
  let d: any = { profiles: [...DEFAULT_PROFILES.map(p => ({...p}))], active: 0 };
  try {
    const raw = loadJson<any>(config.llm_config_file, {});
    if (raw && typeof raw === 'object') d = migrateLlmConfig(raw);
  } catch {}
  res.json({
    config: { profiles: maskProfiles(d.profiles || []), active: d.active ?? 0 },
    providers: ['google', 'custom'],
  });
});

// POST /api/draw/admin/llm_config
router.post('/llm_config', requireAdmin, (req: Request, res: Response) => {
  const { profiles, active } = req.body as { profiles?: any[]; active?: number };
  if (!Array.isArray(profiles)) return res.status(400).json({ error: 'profiles must be array' });

  // 加载当前配置以获取已有的 key 值
  let current: any = {};
  try { current = loadJson<any>(config.llm_config_file, {}); } catch {}
  const curProfiles: any[] = current.profiles || [];

  const newProfiles = profiles.map((p: any, i: number) => {
    const cur = curProfiles[i] || {};
    const out: any = { ...cur };
    for (const [k, v] of Object.entries(p)) {
      if (KEY_FIELDS.has(k)) {
        if (v === '***') continue;
        out[k] = String(v ?? '');
      } else if (k === 'provider') {
        if (!['google', 'custom'].includes(v as string)) continue;
        out[k] = v;
      } else if (k === 'llm_stream') {
        out[k] = Boolean(v);
      } else {
        out[k] = v;
      }
    }
    // 清洗无关字段
    const prov = out.provider || '';
    for (const f of ['google_api_key', 'google_model', 'google_thinking']) if (prov !== 'google' && f in out) delete out[f];
    for (const f of ['custom_endpoint', 'custom_api_key', 'custom_model']) if (prov !== 'custom' && f in out) delete out[f];
    return out;
  });

  const newActive = typeof active === 'number' ? Math.max(0, Math.min(active, newProfiles.length - 1)) : 0;
  saveJson(config.llm_config_file, { profiles: newProfiles, active: newActive });
  res.json({ ok: true, config: { profiles: maskProfiles(newProfiles), active: newActive } });
});

// POST /api/draw/admin/llm_config/test
router.post('/llm_config/test', requireAdmin, async (req: Request, res: Response) => {
  try {
    const raw: any = loadJson<any>(config.llm_config_file, {});
    const d = migrateLlmConfig(raw);
    const idx = req.body?.profile_index ?? d.active ?? 0;
    const profiles: any[] = d.profiles || [];
    if (idx < 0 || idx >= profiles.length) return res.status(400).json({ error: 'invalid profile_index' });
    const profile = profiles[idx];
    const provider = profile.provider || 'custom';

    // 用实际的标签翻译 prompt 测试，拿到原始回复再展示
    const systemPrompt = 'You are a Danbooru tag generator. Reply ONLY with:\nPOSITIVE: <english tags>\nNEGATIVE: <english tags>';
    const userPrompt = '一个可爱的女孩在阳光下微笑';
    let rawReply = '';

    if (provider === 'google') {
      const apiKey = profile.google_api_key || '';
      if (!apiKey) return res.json({ ok: false, error: 'Google API Key 未配置' });
      const model = profile.google_model || 'gemma-4-31b-it';
      const r = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        { systemInstruction: { parts: [{ text: systemPrompt }] }, contents: [{ parts: [{ text: userPrompt }] }] },
        { timeout: 60000 }
      );
      rawReply = r.data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
    } else {
      const endpoint = profile.custom_endpoint;
      if (!endpoint) return res.json({ ok: false, error: '端点未配置' });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (profile.custom_api_key) headers['Authorization'] = `Bearer ${profile.custom_api_key}`;
      const r = await axios.post(`${endpoint.replace(/\/+$/, '')}/chat/completions`, {
        model: profile.custom_model || 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7, max_tokens: 500,
      }, { headers, timeout: 60000 });
      rawReply = r.data.choices?.[0]?.message?.content || '';
    }

    // 尝试解析 POSITIVE:/NEGATIVE:
    const posMatch = rawReply.match(/POSITIVE:\s*(.+?)(?:\n|$)/i);
    const negMatch = rawReply.match(/NEGATIVE:\s*(.+?)(?:\n|$)/i);
    if (posMatch) {
      res.json({ ok: true, provider, profile_index: idx, reply: `POSITIVE: ${posMatch[1].trim()}\nNEGATIVE: ${negMatch ? negMatch[1].trim() : ''}` });
    } else {
      res.json({ ok: false, provider, profile_index: idx, error: '模型返回格式不符合要求（需要 POSITIVE:/NEGATIVE:）', raw: rawReply.slice(0, 500) });
    }
  } catch (e: any) {
    const msg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : (e.message || String(e));
    res.json({ ok: false, error: msg.slice(0, 500) });
  }
});

// POST /api/draw/admin/llm_config/models
router.post('/llm_config/models', requireAdmin, async (req: Request, res: Response) => {
  try {
    const raw: any = loadJson<any>(config.llm_config_file, {});
    const d = migrateLlmConfig(raw);
    const idx = req.body?.profile_index ?? d.active ?? 0;
    const profiles: any[] = d.profiles || [];
    if (idx < 0 || idx >= profiles.length) return res.status(400).json({ error: 'invalid profile_index' });
    const profile = profiles[idx];
    const provider = profile.provider || 'custom';
    let models: string[] = [];

    if (provider === 'google') {
      const apiKey = profile.google_api_key || '';
      if (!apiKey) return res.json({ ok: false, error: 'Google API Key 未配置' });
      const r = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, { timeout: 15000 });
      models = (r.data.models || []).map((m: any) => m.name).filter(Boolean);
    } else {
      const endpoint = profile.custom_endpoint;
      if (!endpoint) return res.json({ ok: false, error: '端点未配置' });
      const url = `${endpoint.replace(/\/+$/, '')}/models`;
      const headers: Record<string, string> = {};
      if (provider === 'custom' && profile.custom_api_key) headers['Authorization'] = `Bearer ${profile.custom_api_key}`;
      const r = await axios.get(url, { timeout: 15000, headers });
      models = (r.data.data || []).map((m: any) => m.id).filter(Boolean);
    }

    res.json({ ok: true, models, provider, profile_index: idx });
  } catch (e: any) {
    res.json({ ok: false, error: (e.message || String(e)).slice(0, 500) });
  }
});

// GET /api/draw/admin/draw-banned
router.get('/draw-banned', requireAdmin, (req: Request, res: Response) => {
  // loadBans defined above
  const bans = loadBans();
  const now = Math.floor(Date.now() / 1000);
  res.json({ banned: bans.filter((b: any) => b.banned_until > now).map((b: any) => ({ user_id: b.user_id, reason: b.reason, banned_until: b.banned_until, remaining_days: Math.max(1, Math.ceil((b.banned_until - now) / 86400)) })) });
});

// POST /api/draw/admin/draw-ban
router.post('/draw-ban', requireAdmin, (req: Request, res: Response) => {
  const { user_id, days, reason } = req.body as { user_id?: number; days?: number; reason?: string };
  if (!user_id) return res.status(400).json({ error: 'need user_id' });
  if (!days || days < 1) return res.status(400).json({ error: 'need days >= 1' });
  // loadBans, saveBans defined above
  let bans = loadBans();
  // Remove existing ban for this user
  bans = bans.filter((b: any) => b.user_id !== user_id);
  bans.push({ user_id, reason: reason || '违规行为', banned_at: Math.floor(Date.now() / 1000), banned_until: Math.floor(Date.now() / 1000) + days * 86400 });
  saveBans(bans);
  res.json({ ok: true, banned: bans.filter((b: any) => b.user_id === user_id).map((b: any) => ({ user_id: b.user_id, reason: b.reason, banned_until: b.banned_until, remaining_days: days })) });
});

// POST /api/draw/admin/draw-unban
router.post('/draw-unban', requireAdmin, (req: Request, res: Response) => {
  const { user_id } = req.body as { user_id?: number };
  if (!user_id) return res.status(400).json({ error: 'need user_id' });
  // loadBans, saveBans defined above
  let bans = loadBans();
  bans = bans.filter((b: any) => b.user_id !== user_id);
  saveBans(bans);
  res.json({ ok: true, banned: bans });
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

  const items: any[] = [];
  const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  if (fs.existsSync(config.output_dir)) {
    for (const f of fs.readdirSync(config.output_dir).filter((f: string) => exts.includes(path.extname(f).toLowerCase()))) {
      try {
        const s = fs.statSync(path.join(config.output_dir, f));
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
  try { const d = JSON.parse(fs.readFileSync(f, 'utf-8')).filter((i: any) => i.status === 'pending'); res.json({ items: d, total: d.length }); } catch { res.json({ items: [], total: 0 }); }
});

// POST /api/draw/admin/recommendations/resolve
router.post('/recommendations/resolve', requireAdmin, (req, res) => {
  const f = config.creator_map_file.replace('creator_users.txt', 'recommendations.json');
  try {
    const items = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const idx = items.findIndex((i: any) => i.id === req.body?.rec_id);
    if (idx >= 0) {
      items[idx].status = req.body?.action === 'approve' ? 'approved' : 'rejected';
      items[idx].admin_reason = req.body?.reason || '';
      items[idx].resolved_at = Date.now() / 1000;
      fs.writeFileSync(f, JSON.stringify(items, null, 2), 'utf-8');
    }
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
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
