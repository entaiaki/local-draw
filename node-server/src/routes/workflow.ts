import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { loadConfig } from '../services/config.js';

const router = Router();
const config = loadConfig();

// GET /api/workflows
router.get('/workflows', async (req: Request, res: Response) => {
  const subdir = req.query.subdir as string || '';
  // Load workflow meta for thumbnail/category mapping
  const metaFile = path.join(path.dirname(config.creator_map_file), 'workflow_meta.json');
  let metaList: { workflow: string; thumbnail?: string; category?: string }[] = [];
  try { metaList = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch {}
  const metaMap = new Map(metaList.map(m => [m.workflow, m]));
  const thumbDir = config.thumb_dir || path.join(process.cwd(), '..', 'web', 'thumbnails');

  try {
    const comfyApi = axios.create({ baseURL: config.comfyui_api, timeout: 10000 });
    const params: any = { dir: 'workflows', recurse: 'true' };
    if (subdir) params.dir = `workflows/${subdir}`;
    const resp = await comfyApi.get('/api/userdata', { params, headers: { 'Comfy-User': '' } });
    const files: string[] = Array.isArray(resp.data) ? resp.data : [];
    const workflows = files.map((f: string) => {
      const wfPath = subdir ? `${subdir}/${f}` : f;
      const meta = metaMap.get(wfPath);
      return {
        path: wfPath,
        name: f.replace(/\.json$/, ''),
        thumbnail: meta?.thumbnail ? fs.existsSync(path.join(thumbDir, meta.thumbnail)) : false,
        category: meta?.category || '',
      };
    });
    res.json({ workflows, category_order: [] });
  } catch {
    const dir = subdir ? path.join(config.workflows_dir, subdir) : config.workflows_dir;
    const files: string[] = [];
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json')) files.push(f);
      }
    }
    const workflows = files.map((f: string) => {
      const wfPath = subdir ? `${subdir}/${f}` : f;
      const meta = metaMap.get(wfPath);
      return {
        path: wfPath,
        name: f.replace(/\.json$/, ''),
        thumbnail: meta?.thumbnail ? fs.existsSync(path.join(thumbDir, meta.thumbnail)) : false,
        category: meta?.category || '',
      };
    });
    res.json({ workflows, category_order: [] });
  }
});

// GET /api/workflows/current
router.get('/workflows/current', async (req: Request, res: Response) => {
  const wfPath = req.query.path as string;
  if (!wfPath) return res.status(400).json({ error: 'need path' });

  try {
    const comfyApi = axios.create({ baseURL: config.comfyui_api, timeout: 10000 });
    const encodedPath = encodeURIComponent(wfPath);
    const resp = await comfyApi.get(`/api/userdata/workflows%2F${encodedPath}`, {
      headers: { 'Comfy-User': '' },
    });
    res.json(resp.data);
  } catch {
    res.status(404).json({ error: 'workflow not found' });
  }
});

// GET /api/styles
router.get('/styles', (req: Request, res: Response) => {
  const stylesFile = path.join(path.dirname(config.creator_map_file), 'styles.json');
  try {
    const styles = JSON.parse(fs.readFileSync(stylesFile, 'utf-8'));
    const result = styles.map((s: any) => ({
      ...s,
      thumbnail_url: s.image ? `/api/style_thumbnail?name=${encodeURIComponent(s.image)}` : undefined,
    }));
    res.json({ styles: result });
  } catch {
    res.json({ styles: [] });
  }
});

// GET /api/resolutions
router.get('/resolutions', (req: Request, res: Response) => {
  res.json({
    presets: [
      { label: '512×512', w: 512, h: 512 },
      { label: '768×768', w: 768, h: 768 },
      { label: '1024×1024', w: 1024, h: 1024 },
      { label: '1216×832', w: 1216, h: 832 },
      { label: '832×1216', w: 832, h: 1216 },
    ],
  });
});

export { router as workflowRouter };
