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
  try {
    const comfyApi = axios.create({ baseURL: config.comfyui_api, timeout: 10000 });
    const resp = await comfyApi.get('/api/userdata', {
      params: { dir: 'workflows', recurse: 'true', split: 'false', full_info: 'true' },
      headers: { 'Comfy-User': '' },
    });
    res.json(resp.data);
  } catch {
    // Fallback: scan local workflows directory
    const workflowsDir = subdir ? path.join(config.workflows_dir, subdir) : config.workflows_dir;
    const files: string[] = [];
    if (fs.existsSync(workflowsDir)) {
      for (const f of fs.readdirSync(workflowsDir)) {
        if (f.endsWith('.json')) files.push(f);
      }
    }
    res.json({ workflows: files.map((f: string) => ({ name: f, path: f })), category_order: [] });
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
    const data = JSON.parse(fs.readFileSync(stylesFile, 'utf-8'));
    res.json(data);
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
