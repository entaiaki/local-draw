import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import { WebSocket } from 'ws';
import { loadConfig, AppConfig } from './config.js';
import { QueueItem } from '../types/index.js';

const config = loadConfig();
const MAX_CONCURRENT = 1;
let activeCount = 0;
export function resetRunner() { activeCount = 0; semLocked = false; semQueue.length = 0; }
const semQueue: (() => void)[] = [];
let semLocked = false;

async function acquire(): Promise<void> {
  if (activeCount < 0) activeCount = 0;
  if (!semLocked && activeCount < MAX_CONCURRENT) { semLocked = true; return; }
  return new Promise(r => semQueue.push(r));
}

function release(): void {
  if (semQueue.length > 0) { semQueue.shift()!(); }
  else { semLocked = false; }
}

function releaseAcquired(): void {
  if (activeCount > 0) activeCount--;
  if (semQueue.length > 0) { semQueue.shift()(); }
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

export function workflowToPromptApi(data: any): { prompt_dict: Record<string, any>; positive_ref: [string, string] | null; negative_ref: [string, string] | null } {
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

  // 解析 SetNode/GetNode：SetNode 输出=输入，GetNode 找同名 SetNode 的输入
  const SETGET_TYPES = new Set(['SetNode', 'GetNode']);
  const setNodeMap: Record<string, number> = {}; // name -> node id
  const getNodeMap: Record<string, number> = {}; // name -> node id
  for (const n of topNodes) {
    if (n.type === 'SetNode') setNodeMap[n.title || ''] = n.id;
    if (n.type === 'GetNode') getNodeMap[n.title || ''] = n.id;
  }
  // 修正 linkMap：把 SetNode/GetNode 的输出指向实际来源
  for (const [lid, [oid, oslot]] of Object.entries(linkMap)) {
    const srcId = parseInt(oid);
    const srcNode = nodeById[srcId];
    if (!srcNode || !SETGET_TYPES.has(srcNode.type)) continue;
    // 找到此节点的首个输入（SetNode 的连接输入）
    const srcInput = (srcNode.inputs || []).find((i: any) => i.link != null && linkMap[i.link]);
    if (srcInput) {
      linkMap[parseInt(lid)] = linkMap[srcInput.link];
    } else if (srcNode.type === 'GetNode') {
      // GetNode 无输入：找同名 SetNode 的输入
      const setName = srcNode.title || '';
      const setNodeId = setNodeMap[setName];
      if (setNodeId) {
        const setNode = nodeById[setNodeId];
        const setInput = (setNode?.inputs || []).find((i: any) => i.link != null && linkMap[i.link]);
        if (setInput) linkMap[parseInt(lid)] = linkMap[setInput.link];
      }
    }
  }

  const SEED_WIDGETS = new Set(['seed', 'noise_seed']);
  const NON_EXEC = new Set(['MarkdownNote', 'Note', 'Reroute', 'PrimitiveNode', 'SetNode', 'GetNode']);

  const WIDGET_ONLY_NAMES: Record<string, string[]> = {
    EmptyLatentImage: ['width', 'height', 'batch_size'],
    EmptySD3LatentImage: ['width', 'height', 'batch_size'],
    EmptyFluxLatentImage: ['width', 'height', 'batch_size'],
    Qwen3Loader: ['repo_id', 'source', 'precision', 'attention'],
    Qwen3VoiceDesign: ['text', 'instruct', 'language', 'seed'],
    Qwen3CustomVoice: ['text', 'language', 'speaker', 'ref_text', 'ref_audio_path'],
    Qwen3VoiceClone: ['text', 'language', 'ref_text'],
  };

  function extractInputs(node: any, lmap: Record<number, [string, number]>): Record<string, any> {
    const result: Record<string, any> = {};
    const widgets = node.widgets_values || [];
    let wi = 0;
    const inpList = node.inputs || [];
    for (const inp of inpList) {
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
    // 已知 widgets-only 类型的节点：widgets 映射到指定字段
    const known = WIDGET_ONLY_NAMES[node.type] || [];
    if (known.length > 0) {
      for (let i = 0; i < known.length; i++) {
        if (result[known[i]] !== undefined) continue; // 已通过 inputs 设置
        result[known[i]] = wi < widgets.length ? widgets[wi] : (known[i] === 'seed' ? Math.floor(Math.random() * 2147483647) + 1 : 0);
        wi++;
      }
    } else if (inpList.length === 0 && widgets.length > 0 && wi < widgets.length) {
      // Unknown node type: assign positional names
      for (let i = 0; wi < widgets.length; i++) {
        result[`widget_${i}`] = widgets[wi];
        wi++;
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
  const TEXT_NODES = ['CLIPTextEncode', 'CLIPTextEncodeSDXL', 'TextEncodeQwenImageEditPlus'];

  // First pass: find by title
  for (const [nid, nd] of Object.entries(prompt)) {
    const n = nd as any;
    if (TEXT_NODES.includes(n.class_type)) {
      const title = (n._meta?.title || '').toLowerCase();
      const field = n.class_type === 'TextEncodeQwenImageEditPlus' ? 'prompt' : 'text';
      if (title.includes('positive') || title.includes('[pos]') || title.includes('[prompt]')) positiveRef = [nid, field];
      else if (title.includes('negative') || title.includes('[neg]')) negativeRef = [nid, field];
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
            if (src && TEXT_NODES.includes(src.class_type)) {
              if (role === 'positive') positiveRef = [String(slot[0]), 'text'];
              else negativeRef = [String(slot[0]), 'text'];
            }
          }
        }
        if (positiveRef) break;
      }
    }
  }

  // Third pass: any text encoding node
  if (!positiveRef) {
    for (const [nid, nd] of Object.entries(prompt)) {
      const n = nd as any;
      if (TEXT_NODES.includes(n.class_type)) {
        const field = n.class_type === 'TextEncodeQwenImageEditPlus' ? 'prompt' : 'text';
        positiveRef = [nid, field]; break;
      }
    }
  }
  if (!negativeRef) {
    for (const [nid, nd] of Object.entries(prompt)) {
      const n = nd as any;
      if (TEXT_NODES.includes(n.class_type) && nid !== positiveRef?.[0]) {
        const field = n.class_type === 'TextEncodeQwenImageEditPlus' ? 'prompt' : 'text';
        negativeRef = [nid, field]; break;
      }
    }
  }

  return { prompt_dict: prompt, positive_ref: positiveRef, negative_ref: negativeRef };
}

async function waitForCompletion(promptId: string, timeout = 600): Promise<{ history: any; videos: string[] }> {
  const wsUrl = `ws://${config.comfyui_host}:${config.comfyui_port}/ws?clientId=${getClientId()}`;
  const start = Date.now();
  const WebSocket = require('ws');
  let wsVideoFiles: string[] = [];

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
          // 捕获 VHS 节点的输出文件名（WebSocket 消息中有节点的完整输出）
          if (msg.type === 'executed' && msg.data?.output) {
            const out = msg.data.output;
            const crawl = (obj: any) => {
              if (!obj || typeof obj !== 'object') return;
              if (Array.isArray(obj)) { obj.forEach(crawl); return; }
              for (const v of Object.values(obj)) {
                if (typeof v === 'string' && /\.(png|jpg|jpeg|webp|gif|mp4|webm)$/i.test(v)) wsVideoFiles.push(v);
                else crawl(v);
              }
            };
            crawl(out);
          }
        } catch {}
      });
      ws.on('error', () => {});
      ws.on('close', () => { if (!completed) reject(new Error('WebSocket 关闭')); });
    });
  } catch { /* timeout or ws error */ }

  // Poll history (up to timeout)
  let history: any = null;
  for (let i = 0; i < timeout; i++) {
    try {
      const r = await comfy.get(`/api/history/${promptId}`);
      if (r.data?.[promptId]) { history = r.data[promptId]; break; }
    } catch {}
    if (Date.now() - start > timeout * 1000) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!history) throw new Error('无法获取 history');
  return { history, videos: wsVideoFiles };
}

let creatorMapLock = Promise.resolve();
function withCreatorMapLock<T>(fn: () => T): Promise<T> {
  let release: () => void;
  const prev = creatorMapLock;
  creatorMapLock = new Promise(r => { release = r; });
  return prev.then(() => { try { return fn(); } finally { release(); } });
}

export async function setCreatorMap(rel: string, userId: number): Promise<void> {
  return withCreatorMapLock(() => {
    const file = config.creator_map_file;
    try {
      let lines: string[] = [];
      if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
      lines = lines.filter(l => l.split('\t')[0] !== rel);
      lines.push(`${rel}\t${userId}`);
      fs.writeFileSync(file + '.tmp', lines.join('\n') + '\n', 'utf-8');
      fs.renameSync(file + '.tmp', file);
    } catch {}
  });
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
    if (req.workflow_path && req.workflow_path !== 'fork' && req.workflow_path.startsWith('TTS/')) {
      const localPath = path.resolve(process.cwd(), 'workflows', req.workflow_path);
      if (fs.existsSync(localPath)) {
        workflowData = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
      } else {
        throw new Error('TTS 工作流文件未找到: ' + req.workflow_path);
      }
    } else if (req.workflow_path && req.workflow_path !== 'fork') workflowData = await loadWorkflow(req.workflow_path);
    else if (req.image1_name) {
      const wfName = req.image2_name ? 'Flux2-Klein-图片编辑 (多图).json' : 'Flux2-Klein-图片编辑 (单图).json';
      req.workflow_path = `Flux/${wfName}`;
      workflowData = await loadWorkflow(req.workflow_path);
    }
    else if (!req.workflowData) throw new Error('未指定工作流');
      let prompt_dict: any;
      let positive_ref: [string, string] | null = null;
      let negative_ref: [string, string] | null = null;
      const result = workflowToPromptApi(workflowData);
      prompt_dict = result.prompt_dict;
      positive_ref = result.positive_ref;
      negative_ref = result.negative_ref;

    const finalPrompt = req.direct_prompt ? (req.style_tags ? req.style_tags + ', ' : '') + req.direct_prompt : (req.style_tags || '');
    // 🔊 TTS 工作流：注入参数到 Qwen3CustomVoice
    const isTtsWF = (req.workflow_path || '').startsWith('TTS/');
    if (isTtsWF) {
      // 映射语言值到 ComfyUI 节点期望的格式（首字母大写）
      const langMap: Record<string, string> = { auto: 'Auto', zh: 'Chinese', cn: 'Chinese', en: 'English', ja: 'Japanese', jp: 'Japanese', ko: 'Korean', kr: 'Korean' };
      const langVal = (req.language && langMap[req.language.toLowerCase()]) || req.language || 'Auto';
      for (const [, nd] of Object.entries(prompt_dict)) {
        const node = nd as any;
        if (node.class_type === 'Qwen3CustomVoice' || node.class_type === 'Qwen3VoiceDesign' || node.class_type === 'Qwen3VoiceClone') {
          node.inputs.text = finalPrompt || req.direct_prompt;
          if (req.speaker) node.inputs.speaker = req.speaker;
          node.inputs.language = langVal;
          if (req.instruct) node.inputs.instruct = req.instruct;
          if (req.ref_text) node.inputs.ref_text = req.ref_text;
          node.inputs.seed = Math.floor(Math.random() * 2147483647) + 1;
        }
      }
    }
    // 视频工作流：只改图片路径，什么都不动
    const isVideoWF = (req.workflow_path || '').startsWith('LTX/') || (req.workflow_path || '').startsWith('WAN2.2/');
    if (isTtsWF) {
      // TTS 无需处理图片/视频相关逻辑
    } else if (isVideoWF) {
      if (req.image1_name) {
        for (const [, nd] of Object.entries(prompt_dict)) {
          const node = nd as any;
          if (node.class_type === 'LoadImage' && node.inputs) {
            node.inputs.image = req.image1_name;
          }
        }
      }
    } else {
    // 图片工作流：正常处理
    if (positive_ref && finalPrompt) {
      prompt_dict[positive_ref[0]].inputs[positive_ref[1]] = finalPrompt;
      if (negative_ref && req.negative_prompt) {
        prompt_dict[negative_ref[0]].inputs[negative_ref[1]] = req.negative_prompt;
      }
    }
    // 随机种子
    const SEED_TYPES = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']);
    for (const [, nd] of Object.entries(prompt_dict)) {
      const node = nd as any;
      if (SEED_TYPES.has(node.class_type) && node.inputs) {
        node.inputs.seed = Math.floor(Math.random() * 2147483647) + 1;
      }
    }
    // KSamplerAdvanced 修复
    for (const [, nd] of Object.entries(prompt_dict)) {
      const node = nd as any;
      if (node.class_type === 'KSamplerAdvanced' && node.inputs) {
        const steps = node.inputs.steps;
        if (typeof steps === 'number' && steps > 0) {
          if (typeof node.inputs.end_at_step === 'number' && node.inputs.end_at_step > steps) {
            node.inputs.end_at_step = steps;
          }
          if (typeof node.inputs.start_at_step === 'number' && node.inputs.start_at_step >= steps) {
            node.inputs.start_at_step = 0;
          }
        }
      }
    }
    // 注入分辨率
    if (req.width && req.height) {
      for (const [, nd] of Object.entries(prompt_dict)) {
        const node = nd as any;
        if ((node.class_type === 'EmptyLatentImage' || node.class_type === 'EmptySD3LatentImage' || node.class_type === 'EmptyFluxLatentImage') && node.inputs) {
          node.inputs.width = req.width;
          node.inputs.height = req.height;
        }
      }
    }
    // Inject images for img2img
    if (req.image1_name) {
      const referencedIds = new Set<string>();
      for (const [, nd] of Object.entries(prompt_dict)) {
        for (const [, val] of Object.entries((nd as any).inputs || {})) {
          if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
            referencedIds.add(val[0]);
          }
        }
      }
      const loadImages = Object.entries(prompt_dict).filter(([nid, nd]: any) =>
        (nd.class_type === 'LoadImage' || nd.class_type === 'VHS_LoadImages') &&
        referencedIds.has(nid)
      );
      // Fallback: use all load images if none are connected
      if (loadImages.length === 0) {
        const allLi = Object.entries(prompt_dict).filter(([, nd]: any) => nd.class_type === 'LoadImage' || nd.class_type === 'VHS_LoadImages');
        loadImages.push(...allLi);
      }
      const imgNames = [req.image1_name, req.image2_name, req.image3_name].filter(Boolean);
      for (let i = 0; i < loadImages.length && i < imgNames.length; i++) {
        (loadImages[i][1] as any).inputs.image = imgNames[i];
      }
    }
    }

    // 强制视频工作流的 VHS 保存到 output 目录
    for (const [, nd] of Object.entries(prompt_dict)) {
      const node = nd as any;
      if (node.class_type === 'VHS_VideoCombine' && node.inputs) {
        node.inputs.save_output = true;
      }
    }

    // 等待 ComfyUI 空闲后再提交
    while (true) {
      try {
        const q = await comfy.get('/api/queue');
        if (q.data) {
          const running = q.data.queue_running || [];
          const pending = q.data.queue_pending || [];
          if (running.length === 0 && pending.length === 0) break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }

    // 记录输出目录当前的 mtime，生成后只认更新的文件
    const beforeMtime: Record<string, number> = {};
    try { for (const f of fs.readdirSync(config.output_dir)) beforeMtime[f] = fs.statSync(path.join(config.output_dir, f)).mtimeMs; } catch {}

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
    // 保存 prompt_id + 元数据到磁盘，重启后可恢复
    item.params._prompt_id = promptId;
    const metaFile = path.join(path.dirname(config.creator_map_file), 'prompt_meta.json');
    try {
                  
    } catch {}
    let history: any;
    let wsVideoFiles: string[] = [];
    try {
      const result = await waitForCompletion(promptId);
      history = result.history;
      wsVideoFiles = result.videos;
    } catch (e: any) {
      console.log('[runner] waitForCompletion failed: ' + e.message + ', will scan output dir');
    }
    const foundFiles = new Set<string>();
    for (const fn of wsVideoFiles) foundFiles.add(fn);

    // 从 history 提取文件名
    if (history) {
      // 检查 ComfyUI 执行错误
      const statusInfo = history.status || {};
      if (statusInfo.status_str === 'error' || history.error) {
        const errMsg = history.error?.details || history.error?.message || (statusInfo.messages ? JSON.stringify(statusInfo.messages) : '') || 'ComfyUI 执行失败';
        throw new Error(errMsg);
      }
      const outputs = history.outputs || {};
      const crawlOutputs = (obj: any, depth = 0): void => {
        if (depth > 10 || !obj) return;
        const isMedia = (s: string) => /\.(png|jpg|jpeg|webp|gif|mp4|webm|wav|flac)$/i.test(s);
        if (typeof obj === 'string' && isMedia(obj)) { foundFiles.add(obj); return; }
        if (Array.isArray(obj)) { obj.forEach(v => crawlOutputs(v, depth + 1)); return; }
        if (typeof obj === 'object') {
          for (const v of Object.values(obj)) crawlOutputs(v, depth + 1);
        }
      };
      crawlOutputs(outputs);
      crawlOutputs((history as any).ui);
    }
    // 兜底：扫 output/ 目录取生成后新增的文件
    const images: { filename: string; subfolder: string }[] = [];
    // 始终扫描 output 根目录，覆盖 history 未报告文件名的场景（不递归子目录，避免误扫其他任务的输出）
    for (const f of fs.readdirSync(config.output_dir)) {
      if (!/\.(mp4|webm|wav|flac)$/i.test(f)) continue;
      if (foundFiles.has(f)) continue;
      try {
        const fp = path.join(config.output_dir, f);
        const st = fs.statSync(fp);
        if (!st.isFile()) continue;
        if (!(f in beforeMtime) || st.mtimeMs > beforeMtime[f] + 1000) {
          foundFiles.add(f);
        }
      } catch {}
    }
    // 过滤掉绝对路径和 png 缩略图
    const hasVideo = [...foundFiles].some(f => /\.(mp4|webm)$/i.test(f));
    for (const fn of foundFiles) {
      if (hasVideo && /\.png$/i.test(fn)) continue;
      if (fn.includes(':\\') || fn.startsWith('/')) continue; // 绝对路径
      images.push({ filename: fn, subfolder: '' });
    }
    // 超时但找到新文件 = 仍然算成功
    if (!history && images.length === 0) throw new Error('生成超时且未找到输出文件');
    if (images.length === 0) throw new Error('未找到输出文件');

    // 记录输出文件，用于调试元数据写入状态
      try { (item.params as any)._output_files = images.map(i => i.subfolder ? `${i.subfolder}/${i.filename}` : i.filename); } catch {}
      // Write to creator_map + prompt metadata
    const promptMetaFile = path.join(path.dirname(config.creator_map_file), 'prompt_meta.json');
    let promptMeta: Record<string, any> = {};
    try { promptMeta = JSON.parse(fs.readFileSync(promptMetaFile, 'utf-8')); } catch {}
    // 清除 _pending_ 记录
    delete promptMeta['_pending_' + promptId];
    for (const img of images) {
      const relPath = img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename;
      await setCreatorMap(relPath, userId);
      promptMeta[relPath] = {
        prompt: finalPrompt || req.direct_prompt || '',
        negative_prompt: req.negative_prompt || String(item.params._llm_negative || ''),
        workflow_path: req.workflow_path || '',
        image1: req.image1_name || '',
        image2: req.image2_name || '',
        speaker: req.speaker || undefined,
        language: req.language || undefined,
      };
    }
    
    try { fs.writeFileSync(promptMetaFile, JSON.stringify(promptMeta, null, 2), 'utf-8'); } catch {}
      item.status = 'done';
  } catch (e: any) {
    item.status = 'failed';
    item.error = ((e.response?.data ? `${e.message}: ${JSON.stringify(e.response.data)}` : e.message) || String(e)).slice(0,2000);
    // Refund points on failure
    try {
      const { refundPoints, loadPointsCfg } = await import('../routes/wallet.js');
      const cfg = loadPointsCfg();
      const isImg2img = !!(item.params as any)?.image1_name;
      const wfPath = (item.params as any)?.workflow_path as string || '';
      const isAnima = wfPath.startsWith('ANIMA/');
      const isTts = wfPath.startsWith('TTS/');
      const cost = isTts ? cfg.tts_generate : (isImg2img ? cfg.image_to_image : (isAnima ? cfg.text_to_image_anima : cfg.text_to_image));
      await refundPoints(item.user_id, cost);
    } catch {}
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
