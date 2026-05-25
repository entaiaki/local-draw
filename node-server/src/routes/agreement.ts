import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { loadJson, saveJson } from '../services/config.js';
import path from 'path';
import fs from 'fs';

const AGREEMENTS_FILE = path.join(process.cwd(), '..', '..', 'web', 'agreements.json');

function loadAgreements(): Record<string, number> {
  try {
    if (fs.existsSync(AGREEMENTS_FILE)) {
      return JSON.parse(fs.readFileSync(AGREEMENTS_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveAgreements(data: Record<string, number>): void {
  try {
    fs.mkdirSync(path.dirname(AGREEMENTS_FILE), { recursive: true });
    fs.writeFileSync(AGREEMENTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch {}
}

export const agreementRouter = Router();

// GET /api/draw/agreement — 检查当前用户是否已同意
agreementRouter.get('/agreement', requireAuth, (req: Request, res: Response) => {
  const uid = String(req.user?.id || '');
  const data = loadAgreements();
  res.json({ agreed: !!data[uid], agreed_at: data[uid] || null });
});

// POST /api/draw/agreement — 记录用户同意
agreementRouter.post('/agreement', requireAuth, (req: Request, res: Response) => {
  const uid = String(req.user?.id || '');
  const data = loadAgreements();
  data[uid] = Math.floor(Date.now() / 1000);
  saveAgreements(data);
  res.json({ ok: true, agreed_at: data[uid] });
});
