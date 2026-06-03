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
      if (h) {
        // 提取音频文件
        const outs = h.outputs || {};
        for (const [, out] of Object.entries(outs)) {
          const o = out as any;
          for (const key of ['audio', 'audios']) {
            const list = o[key];
            if (list) {
              for (const item of (Array.isArray(list) ? list : [list])) {
                const fn = item.filename || item;
                if (typeof fn === 'string') {
                  const outPath = path.join(config.output_dir, fn);
                  if (fs.existsSync(outPath)) {
                    return { ok: true, output_path: outPath, sample_rate: 24000 };
                  }
                }
              }
            }
          }
        }
        // 没有找到音频文件也返回成功（文件可能在子目录）
        return { ok: true, output_path: '', sample_rate: 24000 };
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('TTS 生成超时');
}
