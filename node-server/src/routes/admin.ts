import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { loadConfig, loadLimits, saveJson, DEFAULT_LIMITS, loadJson } from '../services/config.js';
import { Limits, LlmConfig } from '../types/index.js';

const router = Router();
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
    const { translatePrompt } = await import('../services/llm.js');
    const result = await translatePrompt('say hello in one word', undefined, undefined, config);
    res.json({ ok: true, reply: result.positive.slice(0, 500) });
  } catch (e: any) {
    res.json({ ok: false, error: (e.message || String(e)).slice(0, 500) });
  }
});

// GET /api/draw/admin/banned
router.get('/banned', requireAdmin, (req: Request, res: Response) => {
  const bannedFile = config.creator_map_file.replace('creator_users.txt', 'banned_users.txt');
  const banned = loadJson<number[]>(bannedFile, []);
  res.json({ users: banned });
});

// POST /api/draw/admin/banned
router.post('/banned', requireAdmin, (req: Request, res: Response) => {
  const { user_id } = req.body as { user_id?: number };
  if (!user_id) return res.status(400).json({ error: 'need user_id' });
  const bannedFile = config.creator_map_file.replace('creator_users.txt', 'banned_users.txt');
  const banned = loadJson<number[]>(bannedFile, []);
  if (!banned.includes(user_id)) banned.push(user_id);
  saveJson(bannedFile, banned);
  res.json({ ok: true });
});

// DELETE /api/draw/admin/banned
router.delete('/banned', requireAdmin, (req: Request, res: Response) => {
  const { user_id } = req.body as { user_id?: number };
  if (!user_id) return res.status(400).json({ error: 'need user_id' });
  const bannedFile = config.creator_map_file.replace('creator_users.txt', 'banned_users.txt');
  const banned = loadJson<number[]>(bannedFile, []);
  saveJson(bannedFile, banned.filter((id: number) => id !== user_id));
  res.json({ ok: true });
});

// GET /api/draw/admin/featured
router.get('/featured', requireAdmin, (req: Request, res: Response) => {
  const featuredFile = config.creator_map_file.replace('creator_users.txt', 'featured.txt');
  const paths = loadJson<string[]>(featuredFile, []);
  res.json({ paths });
});

// POST /api/draw/admin/featured
router.post('/featured', requireAdmin, (req: Request, res: Response) => {
  const { path: imagePath, remove } = req.body as { path?: string; remove?: boolean };
  if (!imagePath) return res.status(400).json({ error: 'need path' });
  const featuredFile = config.creator_map_file.replace('creator_users.txt', 'featured.txt');
  const paths = loadJson<string[]>(featuredFile, []);
  if (remove) {
    const idx = paths.indexOf(imagePath);
    if (idx >= 0) paths.splice(idx, 1);
  } else {
    if (!paths.includes(imagePath)) paths.push(imagePath);
  }
  saveJson(featuredFile, paths);
  res.json({ ok: true });
});

export { router as adminRouter };
