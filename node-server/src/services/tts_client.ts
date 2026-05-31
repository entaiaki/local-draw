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
