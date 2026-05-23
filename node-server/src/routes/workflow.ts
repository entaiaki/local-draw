import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { loadConfig } from '../services/config.js';
import { workflowToPromptApi } from '../services/runner.js';

const router = Router();
const config = loadConfig();

const THUMB_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function scanWorkflowsDir(baseDir: string, subdir = ''): { path: string; name: string; thumbnail: boolean; category: string }[] {
  if (!fs.existsSync(baseDir)) return [];
  const result: { path: string; name: string; thumbnail: boolean; category: string }[] = [];
  for (const catDir of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!catDir.isDirectory()) continue;
    const dirPath = path.join(baseDir, catDir.name);
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.json')) continue;
      const baseName = file.slice(0, -5);
      const wfRelPath = subdir ? `${subdir}/${catDir.name}/${file}` : `${catDir.name}/${file}`;
      let hasThumb = false;
      for (const ext of THUMB_EXTS) {
        if (fs.existsSync(path.join(dirPath, baseName + ext))) { hasThumb = true; break; }
      }
      result.push({
        path: wfRelPath,
        name: baseName,
        thumbnail: hasThumb,
        category: catDir.name,
      });
    }
  }
  return result;
}

// GET /api/workflows
router.get('/workflows', async (req: Request, res: Response) => {
  const subdir = req.query.subdir as string || '';

  // Build the base directory path
  const baseDir = subdir
    ? path.join(config.workflows_dir, subdir)
    : config.workflows_dir;

  try {
    // Try ComfyUI API first
    const comfyApi = axios.create({ baseURL: config.comfyui_api, timeout: 10000 });
    const params: any = { dir: 'workflows', recurse: 'true' };
    if (subdir) params.dir = `workflows/${subdir}`;
    await comfyApi.get('/api/userdata', { params, headers: { 'Comfy-User': '' } });
    // If ComfyUI is reachable, we still scan our local dirs for correct category/thumbnail data
    const workflows = scanWorkflowsDir(baseDir, subdir);
    const categoryOrder = [...new Set(workflows.map(w => w.category))];
    res.json({ workflows, category_order: categoryOrder });
  } catch {
    // Fallback: local filesystem
    const workflows = scanWorkflowsDir(baseDir, subdir);
    const categoryOrder = [...new Set(workflows.map(w => w.category))];
    res.json({ workflows, category_order: categoryOrder });
  }
});

// GET /api/workflows/current
router.get('/workflows/current', async (req: Request, res: Response) => {
  const wfPath = req.query.path as string;
  if (!wfPath) return res.status(400).json({ error: 'need path' });

  try {
    const comfyApi = axios.create({ baseURL: config.comfyui_api, timeout: 10000 });
    const encodedPath = wfPath.replace(/\\/g, '/').split('/').map(s => encodeURIComponent(s)).join('%2F');
    const resp = await comfyApi.get(`/api/userdata/workflows%2F${encodedPath}`, {
      headers: { 'Comfy-User': '' },
    });
    // 提取默认正向/负向提示词
    let builtin_prompt = '';
    let builtin_negative_prompt = '';
    try {
      const { prompt_dict, positive_ref, negative_ref } = workflowToPromptApi(resp.data);
      if (positive_ref) {
        const v = prompt_dict[positive_ref[0]]?.inputs?.[positive_ref[1]];
        if (typeof v === 'string') builtin_prompt = v;
      }
      if (negative_ref) {
        const v = prompt_dict[negative_ref[0]]?.inputs?.[negative_ref[1]];
        if (typeof v === 'string') builtin_negative_prompt = v;
      }
    } catch {}
    res.json({ ...resp.data, builtin_prompt, builtin_negative_prompt });
  } catch {
    res.status(404).json({ error: 'workflow not found' });
  }
});

export { router as workflowRouter };
