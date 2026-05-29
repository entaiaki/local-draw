import { Router, Request, Response } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { loadConfig, loadJson, saveJson } from '../services/config.js';
import { streamChat, callGoogle, estimateTokens } from '../services/llm.js';
import { deductPoints, loadPointsCfg } from './wallet.js';
import path from 'path';
import crypto from 'crypto';

const router = Router();
const config = loadConfig();

// 聊天冷却：用户 ID → 上次请求时间
const _chatCooldown: Record<number, number> = {};

// 定期清理冷却记录（每 10 分钟）
setInterval(() => {
  const cutoff = Date.now() - 600_000;
  for (const [k, v] of Object.entries(_chatCooldown)) {
    if (v < cutoff) delete _chatCooldown[k];
  }
}, 600_000).unref();

// ==================== 常量 ====================

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

const GEN_INSTRUCTION_ANIMA = `你可以在对话中自然地生成图片。在回复中插入生图标记：
[GEN: 英文自然语言描述]

重要：[GEN: ...] 标记是系统指令，用户完全看不到它。不要在文字中提及、解释或引用 [GEN:] 标记。

生图规则：
- 每说完一句话（以句号、感叹号、问号等结束），立即插入对应的 [GEN: ...] 标记
- 每句对话都配一张图，不要跳过
- 用英文自然语言（长句子）详细描述当前这句话对应的画面，包括角色外观、动作、表情、场景、光线等
- 以角色扮演的方式自然回复，[GEN:] 标记穿插在文本中，但用户看不到它们`;

const MAX_HISTORY_MESSAGES = 40;
const MAX_SYSTEM_PROMPT_LEN = 5000;
const MAX_MESSAGE_LEN = 2000;
const MAX_HISTORY_ITEM_CONTENT_LEN = 4000;
const COOLDOWN_MS = 3000;

// ==================== 校验工具 ====================

function isValidRole(r: unknown): r is string {
  return r === 'user' || r === 'assistant';
}

function sanitizeStr(v: unknown, maxLen: number): string {
  if (typeof v !== 'string') return '';
  return v.slice(0, maxLen);
}

function isSafeWorkflowPath(p: string): boolean {
  if (!p || p.length > 300) return false;
  if (p.includes('\0')) return false;
  // 禁止绝对路径和路径遍历
  if (path.isAbsolute(p)) return false;
  const normalized = path.normalize(p);
  if (normalized.startsWith('..') || normalized.includes(`${path.sep}..`)) return false;
  return true;
}

function getActiveProfile(): Record<string, any> {
  const d = loadJson<any>(config.llm_config_file, {});
  const profiles = d.profiles || [];
  const active = d.active ?? 0;
  return profiles[active] || {};
}

function genId(): string {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// ==================== 聊天端点 ====================

router.post('/chat', async (req: Request, res: Response) => {
  // 认证
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: '论坛登录凭证已过期，请刷新页面或重新登录' });
  if (user.role !== 'admin' && user.role !== 'user') return res.status(403).json({ detail: '已禁止使用酒馆' });

  // 输入校验
  const rawBody = req.body;
  if (!rawBody || typeof rawBody !== 'object') return res.status(400).json({ detail: '请求格式错误' });

  const systemPrompt = sanitizeStr(rawBody.system_prompt, MAX_SYSTEM_PROMPT_LEN).trim();
  if (!systemPrompt) return res.status(400).json({ detail: '请填写角色设定' });

  const message = sanitizeStr(rawBody.message, MAX_MESSAGE_LEN).trim();
  if (!message) return res.status(400).json({ detail: '消息不能为空' });

  const workflowPath = sanitizeStr(rawBody.workflow_path, 300);
  const styleTags = sanitizeStr(rawBody.style_tags, 500);
  const negativePrompt = sanitizeStr(rawBody.negative_prompt, 1000);
  const workflowPrompt = sanitizeStr(rawBody.workflow_prompt, 2000) || '(无)';
  const genEnabled = rawBody.gen_enabled !== false;
  const mode = rawBody.mode === 'anima' ? 'anima' : 'wai';

  // history 校验：限数量、限长度、校验 role
  const rawHistory = Array.isArray(rawBody.history) ? rawBody.history : [];
  const history: Array<{ role: string; content: string }> = [];
  for (const h of rawHistory.slice(-MAX_HISTORY_MESSAGES)) {
    if (!isValidRole(h.role)) continue;
    const c = sanitizeStr(h.content, MAX_HISTORY_ITEM_CONTENT_LEN);
    if (c) history.push({ role: h.role, content: c });
  }

  // workflow_path 安全校验
  if (workflowPath && !isSafeWorkflowPath(workflowPath)) {
    return res.status(400).json({ detail: '工作流路径不合法' });
  }

  // 冷却检查
  const now = Date.now();
  const last = _chatCooldown[user.id] || 0;
  if (now - last < COOLDOWN_MS) {
    return res.status(429).json({ detail: `请 ${Math.ceil((COOLDOWN_MS - (now - last)) / 1000)} 秒后再试` });
  }
  _chatCooldown[user.id] = now;

  // 构建 system prompt
  const negRef = negativePrompt || 'worst quality, low quality, blurry';
  const systemContent = CHAT_SYSTEM_TEMPLATE
    .replace('{role_setup}', systemPrompt)
    .replace('{gen_instruction}', genEnabled ? (mode === 'anima' ? GEN_INSTRUCTION_ANIMA : GEN_INSTRUCTION) : '以角色扮演的方式自然回复用户。不要在回复中提及任何技术标记或生图指令。')
    .replace('{workflow_prompt}', workflowPrompt)
    .replace('{negative_ref}', negRef);

  // 构建 messages
  const messages: Array<{ role: string; content: string }> = [];
  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: systemContent + '\n\n' + message });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // SSE 写入安全封装
  let clientDisconnected = false;
  res.on('close', () => { clientDisconnected = true; });

  function send(event: string, data: unknown) {
    if (clientDisconnected) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {}
  }

  // LLM 配置
  const cfg = getActiveProfile();
  const provider = cfg.provider || 'custom';

  let endpoint = '';
  let apiKey = '';
  let model = '';
  if (provider === 'google') {
    apiKey = cfg.google_api_key || '';
    model = cfg.google_model || '';
  } else if (provider === 'custom') {
    endpoint = sanitizeStr(cfg.custom_endpoint, 500).replace(/\/+$/, '');
    apiKey = sanitizeStr(cfg.custom_api_key, 500);
    model = sanitizeStr(cfg.custom_model, 200);
  } else {
    endpoint = sanitizeStr(cfg.local_endpoint || config.lms_api, 500).replace(/\/+$/, '');
  }

  // 调用 LLM
  let fullText = '';
  try {
    if (provider === 'google') {
      let historyText = '';
      for (const h of history) {
        historyText += `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}\n`;
      }
      const googleUserMsg = historyText + systemContent + '\n\n' + message;
      try {
        fullText = await callGoogle('', googleUserMsg, cfg);
      } catch (e: any) {
        send('error', { message: e.message || 'LLM 调用失败' });
        send('done', {});
        res.end();
        return;
      }
      const cleanText = fullText.replace(/\s*\[GEN[:\s].+?[\]）]\s*/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleanText) send('text', { content: cleanText });
    } else {
      let lastCleanLen = 0;
      try {
        await streamChat(messages, endpoint, apiKey, model, (delta) => {
          fullText += delta;
          const cleanFull = fullText
            .replace(/\s*\[GEN[:\s].+?\]\s*/g, '')
            .replace(/\s*\[GEN[:\s].+?）\s*/g, '')
            .replace(/\s*\[GEN[:\s][^\]）]*$/, '');
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
  } catch (e: any) {
    send('error', { message: e.message || '未知错误' });
    send('done', {});
    res.end();
    return;
  }

  // 提取 [GEN: tags]
  let genCount = 0;
  if (genEnabled) {
    const genRegex = /\[GEN[:\s]\s*(.+?)[\]）]/g;
    const genTagsList: string[] = [];
    let m;
    while ((m = genRegex.exec(fullText)) !== null) {
      const tags = m[1].trim();
      if (tags && tags.length < 1000) genTagsList.push(tags);
    }
    if (genTagsList.length > 0) {
      genCount = genTagsList.length;
      send('gen_tags', { tags: genTagsList });
    }
  }

  // Token 计费（LLM 成功后才扣费）
  let llmCost = 0;
  let llmTokens = 0;
  try {
    const ptCfg = loadPointsCfg();
    const tokenPerPoint = ptCfg.llm_token_per_point || 1000;
    let totalTokens = estimateTokens(systemContent);
    for (const h of history) totalTokens += estimateTokens(h.content);
    totalTokens += estimateTokens(message);
    totalTokens += estimateTokens(fullText);
    llmTokens = totalTokens;
    llmCost = Math.max(1, Math.ceil(totalTokens / tokenPerPoint));
    const deductResult = await deductPoints(user.id, llmCost);
    if (!deductResult?.ok) {
      send('error', { message: `扣点失败：${deductResult?.error || '余额不足'}` });
    }
  } catch (e: any) {
    send('error', { message: `计费异常：${e.message || '未知'}` });
  }

  send('done', { llm_cost: llmCost, llm_tokens: llmTokens, gen_count: genCount });
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

function saveAllPresets(data: PresetStore): void {
  try { saveJson(presetsFile(), data); } catch {}
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

  const { name: rawName, systemPrompt: rawSp } = req.body || {};
  const name = sanitizeStr(rawName, 100).trim();
  const systemPrompt = sanitizeStr(rawSp, MAX_SYSTEM_PROMPT_LEN).trim();
  if (!name) return res.status(400).json({ detail: '角色名不能为空' });
  if (!systemPrompt) return res.status(400).json({ detail: '角色设定不能为空' });

  const all = loadAllPresets();
  const list = all[user.id] || [];
  // 限制每用户最多 50 个预设
  if (list.length >= 50) return res.status(429).json({ detail: '预设数量已达上限（50）' });
  const existing = list.findIndex(p => p.name === name);
  const preset: ChatPreset = { id: existing >= 0 ? list[existing].id : genId(), name, systemPrompt };
  if (existing >= 0) list[existing] = preset;
  else list.push(preset);
  all[user.id] = list;
  saveAllPresets(all);
  res.json({ ok: true, preset });
});

// DELETE /api/draw/chat-presets/:id
router.delete('/chat-presets/:id', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: '未登录' });

  const id = sanitizeStr(req.params.id, 50);
  if (!id) return res.status(400).json({ detail: 'id 不能为空' });
  const all = loadAllPresets();
  const before = (all[user.id] || []).length;
  all[user.id] = (all[user.id] || []).filter(p => p.id !== id);
  if (all[user.id].length === before) return res.status(404).json({ detail: '预设不存在' });
  saveAllPresets(all);
  res.json({ ok: true });
});

// ==================== 聊天记录 ====================

interface ChatHistoryMessage {
  role: string;
  content: string;
  imageUrls?: string[];
  systemPrompt?: string;
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

  const rawMessages = req.body?.messages;
  if (!Array.isArray(rawMessages)) return res.status(400).json({ detail: 'messages 必须是数组' });

  // 校验每条消息
  const validMessages: ChatHistoryMessage[] = [];
  for (const m of rawMessages.slice(0, 10)) { // 单次最多追加 10 条
    if (!isValidRole(m.role)) continue;
    const content = sanitizeStr(m.content, MAX_HISTORY_ITEM_CONTENT_LEN);
    if (!content) continue;
    const item: ChatHistoryMessage = { role: m.role, content };
    if (Array.isArray(m.imageUrls)) {
      item.imageUrls = m.imageUrls.filter((u: unknown) => typeof u === 'string' && u.length < 2000).slice(0, 20);
    }
    if (typeof m.systemPrompt === 'string' && m.systemPrompt.length <= MAX_SYSTEM_PROMPT_LEN) {
      item.systemPrompt = m.systemPrompt;
    }
    validMessages.push(item);
  }

  if (validMessages.length === 0) return res.status(400).json({ detail: '无有效消息' });

  const all = loadAllHistory();
  const list = all[user.id] || [];
  list.push(...validMessages);
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
