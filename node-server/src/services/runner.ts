import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import { WebSocket } from 'ws';
import { loadConfig, AppConfig } from './config.js';
import { translatePrompt } from './llm.js';
import { QueueItem } from '../types/index.js';

const config = loadConfig();
const MAX_CONCURRENT = 1;
let activeCount = 0;
export function resetRunner() { activeCount = 0; semLocked = false; semQueue.length = 0; }
const semQueue: (() => void)[] = [];
let semLocked = false;

async function acquire(): Promise<void> {
  if (!semLocked && activeCount < MAX_CONCURRENT) { semLocked = true; return; }
  return new Promise(r => semQueue.push(r));
}

function release(): void {
  if (semQueue.length > 0) { semQueue.shift()!(); }
  else { semLocked = false; }
}

function releaseAcquired(): void {
  activeCount--;
  if (semQueue.length > 0) { semQueue.shift()!(); }
  else { semLocked = false; }
}

const comfy = axios.create({
  baseURL: `http://${config.comfyui_host}:${config.comfyui_port}`,
  timeout: 600000,
  headers: { 'Comfy-User': '' },
});

let clientId = '';
function getClientId(): string {
  if (!clientId) clientId = require('uuid').v4().replace(/-/g, '');
  return clientId;
}

async function loadWorkflow(path: string): Promise<any> {
  const tail = path.replace(/\\/g, '/').split('/').map(p => encodeURIComponent(p)).join('%2F');
  const url = `http://${config.comfyui_host}:${config.comfyui_port}/api/userdata/workflows%2F${tail}`;
  try {
    const r = await axios.get(url, { headers: { 'Comfy-User': '' }, timeout: 10000, params: {} });
    return r.data;
  } catch (e: any) {
    console.log(`[loadWorkflow] FAILED: ${e.message}`, e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : '');
    throw e;
  }
}

function workflowToPromptApi(data: any): { prompt_dict: Record<string, any>; positive_ref: [string, string] | null; negative_ref: [string, string] | null } {
  // API 格式透传
  if (data && !data.nodes && typeof data === 'object') {
    const vals = Object.values(data);
    if (vals.length > 0 && vals.every((v: any) => v && v.class_type)) {
      const prompt = Object.fromEntries(Object.entries(data).map(([k, v]) => [String(k), v]));
      return findClipRefs(prompt);
    }
  }
  // Node 格式 → API 格式
  const prompt: Record<string, any> = {};
  const topNodes = data?.nodes || [];
  const topLinks = data?.links || [];
  const subgraphs: Record<string, any> = {};
  for (const sg of (data?.definitions?.subgraphs || [])) subgraphs[sg.id] = sg;

  // Build subgraph output map
  const sgOutMap: Record<string, Record<number, [number, number]>> = {};
  for (const [sgId, sg] of Object.entries(subgraphs)) {
    const m: Record<number, [number, number]> = {};
    const outNodeId = sg.outputNode?.id ?? -20;
    for (const link of sg.links || []) {
      if (link.target_id === outNodeId) m[link.target_slot || 0] = [link.origin_id, link.origin_slot || 0];
    }
    sgOutMap[sgId] = m;
  }

  // Build link map
  const linkMap: Record<number, [string, number]> = {};
  const nodeById: Record<number, any> = {};
  for (const n of topNodes) nodeById[n.id] = n;

  for (const link of topLinks) {
    let lid: number, oid: number, oslot: number;
    if (Array.isArray(link) && link.length >= 6) { lid = link[0]; oid = link[1]; oslot = link[2]; }
    else if (link?.id) { lid = link.id; oid = link.origin_id; oslot = link.origin_slot || 0; }
    else continue;
    const srcNode = nodeById[oid];
    if (srcNode && subgraphs[srcNode.type]) {
      const sgId = srcNode.type;
      const internal = sgOutMap[sgId]?.[oslot];
      if (internal) linkMap[lid] = [`${sgId}:${internal[0]}`, internal[1]];
      else linkMap[lid] = [String(oid), oslot];
    } else {
      linkMap[lid] = [String(oid), oslot];
    }
  }

  const SEED_WIDGETS = new Set(['seed', 'noise_seed']);
  const NON_EXEC = new Set(['MarkdownNote', 'Note', 'Reroute', 'PrimitiveNode']);

  function extractInputs(node: any, lmap: Record<number, [string, number]>): Record<string, any> {
    const result: Record<string, any> = {};
    const widgets = node.widgets_values || [];
    let wi = 0;
    for (const inp of node.inputs || []) {
      const name = inp.name;
      if (!name) continue;
      const linkId = inp.link;
      const isWidget = inp.widget != null;
      const ref = linkId != null ? lmap[linkId] : null;
      if (ref) {
        result[name] = [ref[0], ref[1]];
        if (isWidget) {
          wi++;
          if (SEED_WIDGETS.has(name) && wi < widgets.length) {
            const v = widgets[wi];
            if (typeof v === 'string' && ['fixed', 'increment', 'decrement', 'randomize'].includes(v)) wi++;
          }
        }
      } else if (isWidget) {
        if (wi < widgets.length) {
          result[name] = widgets[wi];
          wi++;
        }
        if (SEED_WIDGETS.has(name) && wi < widgets.length) {
          const v = widgets[wi];
          if (typeof v === 'string' && ['fixed', 'increment', 'decrement', 'randomize'].includes(v)) wi++;
        }
      }
    }
    return result;
  }

  for (const node of topNodes) {
    const ntype = node.type || '';
    const nid = String(node.id);
    if (NON_EXEC.has(ntype)) continue;

    if (subgraphs[ntype]) {
      const sg = subgraphs[ntype];
      const sgId = sg.id;
      // Build subgraph link map
      const sgLinkMap: Record<number, [string, number]> = {};
      const extInputs: Record<string, [string, number]> = {};
      for (const inp of node.inputs || []) {
        if (inp.link != null && linkMap[inp.link]) extInputs[inp.name] = linkMap[inp.link];
      }
      const sgInputsList = sg.inputs || [];
      for (const link of sg.links || []) {
        const lid = link.id;
        const oid = link.origin_id;
        const oslot = link.origin_slot || 0;
        if (oid < 0) {
          if (oslot < sgInputsList.length && extInputs[sgInputsList[oslot].name]) {
            sgLinkMap[lid] = extInputs[sgInputsList[oslot].name];
          }
        } else {
          sgLinkMap[lid] = [`${sgId}:${oid}`, oslot];
        }
      }

      const proxy = node.properties?.proxyWidgets || [];
      const instWidgets = node.widgets_values || [];
      const sgWidgetOverride: Record<string, any> = {};
      for (let i = 0; i < proxy.length && i < instWidgets.length; i++) {
        const pair = proxy[i];
        if (Array.isArray(pair) && pair.length === 2) sgWidgetOverride[`${pair[0]}:${pair[1]}`] = instWidgets[i];
      }

      for (const subNode of sg.nodes || []) {
        const subType = subNode.type || '';
        if (NON_EXEC.has(subType)) continue;
        const subNid = `${sgId}:${subNode.id}`;
        const subInp = extractInputs(subNode, sgLinkMap);
        for (const inp of subNode.inputs || []) {
          if (inp.widget != null) {
            const key = `${subNode.id}:${inp.name}`;
            if (sgWidgetOverride[key] !== undefined) subInp[inp.name] = sgWidgetOverride[key];
          }
        }
        prompt[subNid] = { inputs: subInp, class_type: subType, _meta: { title: subNode.title || subType } };
      }
      continue;
    }

    prompt[nid] = { inputs: extractInputs(node, linkMap), class_type: ntype, _meta: { title: node.title || ntype } };
  }

  return findClipRefs(prompt);
}

function findClipRefs(prompt: Record<string, any>): { prompt_dict: Record<string, any>; positive_ref: [string, string] | null; negative_ref: [string, string] | null } {
  let positiveRef: [string, string] | null = null;
  let negativeRef: [string, string] | null = null;

  // First pass: find by title
  for (const [nid, nd] of Object.entries(prompt)) {
    const n = nd as any;
    if (n.class_type === 'CLIPTextEncode') {
      const title = (n._meta?.title || '').toLowerCase();
      if (title.includes('positive') || title.includes('[pos]') || title.includes('[prompt]')) positiveRef = [nid, 'text'];
      else if (title.includes('negative') || title.includes('[neg]')) negativeRef = [nid, 'text'];
    }
  }

  // Second pass: KSampler chain
  if (!positiveRef) {
    for (const [nid, nd] of Object.entries(prompt)) {
      const n = nd as any;
      if (['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced'].includes(n.class_type)) {
        for (const role of ['positive', 'negative']) {
          const slot = n.inputs?.[role];
          if (Array.isArray(slot) && slot[0]) {
            const src = prompt[String(slot[0])];
            if (src && ['CLIPTextEncode', 'CLIPTextEncodeSDXL'].includes(src.class_type)) {
              if (role === 'positive') positiveRef = [String(slot[0]), 'text'];
              else negativeRef = [String(slot[0]), 'text'];
            }
          }
        }
        if (positiveRef) break;
      }
    }
  }

  // Third pass: any CLIPTextEncode
  if (!positiveRef) {
    for (const [nid, nd] of Object.entries(prompt)) {
      const n = nd as any;
      if (n.class_type === 'CLIPTextEncode') { positiveRef = [nid, 'text']; break; }
    }
  }
  if (!negativeRef) {
    for (const [nid, nd] of Object.entries(prompt)) {
      const n = nd as any;
      if (n.class_type === 'CLIPTextEncode' && nid !== positiveRef?.[0]) { negativeRef = [nid, 'text']; break; }
    }
  }

  return { prompt_dict: prompt, positive_ref: positiveRef, negative_ref: negativeRef };
}

async function waitForCompletion(promptId: string, timeout = 60): Promise<any> {
  const wsUrl = `ws://${config.comfyui_host}:${config.comfyui_port}/ws?clientId=${getClientId()}`;
  const start = Date.now();
  const WebSocket = require('ws');

  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { handshakeTimeout: 15000 });
      let completed = false;
      const timer = setTimeout(() => { if (!completed) { ws.close(); reject(new Error('生成超时')); } }, timeout * 1000);
      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'execution_success' && msg.data?.prompt_id === promptId) { completed = true; clearTimeout(timer); ws.close(); resolve(); }
          if (msg.type === 'execution_error' && msg.data?.prompt_id === promptId) { completed = true; clearTimeout(timer); ws.close(); reject(new Error(msg.data.exception_message || 'ComfyUI 执行错误')); }
        } catch {}
      });
      ws.on('error', () => {});
      ws.on('close', () => { if (!completed) reject(new Error('WebSocket 关闭')); });
    });
  } catch { /* timeout or ws error */ }

  // Poll history (up to 120s)
  for (let i = 0; i < 120; i++) {
    try {
      const r = await comfy.get(`/api/history/${promptId}`);
      if (r.data?.[promptId]) return r.data[promptId];
    } catch {}
    if (Date.now() - start > timeout * 1000) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('无法获取 history');
}

export function setCreatorMap(rel: string, userId: number): void {
  const file = config.creator_map_file;
  const lockFile = file + '.lock';
  try {
    let lines: string[] = [];
    if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
    lines = lines.filter(l => l.split('\t')[0] !== rel);
    lines.push(`${rel}\t${userId}`);
    fs.writeFileSync(file + '.tmp', lines.join('\n') + '\n', 'utf-8');
    fs.renameSync(file + '.tmp', file);
  } catch {}
}

export async function runQueueTask(item: QueueItem): Promise<void> {
  const userId = item.user_id;
  const req = item.params as any;

  try {
    item.status = 'waiting';
    await acquire();
    activeCount++;
    item.status = 'running';
    item.started_at = Date.now() / 1000;

    // Load workflow
    let workflowData: any;
    if (req.inline_workflow) workflowData = req.inline_workflow;
    else if (req.workflow_path) workflowData = await loadWorkflow(req.workflow_path);
    else if (req.image1_name) {
      const wfName = req.image2_name ? 'Flux2-Klein-图片编辑 (多图).json' : 'Flux2-Klein-图片编辑 (单图).json';
      workflowData = await loadWorkflow(`Flux/${wfName}`);
    }
    else throw new Error('未指定工作流');

    // LLM translate if nl_prompt (使用预处理结果或现场调用)
    let finalPrompt = req.direct_prompt || '';
    let llmOutput = item.params._llm_output as string || '';
    if (req.nl_prompt && !llmOutput) {
      try {
        const llmResult = await translatePrompt(req.nl_prompt, req.rewrite ? finalPrompt : undefined, req.negative_prompt);
        finalPrompt = llmResult.positive;
        llmOutput = llmResult.positive;
      } catch (e: any) {
        // If LLM fails, fallback to direct prompt
      }
    } else if (llmOutput) {
      finalPrompt = llmOutput;
    }
    // 确保 LLM 输出保存到队列项
    if (llmOutput) { try { (item.params as any)._llm_output = llmOutput; } catch {} }

    // Convert workflow
    const { prompt_dict, positive_ref, negative_ref } = workflowToPromptApi(workflowData);
    if (!positive_ref) throw new Error('未找到正向 CLIPTextEncode 节点');
    if (!prompt_dict[positive_ref[0]]) throw new Error('正向节点不存在');

    // Inject prompt
    prompt_dict[positive_ref[0]].inputs[positive_ref[1]] = finalPrompt;
    // 保存 LLM 输出到队列项，调试面板可见
    if (llmOutput) { try { (item.params as any)._llm_output = llmOutput; } catch {} }

    // Inject images for img2img
    if (req.image1_name) {
      const loadImages = Object.entries(prompt_dict).filter(([, nd]: any) => nd.class_type === 'LoadImage' || nd.class_type === 'VHS_LoadImages');
      if (loadImages.length > 0) (loadImages[0][1] as any).inputs.image = req.image1_name;
      if (loadImages.length > 1 && req.image2_name) (loadImages[1][1] as any).inputs.image = req.image2_name;
    }

    // Submit to ComfyUI
    const submitRes = await comfy.post('/api/prompt', {
      client_id: getClientId(),
      prompt: prompt_dict,
      extra_data: { preview_method: 'auto' },
    });
    if (submitRes.status >= 400) {
      const detail = typeof submitRes.data === 'object' ? JSON.stringify(submitRes.data).slice(0, 300) : String(submitRes.data).slice(0, 300);
      throw new Error(`ComfyUI 拒绝请求: ${detail}`);
    }
    const promptId = submitRes.data.prompt_id as string;
    // 保存 prompt_id 到磁盘，重启后可恢复
    item.params._prompt_id = promptId;
    try { (await import('../routes/queue.js')).saveQueueState?.(); } catch {}

    // Wait for completion
    const history = await waitForCompletion(promptId);
    if (!history) throw new Error('生成无结果');

    // Extract images
    const outputs = history.outputs || {};
    const images: { filename: string; subfolder: string }[] = [];
    for (const [, out] of Object.entries(outputs)) {
      const o = out as any;
      if (o.images) {
        for (const img of o.images) {
          images.push({ filename: img.filename, subfolder: img.subfolder || '' });
        }
      }
    }

    // Write to creator_map + prompt metadata
    const promptMetaFile = path.join(path.dirname(config.creator_map_file), 'prompt_meta.json');
    let promptMeta: Record<string, any> = {};
    try { promptMeta = JSON.parse(fs.readFileSync(promptMetaFile, 'utf-8')); } catch {}
    for (const img of images) {
      const relPath = img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename;
      setCreatorMap(relPath, userId);
      promptMeta[relPath] = {
        prompt: finalPrompt || req.direct_prompt || '',
        nl_prompt: req.nl_prompt || '',
        negative_prompt: req.negative_prompt || '',
        rewrite: !!req.rewrite,
      };
    }
    try { fs.writeFileSync(promptMetaFile, JSON.stringify(promptMeta, null, 2), 'utf-8'); } catch {}

    item.status = 'done';
  } catch (e: any) {
    item.status = 'failed';
    item.error = e.message || String(e);
  } finally {
    item.finished_at = Date.now() / 1000;
    // 清理队列用户计数
    try {
      const { queuedUserIds } = await import('../routes/queue.js');
      const cur = queuedUserIds[item.user_id] || 0;
      if (cur > 1) queuedUserIds[item.user_id] = cur - 1;
      else delete queuedUserIds[item.user_id];
    } catch {}
    try { (await import('../routes/queue.js')).saveQueueState?.(); } catch {}
    try { (await import('../routes/status.js')).broadcast({ type: 'queue_update', ts: Date.now() }); } catch {}
    releaseAcquired();
  }
}
