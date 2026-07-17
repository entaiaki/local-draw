import { Router, Request, Response } from 'express';
import type { ChatRequest, ChatResponse, GeneratedCard } from '../types/assistant.js';

const router = Router();

/**
 * 简易尺寸解析：从用户输入推断横屏/竖屏/方图
 */
function parseSize(prompt: string): { width: number; height: number } {
  const lower = prompt.toLowerCase();
  if (lower.includes('横屏') || lower.includes('横图') || lower.includes('landscape')) {
    return { width: 1344, height: 768 };
  }
  if (lower.includes('竖屏') || lower.includes('竖图') || lower.includes('portrait')) {
    return { width: 768, height: 1344 };
  }
  if (lower.includes('方图') || lower.includes('方形') || lower.includes('square')) {
    return { width: 1024, height: 1024 };
  }
  // 默认横屏
  return { width: 1344, height: 768 };
}

/**
 * 从用户中文描述生成简易正向/负向 prompt
 */
function generatePrompts(prompt: string, mode: string): { positive: string; negative: string } {
  const negative = 'low quality, blurry, bad anatomy, watermark, text, jpeg artifacts, ugly, deformed, distorted';

  if (mode === 'wife') {
    const positive = `masterpiece, best quality, beautiful girlfriend, warm atmosphere, ${prompt}, soft lighting, detailed face, gentle expression, clean background`;
    return { positive, negative };
  }

  // professional mode
  const positive = `masterpiece, best quality, highly detailed, ${prompt}, professional lighting, sharp focus, high resolution, intricate details, award-winning composition`;
  return { positive, negative };
}

/**
 * 简易角色/画风识别
 */
function parseCharacterStyle(prompt: string): { character: string; style: string } {
  const chars: Record<string, string> = {
    '胡桃': '胡桃',
    '可莉': '可莉',
    '甘雨': '甘雨',
    '雷电将军': '雷电将军',
    '钟离': '钟离',
    '八重神子': '八重神子',
    '纳西妲': '纳西妲',
    '芙宁娜': '芙宁娜',
    '刻晴': '刻晴',
    '神里绫华': '神里绫华',
  };
  const styles: Record<string, string> = {
    '赛博朋克': '赛博朋克',
    '赛博': '赛博朋克',
    'cyberpunk': '赛博朋克',
    '古风': '古风',
    '现代': '现代',
    '校园': '校园',
    '水彩': '水彩',
    '油画': '油画',
    '像素': '像素',
    '暗黑': '暗黑',
    '蒸汽朋克': '蒸汽朋克',
    '科幻': '科幻',
    '写实': '写实',
    '二次元': '二次元',
    '动漫': '二次元',
    '日系': '日系',
    '韩系': '韩系',
  };

  let character = '';
  let style = '';

  for (const [key, val] of Object.entries(chars)) {
    if (prompt.includes(key)) { character = val; break; }
  }
  for (const [key, val] of Object.entries(styles)) {
    if (prompt.includes(key)) { style = val; break; }
  }

  return { character, style };
}

function buildCard(prompt: string, mode: string): GeneratedCard {
  const size = parseSize(prompt);
  const prompts = generatePrompts(prompt, mode);
  const cs = parseCharacterStyle(prompt);

  return {
    positivePrompt: prompts.positive,
    negativePrompt: prompts.negative,
    originalPrompt: prompt,
    workflowPath: 'Flux/默认文生图.json',
    width: size.width,
    height: size.height,
    styleTags: cs.style || '默认',
    mode: mode === 'wife' ? 'Flux' : 'Flux',
    character: cs.character,
    style: cs.style,
  };
}

router.post('/chat', (req: Request, res: Response) => {
  try {
    const { prompt, mode } = req.body as ChatRequest;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      const resp: ChatResponse = { success: false, message: '', error: '请输入画面描述' };
      res.status(400).json(resp);
      return;
    }

    const validModes: string[] = ['wife', 'professional'];
    const currentMode = validModes.includes(mode) ? mode : 'professional';

    const card = buildCard(prompt.trim(), currentMode);

    let message: string;
    if (currentMode === 'wife') {
      message = `好的老公~ 已经帮你准备好啦！角色${card.character ? '：' + card.character : ''}，画风：${card.style || '默认'}，尺寸：${card.width}x${card.height}`;
    } else {
      message = `参数配置完成。模式：${currentMode}，尺寸：${card.width}x${card.height}${card.character ? '，角色：' + card.character : ''}${card.style ? '，画风：' + card.style : ''}`;
    }

    const resp: ChatResponse = { success: true, message, card };
    res.json(resp);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '未知错误';
    const resp: ChatResponse = { success: false, message: '', error: msg };
    res.status(500).json(resp);
  }
});

export default router;
