import express, { Router, Request, Response } from 'express';
import { requireAdmin, requireCollaborator } from '../middleware/auth.js';
import { loadConfig, loadJson, saveJson } from '../services/config.js';
import fs from 'fs';
import path from 'path';

const config = loadConfig();

function collaboratorsFile(): string {
  return path.join(path.dirname(config.creator_map_file), 'collaborators.json');
}

function nominationsFile(): string {
  return path.join(path.dirname(config.creator_map_file), 'nominations.json');
}

function loadCollaborators(): any[] {
  try {
    if (fs.existsSync(collaboratorsFile())) return JSON.parse(fs.readFileSync(collaboratorsFile(), 'utf-8'));
  } catch {}
  return [];
}

function saveCollaborators(list: any[]): void {
  fs.writeFileSync(collaboratorsFile(), JSON.stringify(list, null, 2), 'utf-8');
}

function loadNominations(): any[] {
  try {
    if (fs.existsSync(nominationsFile())) return JSON.parse(fs.readFileSync(nominationsFile(), 'utf-8'));
  } catch {}
  return [];
}

function saveNominations(list: any[]): void {
  fs.writeFileSync(nominationsFile(), JSON.stringify(list, null, 2), 'utf-8');
}

// ===== Admin endpoints (requireAdmin) =====
export const adminCollaboratorRouter = Router();
adminCollaboratorRouter.use(express.json({ limit: '50mb' }));

// GET /api/draw/admin/collaborators
adminCollaboratorRouter.get('/collaborators', requireAdmin, (_req: Request, res: Response) => {
  res.json({ collaborators: loadCollaborators() });
});

// POST /api/draw/admin/collaborators/add
adminCollaboratorRouter.post('/collaborators/add', requireAdmin, (req: Request, res: Response) => {
  const { user_id } = req.body as { user_id?: number };
  if (!user_id) return res.status(400).json({ error: 'need user_id' });
  const list = loadCollaborators();
  if (!list.some((c: any) => c.user_id === user_id)) {
    list.push({ user_id, added_by: (req as any).user?.id || 0, added_at: Math.floor(Date.now() / 1000) });
    saveCollaborators(list);
  }
  res.json({ ok: true, collaborators: list });
});

// POST /api/draw/admin/collaborators/remove
adminCollaboratorRouter.post('/collaborators/remove', requireAdmin, (req: Request, res: Response) => {
  const { user_id } = req.body as { user_id?: number };
  if (!user_id) return res.status(400).json({ error: 'need user_id' });
  let list = loadCollaborators();
  list = list.filter((c: any) => c.user_id !== user_id);
  saveCollaborators(list);
  res.json({ ok: true, collaborators: list });
});

// GET /api/draw/admin/nominations
adminCollaboratorRouter.get('/nominations', requireAdmin, (_req: Request, res: Response) => {
  const items = loadNominations().filter((n: any) => n.status === 'pending');
  res.json({ items, total: items.length });
});

// POST /api/draw/admin/nominations/resolve
adminCollaboratorRouter.post('/nominations/resolve', requireAdmin, (req: Request, res: Response) => {
  const { id, action, reason } = req.body as { id?: string; action?: string; reason?: string };
  if (!id || !action) return res.status(400).json({ error: 'need id and action' });
  const nominations = loadNominations();
  const idx = nominations.findIndex((n: any) => n.id === id);
  if (idx >= 0) {
    nominations[idx].status = action === 'approve' ? 'approved' : 'rejected';
    nominations[idx].reviewed_by = (req as any).user?.id || null;
    nominations[idx].reviewed_at = Math.floor(Date.now() / 1000);
    nominations[idx].admin_reason = reason || '';
    // If approved, add to featured
    if (action === 'approve') {
      const featuredFile = config.creator_map_file.replace('creator_users.txt', 'featured.txt');
      const featured = loadJson<string[]>(featuredFile, []);
      const paths = nominations[idx].image_paths || [];
      for (let i = paths.length - 1; i >= 0; i--) {
        if (!featured.includes(paths[i])) featured.unshift(paths[i]);
      }
      saveJson(featuredFile, featured);
    }
    saveNominations(nominations);
  }
  res.json({ ok: true });
});

// ===== Collaborator endpoints (requireCollaborator) =====
export const collaboratorRouter = Router();
collaboratorRouter.use(express.json({ limit: '50mb' }));

// GET /api/draw/collaborator/images
collaboratorRouter.get('/images', requireCollaborator, (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const limit = parseInt(req.query.limit as string) || 200;
  const offset = parseInt(req.query.offset as string) || 0;
  const cmap: Record<string, string> = {};
  try { for (const ln of fs.readFileSync(config.creator_map_file, 'utf-8').split('\n')) { const p = ln.split('\t'); if (p.length === 2) cmap[p[0].trim()] = p[1].trim(); } } catch {}
  const items: any[] = [];
  const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  if (fs.existsSync(config.output_dir)) {
    for (const f of fs.readdirSync(config.output_dir).filter((f: string) => exts.includes(path.extname(f).toLowerCase()))) {
      try {
        const s = fs.statSync(path.join(config.output_dir, f));
        const uid = cmap[f] || '';
        items.push({ path: f, mtime: s.mtimeMs / 1000, user_id: uid });
      } catch {}
    }
  }
  items.sort((a: any, b: any) => (b.mtime || 0) - (a.mtime || 0));
  res.json({ items: items.slice(offset, offset + limit), total: items.length });
});

// GET /api/draw/collaborator/recommendations
collaboratorRouter.get('/recommendations', requireCollaborator, (req: Request, res: Response) => {
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
  } catch {
    res.json({ items: [], total: 0 });
  }
});

// POST /api/draw/collaborator/nominate
collaboratorRouter.post('/nominate', requireCollaborator, (req: Request, res: Response) => {
  const { image_paths, note } = req.body as { image_paths?: string[]; note?: string };
  if (!image_paths || !image_paths.length) return res.status(400).json({ error: 'need image_paths' });
  const nominations = loadNominations();
  const nomination: any = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    image_paths,
    collaborator_id: (req as any).user?.id || 0,
    status: 'pending',
    submitted_at: Math.floor(Date.now() / 1000),
    note: note || '',
    reviewed_by: null,
    reviewed_at: null,
    admin_reason: null,
  };
  nominations.push(nomination);
  saveNominations(nominations);
  res.json({ ok: true, nomination });
});

// GET /api/draw/collaborator/nominations
collaboratorRouter.get('/nominations', requireCollaborator, (req: Request, res: Response) => {
  const userId = (req as any).user?.id || 0;
  const items = loadNominations().filter((n: any) => n.collaborator_id === userId);
  // Sort newest first
  items.sort((a: any, b: any) => (b.submitted_at || 0) - (a.submitted_at || 0));
  res.json({ items, total: items.length });
});
