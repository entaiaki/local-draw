import { drawRequest } from './client';
import type {
  AdminRecentImage,
  AdminReport,
  AdminLimits,
  AdminAnnouncement,
  AdminGcResult,
  AdminLlmConfig,
  DrawRecommendation,
  Nomination
} from '../types';

// --- Featured ---

export async function getFeatured() {
  return drawRequest<{ items: string[] }>('/api/draw/admin/featured');
}

export async function addFeatured(path: string) {
  return drawRequest<{ ok: boolean; items: string[] }>('/api/draw/admin/featured/add', {
    method: 'POST',
    json: { path }
  });
}

export async function removeFeatured(path: string) {
  return drawRequest<{ ok: boolean; items: string[] }>('/api/draw/admin/featured/remove', {
    method: 'POST',
    json: { path }
  });
}

export async function reorderFeatured(items: string[]) {
  return drawRequest<{ ok: boolean; items: string[] }>('/api/draw/admin/featured/reorder', {
    method: 'POST',
    json: { items }
  });
}

// --- Limits ---

export async function getLimits() {
  return drawRequest<{ limits: AdminLimits; defaults: AdminLimits }>('/api/draw/admin/limits');
}

export async function updateLimits(partial: Partial<AdminLimits>) {
  return drawRequest<{ ok: boolean; limits: AdminLimits }>('/api/draw/admin/limits', {
    method: 'POST',
    json: partial
  });
}

// --- Recent Images ---

export async function getRecentImages(limit = 200, offset = 0) {
  return drawRequest<{
    items: AdminRecentImage[];
    total: number;
    limit: number;
    offset: number;
  }>('/api/draw/admin/recent', { query: { limit, offset } });
}

export async function getImagesByUser(userId: number) {
  return drawRequest<{ items: AdminRecentImage[]; total: number }>(
    '/api/draw/admin/images_by_user',
    { query: { user_id: userId } }
  );
}

// --- Delete ---

export async function deleteImage(path: string) {
  return drawRequest<{ ok: boolean }>('/api/draw/admin/delete', {
    method: 'DELETE',
    json: { path }
  });
}

export async function deleteImages(paths: string[]) {
  return drawRequest<{ ok: boolean; deleted: number; failed: number }>(
    '/api/draw/admin/delete_batch',
    { method: 'POST', json: { paths } }
  );
}

// --- Announcement ---

export async function getAnnouncement() {
  return drawRequest<{ announcement: AdminAnnouncement }>('/api/draw/admin/announcement');
}

export async function updateAnnouncement(partial: Partial<AdminAnnouncement>) {
  return drawRequest<{ ok: boolean; announcement: AdminAnnouncement }>(
    '/api/draw/admin/announcement',
    { method: 'POST', json: partial }
  );
}

// --- Banned Users ---

export async function getBannedUsers() {
  return drawRequest<{ banned: BanEntry[] }>('/api/draw/admin/draw-banned');
}

export interface BanEntry {
  user_id: number;
  reason: string;
  banned_at: number;
  banned_until: number;
  remaining_days: number;
}

export async function banUser(userId: number, days: number, reason: string) {
  return drawRequest<{ ok: boolean; banned: BanEntry[] }>('/api/draw/admin/draw-ban', {
    method: 'POST',
    json: { user_id: userId, days, reason }
  });
}

export async function unbanUser(userId: number) {
  return drawRequest<{ ok: boolean; banned: BanEntry[] }>('/api/draw/admin/draw-unban', {
    method: 'POST',
    json: { user_id: userId }
  });
}

export async function fetchBanned() {
  return drawRequest<{ banned: BanEntry[] }>('/api/draw/admin/draw-banned');
}

// --- GC ---

export async function runGc() {
  return drawRequest<AdminGcResult>('/api/draw/admin/gc', { method: 'POST' });
}

// --- Styles ---


// --- LLM Config ---

export async function getLlmConfig() {
  return drawRequest<{
    config: AdminLlmConfig;
    providers: string[];
    google_thinking_options?: string[];
  }>('/api/draw/admin/llm_config');
}

export async function updateLlmConfig(data: { profiles: AdminLlmProfile[]; active: number }) {
  return drawRequest<{ ok: boolean; config: AdminLlmConfig }>('/api/draw/admin/llm_config', {
    method: 'POST',
    json: data
  });
}

export async function testLlmConfig(profileIndex?: number) {
  return drawRequest<{ ok: boolean; provider: string; profile_index?: number; reply?: string; error?: string }>('/api/draw/admin/llm_config/test', {
    method: 'POST',
    json: { profile_index: profileIndex }
  });
}

export async function getLlmModels(profileIndex?: number) {
  return drawRequest<{ ok: boolean; models?: string[]; provider?: string; error?: string }>('/api/draw/admin/llm_config/models', {
    method: 'POST',
    json: { profile_index: profileIndex }
  });
}

export async function fetchRecommendations() {
  return drawRequest<{ items: DrawRecommendation[]; total: number }>('/api/draw/admin/recommendations');
}

export async function resolveRecommendation(recId: string, action: 'approve' | 'reject', reason?: string, imagePath?: string) {
  return drawRequest<{ ok: boolean; recommendation: DrawRecommendation }>('/api/draw/admin/recommendations/resolve', {
    method: 'POST',
    json: { rec_id: recId, action, reason: reason || '', image_path: imagePath || '' }
  });
}

export async function resolveRecommendations(recIds: string[], action: 'approve' | 'reject', reason?: string) {
  return drawRequest<{ ok: boolean; resolved: number }>('/api/draw/admin/recommendations/resolve-batch', {
    method: 'POST',
    json: { rec_ids: recIds, action, reason: reason || '' }
  });
}

  // --- Collaborators ---

  export async function getCollaborators() {
    return drawRequest<{ collaborators: { user_id: number; added_by: number; added_at: number }[] }>('/api/draw/admin/collaborators');
  }

  export async function addCollaborator(userId: number) {
    return drawRequest<{ ok: boolean; collaborators: any[] }>('/api/draw/admin/collaborators/add', {
      method: 'POST',
      json: { user_id: userId }
    });
  }

  export async function removeCollaborator(userId: number) {
    return drawRequest<{ ok: boolean; collaborators: any[] }>('/api/draw/admin/collaborators/remove', {
      method: 'POST',
      json: { user_id: userId }
    });
  }

  // --- Nominations (admin review) ---

  export async function getPendingNominations() {
    return drawRequest<{ items: Nomination[]; total: number }>('/api/draw/admin/nominations');
  }

  export async function resolveNomination(id: string, action: 'approve' | 'reject', reason?: string) {
    return drawRequest<{ ok: boolean }>('/api/draw/admin/nominations/resolve', {
      method: 'POST',
      json: { id, action, reason: reason || '' }
    });
  }

  // --- Wallet / Credits ---

  export async function getWallets() {
    return drawRequest<{ items: Array<{ user_id: number; balance: number; total_purchased: number }> }>('/api/draw/admin/wallets');
  }

  export async function setWalletBalance(userId: number, balance: number, totalPurchased?: number) {
    return drawRequest<{ ok: boolean; wallet: { balance: number; total_purchased: number } }>('/api/draw/admin/wallets/set', {
      method: 'POST',
      json: { user_id: userId, balance, total_purchased: totalPurchased }
    });
  }

  export async function getPlans() {
    return drawRequest<{ items: Array<{ id: string; name: string; points: number; url: string }> }>('/api/draw/admin/plans');
  }

  export async function savePlan(plan: { id: string; name: string; points: number; url: string }) {
    return drawRequest<{ ok: boolean; plans: any[] }>('/api/draw/admin/plans', {
      method: 'POST',
      json: plan
    });
  }

  export async function deletePlan(id: string) {
    return drawRequest<{ ok: boolean; plans: any[] }>(`/api/draw/admin/plans/${id}`, { method: 'DELETE' });
  }

  export async function givePoints(userId: number | null, points: number) {
    return drawRequest<{ ok: boolean; count: number }>('/api/draw/admin/wallets/give', {
      method: 'POST',
      json: { user_id: userId, points }
    });
  }

  export async function fetchTtsRecords() {
    return drawRequest<{ items: Array<{ id: number; user_id: number; text: string; refText: string | null; xVectorMode: boolean; language: string; audioDuration: number; cost: number; outputPath: string | null; created_at: number; finished_at: number }> }>('/api/draw/admin/tts-records');
  }

  export async function deleteTtsRecord(id: number) {
    return drawRequest<{ ok: boolean }>('/api/draw/admin/tts-record/' + id, { method: 'DELETE' });
  }

  export async function savePointsConfig(cfg: { text_to_image: number; image_to_image: number; text_to_video?: number; llm_translate: number; llm_token_per_point?: number; signup_bonus?: number; text_to_image_anima?: number; text_to_image_real?: number; text_to_image_ernie?: number; image_to_image_qwen?: number; tts_generate?: number; tts_per_char?: number; tts_per_sec?: number }) {
    return drawRequest<{ ok: boolean; config: any }>('/api/draw/admin/points-config', {
      method: 'POST',
      json: cfg
    });
  }

  export async function fetchStats() {
    return drawRequest<{ stats: Record<string, any>; income: Record<string, number> }>('/api/draw/admin/stats');
  }

  export async function fetchStorage() {
    return drawRequest<{ items: Array<{ user_id: number; img_files: number; img_size: number; vid_files: number; vid_size: number; aud_files: number; aud_size: number }>; total_size: number }>('/api/draw/admin/storage');
  }
