import axios from 'axios';
import { AppConfig } from './config.js';

let clientId = '';

export function initComfyUI(config: AppConfig) {
  clientId = require('uuid').v4().replace(/-/g, '');
  const baseURL = config.comfyui_api;

  const api = axios.create({
    baseURL,
    timeout: 600000,
    headers: { 'Comfy-User': '' },
  });

  return api;
}

export function getClientId() {
  if (!clientId) {
    clientId = require('uuid').v4().replace(/-/g, '');
  }
  return clientId;
}

export async function getQueue(api: ReturnType<typeof axios.create>) {
  const res = await api.get('/api/queue');
  return res.data;
}

export async function getHistory(api: ReturnType<typeof axios.create>, promptId: string) {
  const res = await api.get(`/api/history/${promptId}`);
  return res.data;
}

export async function submitPrompt(api: ReturnType<typeof axios.create>, prompt: Record<string, unknown>) {
  const res = await api.post('/api/prompt', {
    client_id: getClientId(),
    prompt,
    extra_data: { preview_method: 'auto' },
  });
  return res.data.prompt_id as string;
}

export async function uploadImage(api: ReturnType<typeof axios.create>, filename: string, buffer: Buffer, contentType: string) {
  const formData = new FormData();
  const blob = new Blob([buffer], { type: contentType });
  formData.append('image', blob, filename);
  formData.append('type', 'input');
  formData.append('overwrite', 'true');

  const res = await api.post('/api/upload/image', formData, {
    headers: { 'Content-Type': 'multipart/form-data', 'Comfy-User': '' },
  });
  return res.data.name as string;
}
