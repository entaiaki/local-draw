import { drawRequest } from './client';
import type { LoraApplication } from '../types';

export async function submitLora(data: {
  url: string;
  name: string;
  category: string;
  trigger: string;
  type: string;
}) {
  return drawRequest<{ ok: boolean; application: LoraApplication }>('/api/lora/apply', {
    method: 'POST',
    json: data,
    requiresAuth: true,
  });
}

export async function getMyLoraSubmissions() {
  return drawRequest<{ items: LoraApplication[]; total: number }>(
    '/api/lora/my-submissions',
    { requiresAuth: true }
  );
}

export async function getPendingLoraSubmissions() {
  return drawRequest<{ items: LoraApplication[]; total: number }>(
    '/api/lora/admin/pending',
    { requiresAuth: true }
  );
}

export async function approveLora(id: string) {
  return drawRequest<{ ok: boolean }>('/api/lora/admin/approve', {
    method: 'POST',
    json: { id },
    requiresAuth: true,
  });
}

export async function rejectLora(id: string) {
  return drawRequest<{ ok: boolean }>('/api/lora/admin/reject', {
    method: 'POST',
    json: { id },
    requiresAuth: true,
  });
}

export async function cancelLora(id: string) {
  return drawRequest<{ ok: boolean }>('/api/lora/cancel', {
    method: 'POST',
    json: { id },
    requiresAuth: true,
  });
}
