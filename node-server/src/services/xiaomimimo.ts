import axios from 'axios';
import { loadConfig } from './config.js';

export interface TtsApiParams {
  text: string;
  mode: 'preset' | 'design' | 'clone';
  speaker?: string;
  instruct?: string;
  tags?: string;
  language?: string;
  /** base64 data URI of reference audio for clone mode */
  refAudioDataUri?: string;
}

export interface TtsApiResult {
  ok: boolean;
  wavBuffer: Buffer;
}

const API_URL = 'https://api.xiaomimimo.com/v1/chat/completions';

const MODEL_MAP: Record<string, string> = {
  preset: 'mimo-v2.5-tts',
  design: 'mimo-v2.5-tts-voicedesign',
  custom: 'mimo-v2.5-tts-voicedesign',
  clone: 'mimo-v2.5-tts-voiceclone',
};

const PRESET_VOICE_MAP: Record<string, string> = {
  'mimo_default': 'MiMo-默认',
  '冰糖': '冰糖',
  '茉莉': '茉莉',
  '苏打': '苏打',
  '白桦': '白桦',
  'Mia': 'Mia',
  'Chloe': 'Chloe',
  'Milo': 'Milo',
  'Dean': 'Dean',
};

export function getPresetVoices(): Array<{ id: string; description: string }> {
  return [
    { id: 'mimo_default', description: 'MiMo-默认' },
    { id: '冰糖', description: '冰糖（女）' },
    { id: '茉莉', description: '茉莉（女）' },
    { id: '苏打', description: '苏打（男）' },
    { id: '白桦', description: '白桦（男）' },
    { id: 'Mia', description: 'Mia (English Female)' },
    { id: 'Chloe', description: 'Chloe (English Female)' },
    { id: 'Milo', description: 'Milo (English Male)' },
    { id: 'Dean', description: 'Dean (English Male)' },
  ];
}

/**
 * 调用小米米莫 TTS API 生成语音
 */
export async function callTtsApi(params: TtsApiParams): Promise<TtsApiResult> {
  const config = loadConfig();
  const apiKey = config.mimo_api_key;
  if (!apiKey) throw new Error('MIMO_API_KEY 未配置');

  const model = MODEL_MAP[params.mode];
  if (!model) throw new Error('不支持的 TTS 模式: ' + params.mode);

  // 构造 messages
  const messages: Array<{ role: string; content: string }> = [];

  // user message: 风格/音色描述
  if (params.mode === 'design') {
    // 自定义音色模式：音色描述是必需的
    messages.push({ role: 'user', content: params.instruct || '自然的说话声' });
  } else if (params.instruct) {
    // 预设/克隆模式：instruct 作为自然语言风格描述
    messages.push({ role: 'user', content: params.instruct });
  }

  // 音频标签（tags）拼到合成文本开头
  let finalText = params.text;
  if (params.tags) {
    finalText = params.tags + (finalText ? ' ' + finalText : '');
  }

  // assistant message: 要合成的文本
  messages.push({ role: 'assistant', content: finalText });

  // 构造 audio 参数
  const audioParams: Record<string, any> = {
    format: 'wav',
  };

  if (params.mode === 'preset' && params.speaker) {
    // 预设模式：传音色 ID
    const voiceId = PRESET_VOICE_MAP[params.speaker] || params.speaker;
    audioParams.voice = voiceId;
  } else if (params.mode === 'clone' && params.refAudioDataUri) {
    // 克隆模式：传参考音频 base64 data URI
    audioParams.voice = params.refAudioDataUri;
  }

  const body = {
    model,
    messages,
    audio: audioParams,
  };

  const resp = await axios.post(API_URL, body, {
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    timeout: 60000,
    responseType: 'json',
    validateStatus: () => true, // 不抛异常，由我们检查状态码
  });

  if (resp.status !== 200) {
    const detail = typeof resp.data === 'object' ? JSON.stringify(resp.data).slice(0, 500) : String(resp.data).slice(0, 500);
    throw new Error(`TTS API 请求失败: ${resp.status} ${detail}`);
  }

  const audioData = resp.data?.choices?.[0]?.message?.audio?.data;
  if (!audioData) {
    throw new Error('TTS API 响应中未找到音频数据');
  }

  // base64 解码
  const wavBuffer = Buffer.from(audioData, 'base64');
  if (wavBuffer.length === 0) {
    throw new Error('TTS API 返回的音频数据为空');
  }

  return { ok: true, wavBuffer };
}

/**
 * 文件转 base64 data URI，用于声音克隆的参考音频
 */
export function fileToDataUri(filePath: string, mime: string): string {
  const fs = require('fs');
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');
  return `data:${mime};base64,${base64}`;
}

export function detectMimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
  };
  return map[ext.toLowerCase()] || 'audio/mpeg';
}
