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

const GEN_INSTRUCTION = `你可以在回复结束时生成一张图片。在回复末尾插入生图标记：
[GEN: 动作、表情、场景的英文Danbooru tags]

重要：[GEN: ...] 标记是系统指令，用户完全看不到它。不要在文字中提及、解释或引用 [GEN:] 标记。

生图规则：
- 每条回复只能在末尾生成**恰好一个** [GEN: ...] 标记，不要多
- [GEN:] 中只写动作、表情、姿势、场景、光线等描述，不要写角色外貌（系统会自动补充）
- tags 用英文 Danbooru 格式，用逗号分隔。要具体：例如 camera angle, expression details, lighting, background, action
- tags 要贴合当前对话的上下文和情绪，不要用泛泛的标签
- 以角色扮演的方式自然回复，[GEN:] 标记放在回复的最末尾`;

const GEN_INSTRUCTION_ANIMA = `你可以在回复结束时生成一张图片。在回复末尾插入生图标记：
[GEN: 动作、表情、场景的英文自然语言描述]

重要：[GEN: ...] 标记是系统指令，用户完全看不到它。不要在文字中提及、解释或引用 [GEN:] 标记。

生图规则：
- 每条回复只能在末尾生成**恰好一个** [GEN: ...] 标记，不要多
- [GEN:] 中只描述动作、表情、姿势、场景、光线等，不要描述角色外貌（系统会自动补充）
- 用英文自然语言（长句子）详细描述。要具体：camera angle, lighting, background details, emotional expression
- 描述要贴合当前对话的上下文和情绪，不要用泛泛的词语
- 以角色扮演的方式自然回复，[GEN:] 标记放在回复的最末尾`;

const NUDGE_INSTRUCTION = `你正在和用户进行角色扮演。用户暂时没有回复，请以角色的身份生成一段简短（1-2句）的主动消息来推动对话。

你可以：
- 倒计时：比如「我数到5」
- 催促用户回应：比如「你还在吗？」
- 质问用户为什么犹豫：比如「怎么，怕了？」
- 挑逗或勾引用户继续：比如「你不想看看接下来会发生什么吗？」
- 以角色特有的方式威胁或挑战用户

要求：
- 语气完全符合角色设定
- 简短有力，1-2句足够
- 不要提及你是AI或这只是在角色扮演
- 如果场景有明显变化（表情、姿势、环境），可以在末尾加 [GEN: 英文 tags]`;

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

  // 构建原生多轮消息（system + history + 当前消息），代替文本拼接
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemContent },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  // Google API 不支持 system role，仍用拼接方式
  const fullPrompt = systemContent + '\n\n' + history.map(h => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`).join('\n') + `\n用户: ${message}`;

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
      try {
        fullText = await callGoogle('', fullPrompt, cfg);
      } catch (e: any) {
        send('error', { message: e.message || 'LLM 调用失败' });
        send('done', {});
        res.end();
        return;
      }
      const cleanText = fullText.replace(/\s*\[GEN[^\]）]*[\]）]\s*/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleanText) send('text', { content: cleanText });
    } else {
      let lastCleanLen = 0;
      try {
        await streamChat(messages, endpoint, apiKey, model, (delta) => {
          fullText += delta;
          const cleanFull = fullText
            .replace(/\s*\[GEN[:\s].+?\]\s*/g, '')
            .replace(/\s*\[GEN[:\s].+?）\s*/g, '')
            .replace(/\s*\[GEN[^\]]*\]\s*/g, '')
            .replace(/\s*\[GEN[^）]*）\s*/g, '')
            .replace(/\s*\[GEN[^\]）]*$/, '');
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

  // 提取 [GEN: tags] — 最多 1 个
  let genCount = 0;
  if (genEnabled) {
    const genRegex = /\[GEN[:\s]\s*(.+?)[\]）]/;
    const m = genRegex.exec(fullText);
    if (m) {
      const tags = m[1].trim();
      if (tags && tags.length < 1000) {
        genCount = 1;
        send('gen_tags', { tags: [tags] });
      }
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

  send('done', { llm_cost: llmCost, llm_tokens: llmTokens, gen_count: genCount, raw_text: fullText });
  res.end();
});

// ==================== 主动沉浸（Nudge）端点 ====================

router.post('/chat/nudge', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: '论坛登录凭证已过期，请刷新页面或重新登录' });
  if (user.role !== 'admin' && user.role !== 'user') return res.status(403).json({ detail: '已禁止使用酒馆' });

  const rawBody = req.body;
  if (!rawBody || typeof rawBody !== 'object') return res.status(400).json({ detail: '请求格式错误' });

  const systemPrompt = sanitizeStr(rawBody.system_prompt, MAX_SYSTEM_PROMPT_LEN).trim();
  if (!systemPrompt) return res.status(400).json({ detail: '请填写角色设定' });

  const workflowPrompt = sanitizeStr(rawBody.workflow_prompt, 2000) || '(无)';
  const negativePrompt = sanitizeStr(rawBody.negative_prompt, 1000);
  const mode = rawBody.mode === 'anima' ? 'anima' : 'wai';

  const rawHistory = Array.isArray(rawBody.history) ? rawBody.history : [];
  const history: Array<{ role: string; content: string }> = [];
  for (const h of rawHistory.slice(-MAX_HISTORY_MESSAGES)) {
    if (!isValidRole(h.role)) continue;
    const c = sanitizeStr(h.content, MAX_HISTORY_ITEM_CONTENT_LEN);
    if (c) history.push({ role: h.role, content: c });
  }

  if (history.length === 0) return res.status(400).json({ detail: '没有对话历史' });

  const negRef = negativePrompt || 'worst quality, low quality, blurry';
  const nudgeSystemContent = NUDGE_INSTRUCTION + '\n\n角色设定：\n' + systemPrompt + '\n\n工作流自带提示词：' + workflowPrompt + '\n\n负面提示词参考：' + negRef;

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: nudgeSystemContent },
    ...history.map(h => ({ role: h.role, content: h.content })),
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientDisconnected = false;
  res.on('close', () => { clientDisconnected = true; });

  function send(event: string, data: unknown) {
    if (clientDisconnected) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  }

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

  let fullText = '';
  try {
    if (provider === 'google') {
      const fullPrompt = nudgeSystemContent + '\n\n' + history.map(h => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`).join('\n');
      fullText = await callGoogle('', fullPrompt, cfg);
      const cleanText = fullText.replace(/\s*\[GEN[^\]）]*[\]）]\s*/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleanText) send('text', { content: cleanText });
    } else {
      let lastCleanLen = 0;
      await streamChat(messages, endpoint, apiKey, model, (delta) => {
        fullText += delta;
        const cleanFull = fullText
          .replace(/\s*\[GEN[:\s].+?\]\s*/g, '')
          .replace(/\s*\[GEN[:\s].+?）\s*/g, '')
          .replace(/\s*\[GEN[^\]]*\]\s*/g, '')
          .replace(/\s*\[GEN[^）]*）\s*/g, '')
          .replace(/\s*\[GEN[^\]）]*$/, '');
        const cleanDelta = cleanFull.slice(lastCleanLen);
        if (cleanDelta) { send('text', { content: cleanDelta }); lastCleanLen = cleanFull.length; }
      });
    }
  } catch (e: any) {
    send('error', { message: e.message || '调用失败' });
    send('done', {});
    res.end();
    return;
  }

  let genCount = 0;
  const genRegex = /\[GEN[:\s]\s*(.+?)[\]）]/;
  const m = genRegex.exec(fullText);
  if (m) { const tags = m[1].trim(); if (tags && tags.length < 1000) { genCount = 1; send('gen_tags', { tags: [tags] }); } }

  let llmCost = 0;
  let llmTokens = 0;
  try {
    const ptCfg = loadPointsCfg();
    const tokenPerPoint = ptCfg.llm_token_per_point || 1000;
    let totalTokens = estimateTokens(nudgeSystemContent);
    for (const h of history) totalTokens += estimateTokens(h.content);
    totalTokens += estimateTokens(fullText);
    llmTokens = totalTokens;
    llmCost = Math.max(1, Math.ceil(totalTokens / tokenPerPoint));
    await deductPoints(user.id, llmCost);
  } catch {}

  send('done', { llm_cost: llmCost, llm_tokens: llmTokens, gen_count: genCount, raw_text: fullText });
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
