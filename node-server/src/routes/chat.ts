import { Router, Request, Response } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { loadConfig, loadJson, saveJson } from '../services/config.js';
import { streamChat, callGoogle, estimateTokens } from '../services/llm.js';
import { deductPoints, loadPointsCfg } from './wallet.js';
import path from 'path';

const router = Router();
const config = loadConfig();

const CHAT_SYSTEM_TEMPLATE = `{role_setup}

{gen_instruction}

当前工作流自带提示词：{workflow_prompt}

负面提示词参考：{negative_ref}`;

const GEN_INSTRUCTION = `你可以在对话中自然地生成图片。在回复中插入生图标记：
[GEN: 英文Danbooru tags, 用逗号分隔]

重要：[GEN: ...] 标记是系统指令，用户完全看不到它。不要在文字中提及、解释或引用 [GEN:] 标记。

生图规则：
- 每说完一句话（以句号、感叹号、问号等结束），立即插入对应的 [GEN: ...] 标记
- 每句对话都配一张图，不要跳过
- tags 用英文 Danbooru 格式，描述当前这句话对应的画面
- CRITICAL: [GEN: ...] 中的 tags 必须以角色自身的 tag 开头（如角色名、外观特征），然后才是动作、表情、场景等。角色 tag 不能省略或删除
- 以角色扮演的方式自然回复，[GEN:] 标记穿插在文本中，但用户看不到它们`;

interface ChatRequestBody {
  message: string;
  workflow_path?: string;
  style_tags?: string;
  system_prompt: string;
  negative_prompt?: string;
  history: Array<{ role: string; content: string }>;
  gen_enabled?: boolean;
}

function getActiveProfile(): Record<string, any> {
  const d = loadJson<any>(config.llm_config_file, {});
  const profiles = d.profiles || [];
  const active = d.active ?? 0;
  return profiles[active] || {};
}

// POST /api/draw/chat — SSE，纯 LLM 流式输出，不涉及队列/生图
router.post('/chat', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: '论坛登录凭证已过期，请刷新页面或重新登录' });
  if (user.role !== 'admin' && user.role !== 'user') return res.status(403).json({ detail: '已禁止使用酒馆' });

  const body = req.body as ChatRequestBody;
  if (!body.system_prompt?.trim()) return res.status(400).json({ detail: '请填写角色设定' });
  if (!body.message?.trim()) return res.status(400).json({ detail: '消息不能为空' });

  // 读取工作流自带的 builtin prompt
  let workflowPrompt = '(无)';
  if (body.workflow_path) {
    try {
      const { workflowToPromptApi } = await import('../services/runner.js');
      const fs = await import('fs');
      const path = await import('path');
      const wfPath = path.join(config.workflows_dir, body.workflow_path);
      if (fs.existsSync(wfPath)) {
        const wfData = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));
        const { positive_ref } = workflowToPromptApi(wfData);
        if (positive_ref) {
          const [nid, inp] = positive_ref;
          const v = wfData?.[nid]?.inputs?.[inp];
          if (typeof v === 'string' && v.trim()) workflowPrompt = v.trim();
        }
      }
    } catch {}
  }

  const negRef = body.negative_prompt?.trim() || 'worst quality, low quality, blurry';
  const genEnabled = body.gen_enabled !== false; // 默认开启
  const systemContent = CHAT_SYSTEM_TEMPLATE
    .replace('{role_setup}', body.system_prompt.trim())
    .replace('{gen_instruction}', genEnabled ? GEN_INSTRUCTION : '以角色扮演的方式自然回复用户。不要在回复中提及任何技术标记或生图指令。')
    .replace('{workflow_prompt}', workflowPrompt)
    .replace('{negative_ref}', negRef);

  const messages: Array<{ role: string; content: string }> = [];
  for (const h of body.history || []) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: systemContent + '\n\n' + body.message });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function send(event: string, data: unknown) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const cfg = getActiveProfile();
  const provider = cfg.provider || 'custom';

  let endpoint = '';
  let apiKey = '';
  let model = '';
  if (provider === 'google') {
    endpoint = '';
    apiKey = cfg.google_api_key || '';
    model = cfg.google_model || '';
  } else if (provider === 'custom') {
    endpoint = (cfg.custom_endpoint || '').replace(/\/+$/, '');
    apiKey = cfg.custom_api_key || '';
    model = cfg.custom_model || '';
  } else {
    endpoint = (cfg.local_endpoint || config.lms_api || '').replace(/\/+$/, '');
  }

  try {
    let fullText = '';

    if (provider === 'google') {
      let historyText = '';
      for (const h of body.history || []) {
        historyText += `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}\n`;
      }
      const googleUserMsg = historyText + systemContent + '\n\n' + body.message;
      try {
        fullText = await callGoogle('', googleUserMsg, cfg);
      } catch (e: any) {
        send('error', { message: e.message || 'LLM 调用失败' });
        send('done', {});
        res.end();
        return;
      }
      const cleanText = fullText.replace(/\s*\[GEN:\s*.+?\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleanText) send('text', { content: cleanText });
    } else {
      let lastCleanLen = 0;
      try {
        await streamChat(messages, endpoint, apiKey, model, (delta) => {
          fullText += delta;
          const cleanFull = fullText
            .replace(/\s*\[GEN:\s*.+?\]\s*/g, '')
            .replace(/\s*\[GEN:\s*[^\]]*$/, '');
          const cleanDelta = cleanFull.slice(lastCleanLen);
          if (cleanDelta) {
            send('text', { content: cleanDelta });
            lastCleanLen = cleanFull.length;
          }
        });
      } catch (e: any) {
        send('error', { message: e.message || 'LLM 调用失败' });
        send('done', {});
        res.end();
        return;
      }
    }

    // 提取所有 [GEN: tags]，返回给前端，由前端调用 addToQueue 生图
    if (genEnabled) {
      const genRegex = /\[GEN:\s*(.+?)\]/g;
      const genTagsList: string[] = [];
      let m;
      while ((m = genRegex.exec(fullText)) !== null) {
        genTagsList.push(m[1].trim());
      }
      if (genTagsList.length > 0) {
        send('gen_tags', { tags: genTagsList });
      }
    }

    // Token 计费
    let llmCost = 0;
    let llmTokens = 0;
    let genCount = 0;
    try {
      const ptCfg = loadPointsCfg();
      const tokenPerPoint = ptCfg.llm_token_per_point || 1000;
      let totalTokens = estimateTokens(systemContent);
      for (const h of body.history || []) totalTokens += estimateTokens(h.content);
      totalTokens += estimateTokens(body.message);
      totalTokens += estimateTokens(fullText);
      llmTokens = totalTokens;
      llmCost = Math.max(1, Math.ceil(totalTokens / tokenPerPoint));
      await deductPoints(user.id, llmCost);
    } catch {}

    send('done', { llm_cost: llmCost, llm_tokens: llmTokens, gen_count: genCount });
  } catch (e: any) {
    send('error', { message: e.message || '未知错误' });
    send('done', {});
  }

  res.end();
});

// ==================== 角色预设 CRUD ====================

interface ChatPreset {
  id: string;
  name: string;
  systemPrompt: string;
}

type PresetStore = Record<number, ChatPreset[]>;

function presetsFile(): string {
  return path.join(path.dirname(config.creator_map_file), 'chat_presets.json');
}

function loadAllPresets(): PresetStore {
  return loadJson<PresetStore>(presetsFile(), {});
}

async function saveAllPresets(data: PresetStore): Promise<boolean> {
  return saveJson(presetsFile(), data);
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// GET /api/draw/chat-presets
router.get('/chat-presets', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: '未登录' });

  const all = loadAllPresets();
  const items = all[user.id] || [];
  res.json({ items });
});

// POST /api/draw/chat-presets
router.post('/chat-presets', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: '未登录' });

  const { name, systemPrompt } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ detail: '角色名不能为空' });
  if (!systemPrompt?.trim()) return res.status(400).json({ detail: '角色设定不能为空' });

  const all = loadAllPresets();
  const list = all[user.id] || [];
  const existing = list.findIndex(p => p.name === name.trim());
  const preset: ChatPreset = { id: existing >= 0 ? list[existing].id : genId(), name: name.trim(), systemPrompt: systemPrompt.trim() };
  if (existing >= 0) list[existing] = preset;
  else list.push(preset);
  all[user.id] = list;
  await saveAllPresets(all);
  res.json({ ok: true, preset });
});

// DELETE /api/draw/chat-presets/:id
router.delete('/chat-presets/:id', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: '未登录' });

  const id = req.params.id;
  const all = loadAllPresets();
  const list = (all[user.id] || []).filter(p => p.id !== id);
  all[user.id] = list;
  await saveAllPresets(all);
  res.json({ ok: true });
});

// ==================== 聊天记录 ====================

interface ChatHistoryMessage {
  role: string;
  content: string;
  imageUrls?: string[];
}

type HistoryStore = Record<number, ChatHistoryMessage[]>;

const MAX_HISTORY = 500;

function historyFile(): string {
  return path.join(path.dirname(config.creator_map_file), 'chat_history.json');
}

function loadAllHistory(): HistoryStore {
  return loadJson<HistoryStore>(historyFile(), {});
}

function saveAllHistory(data: HistoryStore): void {
  try { saveJson(historyFile(), data); } catch {}
}

// GET /api/draw/chat-history
router.get('/chat-history', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: '未登录' });

  const all = loadAllHistory();
  const items = all[user.id] || [];
  res.json({ items });
});

// POST /api/draw/chat-history — 追加消息
router.post('/chat-history', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: '未登录' });

  const messages = req.body?.messages as ChatHistoryMessage[];
  if (!Array.isArray(messages)) return res.status(400).json({ detail: 'messages 必须是数组' });

  const all = loadAllHistory();
  const list = all[user.id] || [];
  list.push(...messages);
  // 最多保留 MAX_HISTORY 条
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
  all[user.id] = list;
  saveAllHistory(all);
  res.json({ ok: true, total: list.length });
});

// DELETE /api/draw/chat-history — 清空
router.delete('/chat-history', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: '未登录' });

  const all = loadAllHistory();
  delete all[user.id];
  saveAllHistory(all);
  res.json({ ok: true });
});

export { router as chatRouter };
