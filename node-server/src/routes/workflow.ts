import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { loadConfig } from '../services/config.js';
import { workflowToPromptApi } from '../services/runner.js';

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
    const files: string[] = Array.isArray(resp.data) ? resp.data.filter((f: any) => typeof f === 'string' && f.startsWith('WAI/')) : [];
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

export { router as workflowRouter };
