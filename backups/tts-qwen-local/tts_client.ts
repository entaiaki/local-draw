import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.js';

const TTS_SERVER = process.env.TTS_SERVER || 'http://127.0.0.1:50052';
const COMFY = process.env.COMFYUI_HOST || '127.0.0.1';
const COMFY_PORT = process.env.COMFYUI_PORT || '8188';

export interface TtsGenerateParams {
  audioPath: string;
  text: string;
  refText?: string;
  xVectorMode?: boolean;
  language?: string;
}

export interface TtsGenerateResult {
  ok: boolean;
  output_path: string;
  sample_rate: number;
}

export interface TtsCustomVoiceParams {
  text: string;
  speaker: string;
  language?: string;
  instruct?: string;
}

export async function callTtsGenerate(params: TtsGenerateParams): Promise<TtsGenerateResult> {
  const fd = new FormData();
  fd.append('file', fs.createReadStream(params.audioPath));
  fd.append('text', params.text);
  if (params.refText) fd.append('ref_text', params.refText);
  fd.append('x_vector_mode', params.xVectorMode ? 'true' : 'false');
  fd.append('language', params.language || 'auto');

  const resp = await axios.post<TtsGenerateResult>(`${TTS_SERVER}/generate`, fd, {
    headers: fd.getHeaders(),
    timeout: 120000,
  });
  return resp.data;
}

export async function callTtsCustomVoice(params: TtsCustomVoiceParams): Promise<TtsGenerateResult> {
  const fd = new FormData();
  fd.append('text', params.text);
  fd.append('speaker', params.speaker);
  fd.append('language', params.language || 'auto');
  if (params.instruct) fd.append('instruct', params.instruct);

  const resp = await axios.post<TtsGenerateResult>(`${TTS_SERVER}/generate_custom_voice`, fd, {
    headers: fd.getHeaders(),
    timeout: 120000,
  });
  return resp.data;
}

export async function fetchSpeakers(): Promise<{ speakers: Array<{ id: string; description: string }> }> {
  const resp = await axios.get(`${TTS_SERVER}/speakers`, { timeout: 5000 });
  return resp.data;
}

/** 通过 ComfyUI 工作流生成 TTS */
export async function callTtsViaComfy(params: TtsCustomVoiceParams): Promise<TtsGenerateResult> {
  const config = loadConfig();
  const wfPath = path.join(config.workflows_dir, 'TTS', 'Qwen3-TTS声音克隆等.json');
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));

  // 注入参数到 Qwen3CustomVoice 节点
  for (const [, nd] of Object.entries(wf)) {
    const node = nd as any;
    if (node.class_type === 'Qwen3CustomVoice' && node.inputs) {
      node.inputs.text = params.text;
      if (params.language) node.inputs.language = params.language;
      if (params.speaker) node.inputs.speaker = params.speaker;
      if (params.instruct) node.inputs.instruct = params.instruct;
      node.inputs.seed = Math.floor(Math.random() * 2147483647) + 1;
    }
  }

  // 提交到 ComfyUI
  const comfyUrl = `http://${COMFY}:${COMFY_PORT}`;
  const submit = await axios.post(`${comfyUrl}/api/prompt`, { prompt: wf }, {
    headers: { 'Comfy-User': '' }, timeout: 30000,
  });
  const promptId = submit.data.prompt_id;

  // 等待完成
  for (let i = 0; i < 600; i++) {
    try {
      const r = await axios.get(`${comfyUrl}/api/history/${promptId}`, { timeout: 10000 });
      const h = r.data[promptId];
      if (!h) { await sleep(1000); continue; }

      // 检查 ComfyUI 执行错误
      if (h.error) {
        throw new Error(`ComfyUI 生成失败: ${h.error.details || h.error.message || JSON.stringify(h.error)}`);
      }

      // 提取音频文件
      const audioPath = findAudioFromHistory(h.outputs, config.output_dir);
      if (audioPath) {
        return { ok: true, output_path: audioPath, sample_rate: 24000 };
      }

      throw new Error('ComfyUI 生成完成但未找到音频输出文件');
    } catch (e: any) {
      if (e.message && (e.message.includes('ComfyUI') || e.message.includes('音频输出'))) throw e;
      // axios 错误或 history 未就绪，继续轮询
    }
    await sleep(1000);
  }
  throw new Error('TTS 生成超时');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function findAudioFromHistory(outputs: any, outputDir: string): string | null {
  const comfyBase = path.dirname(outputDir); // ComfyUI 根目录
  const tempDir = path.join(comfyBase, 'temp');

  for (const [, out] of Object.entries(outputs || {})) {
    const o = out as any;
    for (const key of ['audio', 'audios']) {
      const list = o[key];
      if (!list) continue;
      const items = Array.isArray(list) ? list : [list];
      for (const item of items) {
        // item 可能是字符串 "filename.wav" 或对象 {filename, subfolder, type}
        const fn = typeof item === 'string' ? item : item?.filename;
        if (!fn || typeof fn !== 'string') continue;

        const subfolder = typeof item === 'object' ? (item.subfolder || '') : '';
        const type = typeof item === 'object' ? (item.type || 'output') : 'output';

        // 根据 type 选择基础目录
        const baseDir = type === 'temp' ? tempDir : outputDir;

        // 优先尝试纯文件名（无子目录情况）
        const candidates: string[] = [path.join(baseDir, subfolder, fn)];
        // 如果 subfolder 非空，也试一下直接根目录
        if (subfolder) candidates.push(path.join(baseDir, fn));
        // 如果文件不存在且扩展名不是 .wav，尝试 .wav
        if (!fn.toLowerCase().endsWith('.wav')) {
          const baseName = fn.replace(/\.[^.]+$/, '');
          candidates.push(path.join(baseDir, subfolder, `${baseName}.wav`));
          if (subfolder) candidates.push(path.join(baseDir, `${baseName}.wav`));
        }
        // 如果文件不存在且扩展名不是 .flac，尝试 .flac
        if (!fn.toLowerCase().endsWith('.flac')) {
          const baseName = fn.replace(/\.[^.]+$/, '');
          candidates.push(path.join(baseDir, subfolder, `${baseName}.flac`));
          if (subfolder) candidates.push(path.join(baseDir, `${baseName}.flac`));
        }

        for (const p of candidates) {
          if (fs.existsSync(p)) return p;
        }
      }
    }
  }
  return null;
}
