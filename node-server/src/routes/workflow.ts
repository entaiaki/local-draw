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

function scanTagsDir(): { path: string; name: string; thumbnail: boolean; category: string }[] {
  const tagsDir = path.join(config.workflows_dir, 'tags');
  if (!fs.existsSync(tagsDir)) return [];
  const result: { path: string; name: string; thumbnail: boolean; category: string }[] = [];
  for (const entry of fs.readdirSync(tagsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const catDir = path.join(tagsDir, entry.name);
      for (const file of fs.readdirSync(catDir)) {
        if (!file.endsWith('.txt')) continue;
        const baseName = file.slice(0, -4);
        const wfRelPath = `tags/${entry.name}/${file}`;
        let hasThumb = false;
        for (const ext of THUMB_EXTS) {
          if (fs.existsSync(path.join(catDir, baseName + ext))) { hasThumb = true; break; }
        }
        result.push({ path: wfRelPath, name: baseName, thumbnail: hasThumb, category: entry.name });
      }
    } else if (entry.isFile() && entry.name.endsWith('.txt')) {
      const baseName = entry.name.slice(0, -4);
      const wfRelPath = `tags/${entry.name}`;
      let hasThumb = false;
      for (const ext of THUMB_EXTS) {
        if (fs.existsSync(path.join(tagsDir, baseName + ext))) { hasThumb = true; break; }
      }
      result.push({ path: wfRelPath, name: baseName, thumbnail: hasThumb, category: 'Tag预设' });
    }
  }
  return result;
}

function baseWorkflowPath(subdir: string): string | null {
  const dir = subdir || 'WAI';
  const basePath = `${dir}/通用/无Lora.json`;
  const fullPath = path.join(config.workflows_dir, basePath);
  return fs.existsSync(fullPath) ? basePath : null;
}

// GET /api/workflows
router.get('/workflows', async (req: Request, res: Response) => {
  const subdir = req.query.subdir as string || '';

  const baseDir = subdir
    ? path.join(config.workflows_dir, subdir)
    : config.workflows_dir;

  let workflows: { path: string; name: string; thumbnail: boolean; category: string }[] = [];
  let categoryOrder: string[] = [];

  try {
    const comfyApi = axios.create({ baseURL: config.comfyui_api, timeout: 10000 });
    const params: any = { dir: 'workflows', recurse: 'true' };
    if (subdir) params.dir = `workflows/${subdir}`;
    await comfyApi.get('/api/userdata', { params, headers: { 'Comfy-User': '' } });
    workflows = scanWorkflowsDir(baseDir, subdir);
    categoryOrder = [...new Set(workflows.map(w => w.category))];
  } catch {
    workflows = scanWorkflowsDir(baseDir, subdir);
    categoryOrder = [...new Set(workflows.map(w => w.category))];
  }

  // Append tag presets (shared across WAI/ANIMA)
  const tags = scanTagsDir();
  if (tags.length > 0) {
    workflows = workflows.concat(tags);
    if (!categoryOrder.includes('Tag预设')) categoryOrder.push('Tag预设');
  }

  res.json({ workflows, category_order: categoryOrder });
});

// GET /api/workflows/current
router.get('/workflows/current', async (req: Request, res: Response) => {
  const wfPath = req.query.path as string;
  const subdir = (req.query.subdir as string) || 'WAI';
  if (!wfPath) return res.status(400).json({ error: 'need path' });

  // Handle tag preset (.txt file)
  if (wfPath.startsWith('tags/') && wfPath.endsWith('.txt')) {
    const absPath = path.resolve(path.join(config.workflows_dir, wfPath));
    if (!absPath.startsWith(path.resolve(config.workflows_dir)) || !fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'tag file not found' });
    }
    let content = fs.readFileSync(absPath, 'utf-8').trim();
    if (content.length > 2000) content = content.slice(0, 2000);

    // Load base workflow (无Lora)
    const baseWfPath = baseWorkflowPath(subdir);
    if (!baseWfPath) return res.status(404).json({ error: 'base workflow 无Lora not found for subdir: ' + subdir });

    try {
      const comfyApi = axios.create({ baseURL: config.comfyui_api, timeout: 10000 });
      const encoded = baseWfPath.replace(/\\/g, '/').split('/').map(s => encodeURIComponent(s)).join('%2F');
      const resp = await comfyApi.get(`/api/userdata/workflows%2F${encoded}`, {
        headers: { 'Comfy-User': '' },
      });
      let builtin_negative_prompt = '';
      try {
        const { prompt_dict, negative_ref } = workflowToPromptApi(resp.data);
        if (negative_ref) {
          const v = prompt_dict[negative_ref[0]]?.inputs?.[negative_ref[1]];
          if (typeof v === 'string') builtin_negative_prompt = v;
        }
      } catch {}
      res.json({ ...resp.data, builtin_prompt: content, builtin_negative_prompt });
    } catch {
      res.status(404).json({ error: 'base workflow not found on ComfyUI' });
    }
    return;
  }

  try {
    const comfyApi = axios.create({ baseURL: config.comfyui_api, timeout: 10000 });
    const encodedPath = wfPath.replace(/\\/g, '/').split('/').map(s => encodeURIComponent(s)).join('%2F');
    const resp = await comfyApi.get(`/api/userdata/workflows%2F${encodedPath}`, {
      headers: { 'Comfy-User': '' },
    });
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
