import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';

const TTS_SERVER = process.env.TTS_SERVER || 'http://127.0.0.1:50052';

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
