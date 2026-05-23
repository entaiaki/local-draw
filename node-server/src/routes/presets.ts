import express, { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { loadConfig } from '../services/config.js';

const router = Router();
router.use(express.json());

const config = loadConfig();
const HERE = path.dirname(config.creator_map_file);

function presetsFile() { return path.join(HERE, 'presets.json'); }

function loadPresets(): Record<string, any[]> {
  try { return JSON.parse(fs.readFileSync(presetsFile(), 'utf-8')); } catch { return {}; }
}

function savePresets(data: Record<string, any[]>) {
  fs.writeFileSync(presetsFile(), JSON.stringify(data, null, 2), 'utf-8');
}

function uid(req: Request): string {
  return String((req as any).user?.id || '');
}

// GET /api/presets
router.get('/presets', (req: Request, res: Response) => {
  const user = uid(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const all = loadPresets();
  res.json(all[user] || []);
});

// POST /api/presets
router.post('/presets', (req: Request, res: Response) => {
  const user = uid(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const { name, content, type } = req.body || {};
  if (!name?.trim() || !content?.trim()) return res.status(400).json({ error: 'name and content required' });
  if (!['positive', 'negative'].includes(type)) return res.status(400).json({ error: 'type must be positive or negative' });
  if (content.length > 2000) return res.status(400).json({ error: 'content too long (max 2000)' });
  const all = loadPresets();
  if (!all[user]) all[user] = [];
  if (all[user].length >= 500) return res.status(400).json({ error: 'preset limit reached (max 500)' });
  const preset = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name.trim(), content: content.trim(), type };
  all[user].push(preset);
  savePresets(all);
  res.json(preset);
});

// PUT /api/presets/:id
router.put('/presets/:id', (req: Request, res: Response) => {
  const user = uid(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const { name, content, type } = req.body || {};
  const all = loadPresets();
  if (!all[user]) return res.status(404).json({ error: 'not found' });
  const idx = all[user].findIndex((p: any) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  if (name?.trim()) all[user][idx].name = name.trim();
  if (content?.trim()) {
    if (content.length > 2000) return res.status(400).json({ error: 'content too long (max 2000)' });
    all[user][idx].content = content.trim();
  }
  if (type && ['positive', 'negative'].includes(type)) all[user][idx].type = type;
  savePresets(all);
  res.json(all[user][idx]);
});

// DELETE /api/presets/:id
router.delete('/presets/:id', (req: Request, res: Response) => {
  const user = uid(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const all = loadPresets();
  if (!all[user]) return res.status(404).json({ error: 'not found' });
  all[user] = all[user].filter((p: any) => p.id !== req.params.id);
  savePresets(all);
  res.json({ ok: true });
});

export { router as presetRouter };
