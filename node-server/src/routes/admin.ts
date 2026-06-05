import express, { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { loadConfig, loadLimits, saveJson, DEFAULT_LIMITS, loadJson } from '../services/config.js';
import { Limits } from '../types/index.js';
import fs from 'fs';
import path from 'path';
import { loadPointsConfig as loadPointsCfg, creatorUserIds } from './wallet.js';
import { TTS_RECORDS_FILE, loadTtsRecords, saveTtsRecords, deleteRecordAudio } from './tts.js';

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
          { role: 'user', content: systemPrompt + '\n\n' + userPrompt },
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
  res.json({ banned: bans.filter((b: any) => b.banned_until > now).map((b: any) => ({ user_id: b.user_id, reason: b.reason, banned_at: b.banned_at, banned_until: b.banned_until, remaining_days: Math.max(1, Math.ceil((b.banned_until - now) / 86400)) })) });
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
  res.json({ ok: true, banned: bans.filter((b: any) => b.user_id === user_id).map((b: any) => ({ user_id: b.user_id, reason: b.reason, banned_at: b.banned_at, banned_until: b.banned_until, remaining_days: days })) });
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
  if (!paths.includes(imagePath)) paths.unshift(imagePath);
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
  res.json({ ok: true, announcement: data });
});

// GET /api/draw/admin/recent
router.get('/recent', requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit as string) || 200;
  const offset = parseInt(req.query.offset as string) || 0;
  // Load creator_map
  const cmap: Record<string, string> = {};
  try { for (const ln of fs.readFileSync(config.creator_map_file, 'utf-8').split('\n')) { const p = ln.split('\t'); if (p.length === 2) cmap[p[0].trim()] = p[1].trim(); } } catch {}
  // Load deleted images list
    const deletedFile = path.join(path.dirname(config.creator_map_file), 'deleted_images.json');
    let deletedList: string[] = [];
    try { deletedList = JSON.parse(fs.readFileSync(deletedFile, 'utf-8')); } catch {}
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
        items.push({ path: f, mtime: s.mtimeMs / 1000, size: s.size, creator_id: uid, user_id: uid, deleted: deletedList.includes(f), prompt: String(m.prompt || ''), nl_prompt: String(m.nl_prompt || ''), negative_prompt: String(m.negative_prompt || ''), rewrite: Boolean(m.rewrite), image1: String(m.image1 || ''), image2: String(m.image2 || '') });
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
  try { for (const ln of fs.readFileSync(config.creator_map_file, 'utf-8').split('\n')) { const p = ln.split('	'); if (p.length === 2) cmap[p[0].trim()] = parseInt(p[1].trim()); } } catch {}
  let items: any[] = Object.entries(cmap).filter(([, v]) => v === uid).map(([k]) => ({ path: k }));
  // sort by file mtime descending (newest first)
  if (fs.existsSync(config.output_dir)) {
    for (const item of items) {
      try {
        const s = fs.statSync(path.join(config.output_dir, item.path));
        item.mtime = s.mtimeMs / 1000;
      } catch {}
    }
    items.sort((a: any, b: any) => (b.mtime || 0) - (a.mtime || 0));
  }
  res.json({ items, total: items.length });
});

// DELETE /api/draw/admin/delete
router.delete('/delete', requireAdmin, (req, res) => {
  const { path: imagePath } = req.body || {};
  if (!imagePath) return res.status(400).json({ error: 'need path' });
  let deleted = 0, failed = 0;
  const safe = path.basename(imagePath.replace(/\\/g, '/'));
  const dirs = [config.output_dir, config.archive_dir];
  for (const dir of dirs) {
    const fp = path.resolve(dir, safe);
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
    const safe = path.basename(String(p).replace(/\\/g, '/'));
    for (const dir of [config.output_dir, config.archive_dir]) {
      const fp = path.resolve(dir, safe);
      if (fp.startsWith(path.resolve(dir)) && fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); deleted++; } catch { failed++; }
      }
    }
  }
  res.json({ ok: true, deleted, failed });
});

const GC_OUTPUT_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

function gcScanDeletedImages(outputDir: string, archiveDir: string): { deletedFile: string; list: string[]; onDisk: string[] } {
  const deletedFile = path.join(path.dirname(config.creator_map_file), 'deleted_images.json');
  const list: string[] = loadJson<string[]>(deletedFile, []);
  const onDisk: string[] = [];
  const dirs = [outputDir].concat(fs.existsSync(archiveDir) ? [archiveDir] : []);
  for (const f of list) {
    for (const dir of dirs) {
      const fp = path.resolve(dir, f);
      if (fp.startsWith(path.resolve(dir)) && fs.existsSync(fp)) { onDisk.push(f); break; }
    }
  }
  return { deletedFile, list, onDisk };
}

function gcLoadCreatorMap(): Record<string, number> {
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

function gcLoadFeaturedList(): string[] {
  const featuredFile = config.creator_map_file.replace('creator_users.txt', 'featured.txt');
  try {
    const raw = fs.readFileSync(featuredFile, 'utf-8').trim();
    return raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').map(l => l.trim()).filter(Boolean);
  } catch { return []; }
}

function gcLoadPromptMeta(): Record<string, any> {
  const f = path.join(path.dirname(config.creator_map_file), 'prompt_meta.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return {}; }
}

function gcOutputFiles(outputDir: string): string[] {
  try {
    return fs.readdirSync(outputDir).filter(f => {
      if (fs.statSync(path.join(outputDir, f)).isDirectory()) return false;
      return GC_OUTPUT_EXTS.includes(path.extname(f).toLowerCase());
    });
  } catch { return []; }
}

const WEB_DIR = path.dirname(config.creator_map_file);
const UPLOADS_DIR = path.join(WEB_DIR, 'uploads');
const QUEUE_STATE_FILE = path.join(WEB_DIR, 'queue_state.json');
const UPLOADS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const QUEUE_TRIM_AGE_MS = 24 * 60 * 60 * 1000;
const GC_WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

export async function runGc(): Promise<Record<string, number>> {
  const outputDir = config.output_dir;
  const archiveDir = config.archive_dir;
  const dirs = [outputDir].concat(fs.existsSync(archiveDir) ? [archiveDir] : []);
  const cleaned: Record<string, number> = {};

  // 1. Delete user-deleted image files from disk
  const deletedInfo = gcScanDeletedImages(outputDir, archiveDir);
  let deletedFileCount = 0;
  for (const f of deletedInfo.onDisk) {
    for (const dir of dirs) {
      const fp = path.resolve(dir, f);
      if (fp.startsWith(path.resolve(dir)) && fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); deletedFileCount++; } catch {}
      }
    }
  }
  fs.writeFileSync(deletedInfo.deletedFile, '[]', 'utf-8');
  cleaned.deleted_image_files = deletedFileCount;

  // 2. Remove orphaned creator_map entries (keep if in archive or featured)
  const cmap = gcLoadCreatorMap();
  const gcFeaturedSet = new Set(gcLoadFeaturedList());
  const validLines: string[] = [];
  const searchDirs = [outputDir];
  if (fs.existsSync(archiveDir)) searchDirs.push(archiveDir);
  for (const [f, uid] of Object.entries(cmap)) {
    let found = false;
    for (const dir of searchDirs) {
      if (fs.existsSync(path.join(dir, f))) { found = true; break; }
    }
    if (found || gcFeaturedSet.has(f)) validLines.push(`${f}\t${uid}`);
  }
  cleaned.orphaned_mappings = Object.keys(cmap).length - validLines.length;
  if (validLines.length > 0) {
    fs.writeFileSync(config.creator_map_file, validLines.join('\n') + '\n', 'utf-8');
  } else {
    fs.writeFileSync(config.creator_map_file, '', 'utf-8');
  }

  // 3. Remove matching prompt_meta entries
  const pmFile = path.join(WEB_DIR, 'prompt_meta.json');
  const pm = gcLoadPromptMeta();
  let pmRemoved = 0;
  for (const key of Object.keys(pm)) {
    if (!fs.existsSync(path.join(outputDir, key))) { delete pm[key]; pmRemoved++; }
  }
  fs.writeFileSync(pmFile, JSON.stringify(pm, null, 2), 'utf-8');
  cleaned.prompt_meta_removed = pmRemoved;

  // 4. Remove stale featured entries
  const featuredFile = path.join(WEB_DIR, 'featured.txt');
  const featured = gcLoadFeaturedList();
  const validFeatured = featured.filter(f => fs.existsSync(path.join(outputDir, f)));
  cleaned.featured_removed = featured.length - validFeatured.length;
  fs.writeFileSync(featuredFile, JSON.stringify(validFeatured, null, 2), 'utf-8');

  // 5. Delete unclaimed files
  const cmapAfter = gcLoadCreatorMap();
  const featuredAfter = gcLoadFeaturedList();
  const allFiles = gcOutputFiles(outputDir);
  const toDelete = allFiles.filter(f => !cmapAfter[f] && !featuredAfter.includes(f));
  let unclaimedDeleted = 0;
  for (const f of toDelete) {
    try { fs.unlinkSync(path.join(outputDir, f)); unclaimedDeleted++; } catch {}
  }
  cleaned.unclaimed_output_files = unclaimedDeleted;

  // 6. Clean old uploads (img2img input files)
  let uploadsDeleted = 0;
  if (fs.existsSync(UPLOADS_DIR)) {
    const now = Date.now();
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const fp = path.join(UPLOADS_DIR, f);
      try {
        if (fs.statSync(fp).isFile() && now - fs.statSync(fp).mtimeMs > UPLOADS_MAX_AGE_MS) {
          fs.unlinkSync(fp); uploadsDeleted++;
        }
      } catch {}
    }
  }
  cleaned.uploads_cleaned = uploadsDeleted;

  // 7. Trim old queue state entries
  let queueTrimmed = 0;
  if (fs.existsSync(QUEUE_STATE_FILE)) {
    try {
      const q = JSON.parse(fs.readFileSync(QUEUE_STATE_FILE, 'utf-8'));
      const items = q.items || [];
      const cutoff = Date.now() / 1000 - QUEUE_TRIM_AGE_MS / 1000;
      const kept = items.filter((i: any) => {
        const t = i.finished_at || i.created_at || 0;
        return t > cutoff || (i.status !== 'done' && i.status !== 'failed');
      });
      queueTrimmed = items.length - kept.length;
      q.items = kept;
      fs.writeFileSync(QUEUE_STATE_FILE, JSON.stringify(q, null, 2), 'utf-8');
    } catch {}
  }
  cleaned.queue_trimmed = queueTrimmed;

  return cleaned;
}

// GET /api/draw/admin/gc — dry-run report
router.get('/gc', requireAdmin, (req, res) => {
  const outputDir = config.output_dir;
  const archiveDir = config.archive_dir;
  const cmap = gcLoadCreatorMap();
  const featured = gcLoadFeaturedList();

  const deletedInfo = gcScanDeletedImages(outputDir, archiveDir);
  const allFiles = gcOutputFiles(outputDir);

  const orphanedMappingCount = Object.keys(cmap).filter(f => !fs.existsSync(path.join(outputDir, f))).length;
  const orphanedFiles = allFiles.filter(f => !cmap[f] && !featured.includes(f));

  let uploadsCount = 0;
  if (fs.existsSync(UPLOADS_DIR)) {
    const now = Date.now();
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const fp = path.join(UPLOADS_DIR, f);
      try { if (fs.statSync(fp).isFile() && now - fs.statSync(fp).mtimeMs > UPLOADS_MAX_AGE_MS) uploadsCount++; } catch {}
    }
  }

  let queueTrimmable = 0;
  if (fs.existsSync(QUEUE_STATE_FILE)) {
    try {
      const q = JSON.parse(fs.readFileSync(QUEUE_STATE_FILE, 'utf-8'));
      const cutoff = Date.now() / 1000 - QUEUE_TRIM_AGE_MS / 1000;
      queueTrimmable = (q.items || []).filter((i: any) => (i.status === 'done' || i.status === 'failed') && (i.finished_at || i.created_at || 0) <= cutoff).length;
    } catch {}
  }

  res.json({
    dry_run: true,
    to_clean: {
      deleted_image_files: deletedInfo.onDisk.length,
      orphaned_mappings: orphanedMappingCount,
      unclaimed_output_files: orphanedFiles.length,
      uploads_stale: uploadsCount,
      queue_old_entries: queueTrimmable,
    }
  });
});

// POST /api/draw/admin/gc — execute cleanup
router.post('/gc', requireAdmin, async (req, res) => {
  const cleaned = await runGc();
  res.json({ cleaned });
});

export function startAutoGc(): void {
  const schedule = () => {
    const limits = loadLimits(config.limits_file);
    const intervalMs = (limits.gc_interval_hours || 168) * 3600000;
    setTimeout(() => {
      runGc().then(r => console.log(`[GC] 自动清理完成: ${JSON.stringify(r)}`)).catch(e => console.error(`[GC] 自动清理失败: ${e}`));
      schedule();
    }, intervalMs).unref();
  };
  schedule();
  console.log(`[GC] 自动清理已启动（可在配置页修改间隔）`);
}

// GET /api/draw/admin/recommendations
router.get('/recommendations', requireAdmin, (req, res) => {
  const f = config.creator_map_file.replace('creator_users.txt', 'recommendations.json');
  try {
    const items = JSON.parse(fs.readFileSync(f, 'utf-8'));
    let changed = false;
    for (const item of items) {
      if (!item.id) {
        item.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(f, JSON.stringify(items, null, 2), 'utf-8');
    const d = items.filter((i: any) => i.status === 'pending');
    res.json({ items: d, total: d.length });
  } catch { res.json({ items: [], total: 0 }); }
});

// POST /api/draw/admin/recommendations/resolve
router.post('/recommendations/resolve', requireAdmin, (req, res) => {
  const f = config.creator_map_file.replace('creator_users.txt', 'recommendations.json');
  try {
    const items = JSON.parse(fs.readFileSync(f, 'utf-8'));
    let idx = -1;
    if (req.body?.rec_id) {
      idx = items.findIndex((i: any) => i.id === req.body.rec_id);
    }
    if (idx < 0 && req.body?.image_path) {
      idx = items.findIndex((i: any) => i.status === 'pending' && i.image_path === req.body.image_path);
    }
    if (idx >= 0) {
      items[idx].status = req.body?.action === 'approve' ? 'approved' : 'rejected';
      items[idx].admin_reason = req.body?.reason || '';
      items[idx].resolved_at = Date.now() / 1000;
      if (!items[idx].id) {
        items[idx].id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      }
      fs.writeFileSync(f, JSON.stringify(items, null, 2), 'utf-8');
      // 通过自荐 → 自动加入精选
      if (req.body?.action === 'approve' && items[idx].image_path) {
        const featuredFile = config.creator_map_file.replace('creator_users.txt', 'featured.txt');
        const featured = loadJson<string[]>(featuredFile, []);
        if (!featured.includes(items[idx].image_path)) {
          featured.unshift(items[idx].image_path);
          saveJson(featuredFile, featured);
        }
      }
    }
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// POST /api/draw/admin/recommendations/resolve-batch
router.post('/recommendations/resolve-batch', requireAdmin, (req, res) => {
  const { rec_ids, action, reason } = req.body || {};
  if (!Array.isArray(rec_ids) || rec_ids.length === 0) return res.status(400).json({ error: 'need rec_ids' });
  if (action !== 'approve' && action !== 'reject') return res.status(400).json({ error: 'action must be approve or reject' });
  const f = config.creator_map_file.replace('creator_users.txt', 'recommendations.json');
  try {
    const items = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const featuredFile = config.creator_map_file.replace('creator_users.txt', 'featured.txt');
    const featured: string[] = loadJson<string[]>(featuredFile, []);
    let changed = false;
    for (const id of rec_ids) {
      const idx = items.findIndex((i: any) => i.id === id);
      if (idx >= 0 && items[idx].status === 'pending') {
        items[idx].status = action === 'approve' ? 'approved' : 'rejected';
        items[idx].admin_reason = reason || '';
        items[idx].resolved_at = Date.now() / 1000;
        if (!items[idx].id) items[idx].id = id;
        if (action === 'approve' && items[idx].image_path && !featured.includes(items[idx].image_path)) {
          featured.unshift(items[idx].image_path);
        }
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(f, JSON.stringify(items, null, 2), 'utf-8');
      saveJson(featuredFile, featured);
    }
    res.json({ ok: true, resolved: rec_ids.length });
  } catch { res.json({ ok: true, resolved: 0 }); }
});

// POST /api/draw/admin/workflow_rename (stub, kept for compatibility)
router.post('/workflow_rename', requireAdmin, (req, res) => { res.json({ ok: true }); });

// GET|POST /api/draw/admin/points-config
router.get('/points-config', requireAdmin, (req, res) => {
  res.json(loadPointsCfg());
});

router.post('/points-config', requireAdmin, (req, res) => {
  const { text_to_image, image_to_image, llm_translate, llm_token_per_point, signup_bonus, text_to_image_anima, text_to_image_real, text_to_image_ernie, image_to_image_qwen, text_to_video, tts_generate, tts_per_char, tts_per_sec } = req.body || {};
  const cfg: any = {};
  if (typeof text_to_image === 'number') cfg.text_to_image = text_to_image;
  if (typeof image_to_image === 'number') cfg.image_to_image = image_to_image;
  if (typeof llm_translate === 'number') cfg.llm_translate = llm_translate;
  if (typeof llm_token_per_point === 'number') cfg.llm_token_per_point = llm_token_per_point;
  if (typeof signup_bonus === 'number') cfg.signup_bonus = signup_bonus;
  if (typeof text_to_image_anima === 'number') cfg.text_to_image_anima = text_to_image_anima;
  if (typeof text_to_image_real === 'number') cfg.text_to_image_real = text_to_image_real;
  if (typeof text_to_image_ernie === 'number') cfg.text_to_image_ernie = text_to_image_ernie;
  if (typeof image_to_image_qwen === 'number') cfg.image_to_image_qwen = image_to_image_qwen;
  if (typeof text_to_image_real === 'number') cfg.text_to_image_real = text_to_image_real;
  if (typeof text_to_video === 'number') cfg.text_to_video = text_to_video;
  if (typeof tts_generate === 'number') cfg.tts_generate = tts_generate;
  if (typeof tts_per_char === 'number') cfg.tts_per_char = tts_per_char;
  if (typeof tts_per_sec === 'number') cfg.tts_per_sec = tts_per_sec;
  if (Object.keys(cfg).length === 0) return res.status(400).json({ error: 'no valid fields' });
  const pf = path.join(path.dirname(config.creator_map_file), 'points_config.json');
  const current = loadJson<Record<string, any>>(pf, {});
  Object.assign(current, cfg);
  saveJson(pf, current);
  res.json({ ok: true, config: current });
});

// GET /api/draw/admin/wallets
router.get('/wallets', requireAdmin, (req, res) => {
  const wf = path.join(path.dirname(config.creator_map_file), 'wallets.json');
  const wallets = loadJson<Record<string, { balance: number; total_purchased: number }>>(wf, {});
  const seen = new Set(Object.keys(wallets));
  let changed = false;
  for (const uid of creatorUserIds()) {
    const key = String(uid);
    if (!seen.has(key)) {
      wallets[key] = { balance: 0, total_purchased: 0 };
      seen.add(key);
      changed = true;
    }
  }
  if (changed) saveJson(wf, wallets);
  const items = Object.entries(wallets).map(([uid, w]) => ({ user_id: Number(uid), ...w }));
  res.json({ items });
});

// POST /api/draw/admin/wallets/set
router.post('/wallets/set', requireAdmin, (req, res) => {
  const { user_id, balance, total_purchased } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'need user_id' });
  const wf = path.join(path.dirname(config.creator_map_file), 'wallets.json');
  const wallets = loadJson<Record<string, any>>(wf, {});
  const key = String(user_id);
  if (!wallets[key]) wallets[key] = { balance: 0, total_purchased: 0 };
  if (typeof balance === 'number') wallets[key].balance = balance;
  if (typeof total_purchased === 'number') wallets[key].total_purchased = total_purchased;
  saveJson(wf, wallets);
  res.json({ ok: true, wallet: wallets[key] });
});

// POST /api/draw/admin/wallets/give
router.post('/wallets/give', requireAdmin, (req, res) => {
  const { user_id, points } = req.body || {};
  const pts = parseInt(points) || 0;
  if (pts <= 0) return res.status(400).json({ error: 'need points > 0' });
  const wf = path.join(path.dirname(config.creator_map_file), 'wallets.json');
  const wallets = loadJson<Record<string, any>>(wf, {});
  let count = 0;
  if (user_id) {
    const key = String(user_id);
    if (!wallets[key]) wallets[key] = { balance: 0, total_purchased: 0 };
    wallets[key].balance = (wallets[key].balance || 0) + pts;
    wallets[key].total_purchased = (wallets[key].total_purchased || 0) + pts;
    count = 1;
  } else {
    // 全部用户
    for (const key of Object.keys(wallets)) {
      wallets[key].balance = (wallets[key].balance || 0) + pts;
      wallets[key].total_purchased = (wallets[key].total_purchased || 0) + pts;
      count++;
    }
  }
  saveJson(wf, wallets);
  res.json({ ok: true, count });
});

// GET /api/draw/admin/plans
router.get('/plans', requireAdmin, (req, res) => {
  const pf = path.join(path.dirname(config.creator_map_file), 'plans.json');
  const plans = loadJson<any[]>(pf, []);
  res.json({ items: plans });
});

// POST /api/draw/admin/plans
router.post('/plans', requireAdmin, (req, res) => {
  const { id, name, points, url } = req.body || {};
  if (!id) return res.status(400).json({ error: 'need id' });
  const pf = path.join(path.dirname(config.creator_map_file), 'plans.json');
  const plans = loadJson<any[]>(pf, []);
  const idx = plans.findIndex((p: any) => p.id === id);
  const entry = { id, name: name || '', points: points || 0, url: url || '' };
  if (idx >= 0) plans[idx] = entry;
  else plans.push(entry);
  saveJson(pf, plans);
  res.json({ ok: true, plans });
});

// DELETE /api/draw/admin/plans/:id
router.delete('/plans/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const pf = path.join(path.dirname(config.creator_map_file), 'plans.json');
  const plans = loadJson<any[]>(pf, []);
  const idx = plans.findIndex((p: any) => p.id === id);
  if (idx >= 0) plans.splice(idx, 1);
  saveJson(pf, plans);
  res.json({ ok: true, plans });
});

// GET /api/draw/admin/tts-records
router.get('/tts-records', requireAdmin, (req, res) => {
  try {
    const records = loadJson<Array<Record<string, any>>>(TTS_RECORDS_FILE, []);
    res.json({ items: records });
  } catch {
    res.json({ items: [] });
  }
});

// GET /api/draw/admin/tts-download/:id
router.get('/tts-download/:id', (req, res) => {
  const id = parseInt(String(req.params.id));
  const records = loadTtsRecords();
  const rec = records.find(r => r.id === id);
  if (!rec || !rec.outputPath || !fs.existsSync(rec.outputPath)) return res.status(404).json({ error: 'audio not found' });
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Disposition', `attachment; filename="tts_${id}.wav"`);
  fs.createReadStream(rec.outputPath).pipe(res);
});

// DELETE /api/draw/admin/tts-record/:id
router.delete('/tts-record/:id', requireAdmin, (req, res) => {
  const id = parseInt(String(req.params.id));
  const records = loadTtsRecords();
  const idx = records.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'record not found' });
  records.splice(idx, 1);
  saveTtsRecords(records);
  deleteRecordAudio(id);
  res.json({ ok: true });
});

// GET /api/draw/admin/stats — 多维统计
router.get('/stats', requireAdmin, (req: Request, res: Response) => {
  const now = Date.now() / 1000;
  const daySec = 86400;
  const ranges = [
    { key: 'today', start: now - daySec },
    { key: '7d', start: now - 7 * daySec },
    { key: '30d', start: now - 30 * daySec },
  ];

  // 模型映射表
  const MODEL_MAP: { prefix: string; cfgKey: string; label: string }[] = [
    { prefix: 'WAI/',     cfgKey: 'text_to_image',       label: 'WAI' },
    { prefix: 'ANIMA/',   cfgKey: 'text_to_image_anima',  label: 'Anima' },
    { prefix: 'Ernie/',   cfgKey: 'text_to_image_ernie',  label: 'Ernie' },
    { prefix: 'ZImage/',  cfgKey: 'text_to_image_real',   label: 'RedZI' },
    { prefix: 'Flux/',    cfgKey: 'image_to_image',       label: 'Flux2' },
    { prefix: 'Qwen/',    cfgKey: 'image_to_image_qwen',  label: 'Qwen' },
    { prefix: 'WAN2.2/',  cfgKey: 'text_to_video',        label: '视频' },
    { prefix: 'LTX/',     cfgKey: 'text_to_video',        label: '视频' },
    { prefix: 'TTS/',     cfgKey: 'tts_generate',         label: 'TTS' },
  ];

  function getModelInfo(wfPath: string): { label: string; cost: number } {
    const cfg = loadPointsCfg();
    for (const m of MODEL_MAP) {
      if (wfPath.startsWith(m.prefix)) {
        return { label: m.label, cost: (cfg as any)[m.cfgKey] || 20 };
      }
    }
    return { label: 'WAI', cost: cfg.text_to_image || 10 };
  }

  // 从 prompt_meta 统计（持久化，清队列也不丢失）
  const pm: Record<string, any> = loadJson(path.join(WEB_DIR, 'prompt_meta.json'), {});
  const stats: Record<string, any> = {};
  for (const range of ranges) {
    const byModel: Record<string, { calls: number; failed: number; cost: number }> = {};
    let totalCalls = 0, totalCost = 0;

    for (const [name, meta] of Object.entries(pm)) {
      if (name.startsWith('_') || !meta.created_at) continue;
      const ts = meta.created_at;
      if (ts < range.start) continue;
      const wf = (meta.workflow_path || '') as string;
      const info = getModelInfo(wf);
      totalCalls++;
      totalCost += info.cost;
      if (!byModel[info.label]) byModel[info.label] = { calls: 0, failed: 0, cost: 0 };
      byModel[info.label].calls++;
      byModel[info.label].cost += info.cost;
    }

    // 失败统计（仅队列中有记录）
    const queueData = loadJson<Array<Record<string, any>>>(path.join(WEB_DIR, 'queue_state.json'), { items: [] });
    const queueItems = (queueData as any).items || queueData;
    let totalFailed = 0;
    for (const item of queueItems) {
      if (item.status === 'failed' && item.created_at >= range.start) totalFailed++;
    }

    stats[range.key] = { calls: totalCalls, cost: totalCost, failed: totalFailed, byModel };
  }

  // 收入（已支付订单）
  const orders = loadJson<Array<Record<string, any>>>(path.join(WEB_DIR, 'orders.json'), []);
  const income: Record<string, number> = {};
  for (const range of ranges) {
    income[range.key] = orders
      .filter((o: any) => o.status === 'paid' && o.paid_at >= range.start)
      .reduce((sum: number, o: any) => sum + (o.amount || 0), 0);
  }

  res.json({ stats, income });
});

// GET /api/draw/admin/storage — 用户存储用量统计
router.get('/storage', requireAdmin, (req: Request, res: Response) => {
  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
  const VIDEO_EXTS = new Set(['.mp4', '.webm']);
  const AUDIO_EXTS = new Set(['.wav', '.flac']);
  // 加载 creator_map
  const cmap: Record<string, number> = {};
  try {
    if (fs.existsSync(config.creator_map_file)) {
      for (const ln of fs.readFileSync(config.creator_map_file, 'utf-8').split('\n')) {
        const parts = ln.trim().split('\t');
        if (parts.length === 2 && /^\d+$/.test(parts[1])) cmap[parts[0]] = parseInt(parts[1]);
      }
    }
  } catch {}

  // 按图片/视频/音频分别累计
  const usage: Record<number, { img_files: number; img_size: number; vid_files: number; vid_size: number; aud_files: number; aud_size: number }> = {};
  for (const [relPath, uid] of Object.entries(cmap)) {
    const ext = path.extname(relPath).toLowerCase();
    const isImage = IMAGE_EXTS.has(ext);
    const isVideo = VIDEO_EXTS.has(ext);
    const isAudio = AUDIO_EXTS.has(ext);
    if (!isImage && !isVideo && !isAudio) continue;
    const fp = path.resolve(config.output_dir, relPath);
    if (!fp.startsWith(path.resolve(config.output_dir))) continue;
    try {
      const stat = fs.statSync(fp);
      if (!stat.isFile()) continue;
      if (!usage[uid]) usage[uid] = { img_files: 0, img_size: 0, vid_files: 0, vid_size: 0, aud_files: 0, aud_size: 0 };
      if (isImage) { usage[uid].img_files++; usage[uid].img_size += stat.size; }
      else if (isVideo) { usage[uid].vid_files++; usage[uid].vid_size += stat.size; }
      else { usage[uid].aud_files++; usage[uid].aud_size += stat.size; }
    } catch {}
  }

  // 排序（按总大小降序）
  const items = Object.entries(usage)
    .map(([uid, data]) => ({
      user_id: parseInt(uid),
      img_files: data.img_files, img_size: data.img_size,
      vid_files: data.vid_files, vid_size: data.vid_size,
      aud_files: data.aud_files, aud_size: data.aud_size,
    }))
    .sort((a, b) => (b.img_size + b.vid_size + b.aud_size) - (a.img_size + a.vid_size + a.aud_size));

  const totalSize = items.reduce((s, i) => s + i.img_size + i.vid_size + i.aud_size, 0);
  res.json({ items, total_size: totalSize });
});

export { router as adminRouter };
