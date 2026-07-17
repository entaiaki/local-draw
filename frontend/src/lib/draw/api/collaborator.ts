import { drawRequest } from './client';
import type { Nomination } from '../types';

export async function getAllImages(limit = 200, offset = 0) {
  return drawRequest<{ items: { path: string; mtime: number; user_id: string }[]; total: number }>('/api/draw/collaborator/images', { query: { limit, offset }, cache: 'no-cache' });
}

export async function getPendingRecommendations() {
  return drawRequest<{ items: import('../types').DrawRecommendation[]; total: number }>('/api/draw/collaborator/recommendations');
}

export async function submitNomination(imagePaths: string[], note?: string) {
  return drawRequest<{ ok: boolean; nomination: Nomination }>('/api/draw/collaborator/nominate', {
    method: 'POST',
    json: { image_paths: imagePaths, note: note || '' }
  });
}

export async function getMyNominations() {
  return drawRequest<{ items: Nomination[]; total: number }>('/api/draw/collaborator/nominations');
}
