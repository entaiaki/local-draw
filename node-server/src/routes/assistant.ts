import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import axios from 'axios';

const router = Router();

// ── 配置 ──
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '..', '..', '..', 'web');
const CHARS_FILE = path.join(WEB_DIR, 'characters.json');
const STYLES_DIR = path.join(WEB_DIR, 'styles');
const RES_FILE = path.join(WEB_DIR, 'resolutions.json');
const LLM_CONFIG = path.join(WEB_DIR, 'llm_config.json');
const POINTS_CONFIG = path.join(WEB_DIR, 'points_config.json');
const WF_DIR = path.resolve(
  process.env.COMFYUI_BASE || 'E:\\AI\\ComfyUI-aki-v1.4\\ComfyUI-aki-v1.4',
  'user', 'default', 'workflows'
);

// ── 工具函数 ──
function loadJson<T>(fp: string, def: T): T {
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return def; }
}

function getCharacters(): any[] {
  return loadJson<{ characters: any[] }>(CHARS_FILE, { characters: [] }).characters;
}

function getResolutions(): Record<string, { width: number; height: number }> {
  return loadJson<Record<string, any>>(RES_FILE, {});
}

function getStyles(): string[] {
  try {
    if (!fs.existsSync(STYLES_DIR)) return [];
    return fs.readdirSync(STYLES_DIR)
      .filter(f => f.endsWith('.txt'))
      .map(f => f.replace(/\.txt$/, ''));
  } catch { return []; }
}

// ── LLM 调用（兼容 LM Studio / DeepSeek / OpenAI） ──
async function callLLM(system: string, user: string): Promise<string> {
  const cfg = loadJson<any>(LLM_CONFIG, {});
  const profile = cfg.profiles?.[cfg.active ?? 0] || {};
  const provider = profile.provider || 'local';
  
  let endpoint = profile.local_endpoint || 'http://127.0.0.1:1234/v1';
  let apiKey = profile.custom_api_key || '';
  let model = profile.custom_model || '';

  if (provider === 'custom' && profile.custom_endpoint) {
    endpoint = profile.custom_endpoint;
    apiKey = profile.custom_api_key || '';
    model = profile.custom_model || '';
  }

  const body = {
    model: model || 'qwen2.5-7b-instruct',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.3,
    max_tokens: 1024,
  };

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    
    const resp = await axios.post(`${endpoint}/chat/completions`, body, {
      headers, timeout: 30000,
    });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (e: any) {
    console.error('[assistant] LLM error:', e.message);
    return '';
  }
}

// ── 系统提示词 ──
function buildSystemPrompt(characters: any[], styles: string[], resolutions: Record<string, any>): string {
  const charList = characters.map(c => `- ${c.name}（触发词: ${c.trigger_tags?.join(', ') || '无'}）`).join('\n');
  const styleList = styles.join(', ');
  const resList = Object.entries(resolutions).map(([k, v]: any) => `- ${k}: ${v.width}x${v.height}`).join('\n');

  return `你是一个 AI 绘图助手，帮助用户选择角色、画风和生图参数。

## 可选角色
${charList}

## 可选画风
${styleList}

## 可选分辨率
${resList}

## 你的输出格式（不要解释，只输出 JSON）
{
  "reply": "对用户自然语言需求的简短中文回复",
  "workflow": "WAI",
  "character_name": "角色名（无则 null）",
  "style": "画风名（无则 null）",
  "resolution": "分辨率名（如横屏 16:9）",
  "positive": "英文 Danbooru tags，包含角色触发词和画面描述",
  "negative": "负面提示词英文 tags",
  "width": 1344,
  "height": 768
}`;
}

// ── POST /api/assistant/chat ──
router.post('/chat', async (req: Request, res: Response) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: '消息不能为空' });

  const characters = getCharacters();
  const styles = getStyles();
  const resolutions = getResolutions();
  const systemPrompt = buildSystemPrompt(characters, styles, resolutions);

  const fullUserPrompt = history?.length
    ? history.map((h: any) => `${h.role}: ${h.content}`).join('\n') + `\nuser: ${message}`
    : message;

  let llmOutput = '';
  try {
    llmOutput = await callLLM(systemPrompt, fullUserPrompt);
  } catch (e: any) {
    // LLM 失败时回退到模板
    llmOutput = JSON.stringify(fallbackCard(message, characters, styles, resolutions));
  }

  // 尝试解析 LLM 输出 JSON
  let card: any = null;
  try {
    const jsonMatch = llmOutput.match(/\{[\s\S]*\}/);
    if (jsonMatch) card = JSON.parse(jsonMatch[0]);
  } catch {}

  if (!card) {
    card = fallbackCard(message, characters, styles, resolutions);
  }

  // 补全缺失字段
  card.reply = card.reply || `好的，我来帮你画「${message}」`;
  card.workflow = card.workflow || 'WAI';
  card.style = card.style || null;
  card.resolution = card.resolution || '横屏 16:9';
  card.positive = card.positive || message;
  card.negative = card.negative || 'worst quality, low quality, blurry, bad anatomy, bad hands, watermark, text, jpeg artifacts, ugly, deformed';
  card.width = card.width || 1344;
  card.height = card.height || 768;

  res.json({
    reply: card.reply,
    card: {
      workflow_path: card.character_name
        ? `${card.workflow}/base/${card.character_name}.json`
        : `${card.workflow}/base/none.json`,
      positive: card.positive,
      negative: card.negative,
      width: card.width,
      height: card.height,
      style: card.style,
      character: card.character_name,
    }
  });
});

// ── LLM 失败时的回退逻辑 ──
function fallbackCard(message: string, chars: any[], styles: string[], res: Record<string, any>) {
  const lowerMsg = message.toLowerCase();
  
  // 匹配角色
  let matchedChar = null;
  for (const c of chars) {
    if (lowerMsg.includes(c.name.toLowerCase()) || 
        c.trigger_tags?.some((t: string) => lowerMsg.includes(t.toLowerCase()))) {
      matchedChar = c;
      break;
    }
  }
  
  // 匹配画风
  let matchedStyle = null;
  for (const s of styles) {
    if (lowerMsg.includes(s.toLowerCase())) {
      matchedStyle = s;
      break;
    }
  }
  
  // 匹配分辨率
  let matchedRes = '横屏 16:9';
  let w = 1344, h = 768;
  if (lowerMsg.includes('竖屏') || lowerMsg.includes('竖图') || lowerMsg.includes('portrait')) {
    matchedRes = '竖屏 9:16'; w = 768; h = 1344;
  } else if (lowerMsg.includes('方图') || lowerMsg.includes('方形') || lowerMsg.includes('square')) {
    matchedRes = '方图 1:1'; w = 1024; h = 1024;
  }

  // 构建正向提示词
  const posParts: string[] = ['masterpiece, best quality'];
  if (matchedChar?.trigger_tags) posParts.push(...matchedChar.trigger_tags.slice(0, 5));
  if (matchedStyle) {
    const styleFile = path.join(STYLES_DIR, `${matchedStyle}.txt`);
    try { posParts.push(fs.readFileSync(styleFile, 'utf-8').trim()); } catch {}
  }
  posParts.push(message);

  return {
    reply: matchedChar
      ? `我找到了角色「${matchedChar.name}」${matchedStyle ? `，搭配${matchedStyle}画风` : ''}，来看看效果如何？`
      : `我来试试画「${message}」`,
    workflow: 'WAI',
    character_name: matchedChar?.name || null,
    style: matchedStyle || null,
    resolution: matchedRes,
    positive: posParts.join(', '),
    negative: 'worst quality, low quality, blurry, bad anatomy, bad hands, watermark, text, jpeg artifacts, ugly, deformed',
    width: w,
    height: h,
  };
}

// ── GET /api/assistant/characters ── 角色列表供前端用
router.get('/characters', (_req: Request, res: Response) => {
  res.json({ characters: getCharacters() });
});

// ── GET /api/assistant/styles ── 画风列表
router.get('/styles', (_req: Request, res: Response) => {
  res.json({ styles: getStyles() });
});

export default router;
