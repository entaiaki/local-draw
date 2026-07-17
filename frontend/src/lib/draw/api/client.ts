import { forumAuth } from '$lib/forum/stores/auth';
import { drawEnv, resolveApiRedirect, apiError, apiStatus } from '../stores/env';
import { DrawApiError } from '../types';
import type { DrawApiErrorPayload, DrawRecommendation } from '../types';
import { get } from 'svelte/store';

export interface DrawRequestOptions extends RequestInit {
  requiresAuth?: boolean;
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
}

function buildUrl(
  path: string,
  query?: DrawRequestOptions['query'],
  baseUrl = get(drawEnv.baseUrl)
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(normalizedPath, baseUrl);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  // 每个请求带时间戳，防止 CDN/浏览器缓存
  url.searchParams.set('_t', String(Date.now()));
  return url.toString();
}

async function parseResponse<T>(response: Response): Promise<T> {
  // 任何成功的 API 调用都恢复在线状态（不依赖 health check）
  if (response.ok) apiStatus.set('online');
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    if (response.status === 401) {
      forumAuth.clear();
      if (typeof window !== 'undefined') {
        const loginUrl = '/forum/auth/login/?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = loginUrl;
      }
    }
    const payload = (
      typeof body === 'object' && body
        ? body
        : { message: typeof body === 'string' ? body : undefined }
    ) as DrawApiErrorPayload;
    if (payload.code === 'USER_BANNED') apiError.set(payload.detail || '账号已被封禁');
    throw new DrawApiError(response.status, payload);
  }
  return body as T;
}

export async function drawRequest<T>(
  path: string,
  options: DrawRequestOptions = {}
): Promise<T> {
  await resolveApiRedirect(); // 等重定向完成才发请求，后续调用立即返回
  const headers = new Headers(options.headers);
  const method = (options.method || 'GET').toUpperCase();
  const token = forumAuth.getToken();
  const currentEnv = get(drawEnv);
  const baseUrl = get(drawEnv.baseUrl);
  const defaultBaseUrl = drawEnv.getBaseUrl(currentEnv);

  if (options.requiresAuth && !token) {
    throw new DrawApiError(401, {
      message: '未检测到登录令牌，请先在论坛登录。',
      code: 'DRAW_AUTH_TOKEN_MISSING'
    });
  }

  if (options.json !== undefined) headers.set('Content-Type', 'application/json');

  if (token) headers.set('Authorization', `Bearer ${token}`);

  const requestInit: RequestInit = {
    ...options,
    method,
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body
  };

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query, baseUrl), requestInit);
  } catch (error) {
    if (method === 'GET' && baseUrl !== defaultBaseUrl) {
      try {
        response = await fetch(buildUrl(path, options.query, defaultBaseUrl), requestInit);
        drawEnv.customBaseUrl.reset(currentEnv);
        return parseResponse<T>(response);
      } catch {
        // fall through
      }
    }
    throw new DrawApiError(503, {
      code: 'DRAW_API_UNREACHABLE',
      message:
        error instanceof Error
          ? `生图接口不可访问：${error.message}`
          : '生图接口不可访问，请检查环境地址配置。'
    });
  }

  return parseResponse<T>(response);
}

// --- Convenience functions ---

export async function fetchWorkflows(subdir?: string) {
  return drawRequest<{
    workflows: import('../types').DrawWorkflow[];
    category_order: string[];
  }>('/api/workflows', { query: { subdir } });
}

export async function fetchWorkflowDetail(path: string, signal?: AbortSignal, subdir?: string) {
  return drawRequest<import('../types').DrawWorkflowDetail>('/api/workflows/current', {
    query: { path, subdir },
    signal
  });
}

export async function fetchStyles() {
  return drawRequest<import('../types').DrawStylesResponse>('/api/styles');
}

export async function fetchResolutions() {
  return drawRequest<import('../types').DrawResolutionsResponse>('/api/resolutions');
}

export async function fetchMyImages() {
  return drawRequest<{ items: { path: string; mtime: number }[]; total: number }>(
    '/api/draw/my-images',
    { requiresAuth: true }
  );
}

export async function fetchOutputList(limit = 500, offset = 0) {
  return drawRequest<import('../types').DrawOutputListResponse>('/api/output/list', {
    query: { limit, offset }
  });
}

export async function fetchFeatured() {
  return drawRequest<import('../types').DrawFeaturedResponse>('/api/output/featured');
}

export async function forkOutputImage(path: string) {
  return drawRequest<{
    workflow: object;
    summary: Record<string, unknown>;
    default_width: number | null;
    default_height: number | null;
    builtin_prompt: string;
    builtin_negative_prompt: string;
    loras: string[];
    format: string;
    seed?: number;
    style_tags?: string;
    matched_workflow?: string;
  }>('/api/output/fork', { method: 'POST', json: { path } });
}

export async function deleteMyImage(path: string) {
  return drawRequest<{ ok: boolean }>('/api/draw/my-images', {
    method: 'DELETE',
    json: { path }
  });
}

export async function addToQueue(payload: {
  direct_prompt: string;
  width?: number;
  height?: number;
  style_tags?: string;
  negative_prompt?: string;
  seed?: number;
  workflow_path?: string;
  inline_workflow?: unknown;
  safety_rating?: string;
  denoise?: number;
  image1_name?: string;
  image2_name?: string;
    turnstile_token?: string;
    speaker?: string;
    instruct?: string;
    language?: string;
    ref_text?: string;
    ref_audio_name?: string;
    source?: string;
}) {
  return drawRequest<{ queued: boolean; position: number; item_id: number }>('/api/draw/queue', {
    method: 'POST',
    json: payload,
    requiresAuth: true,
  });
}

export async function fetchMyQueue() {
  return drawRequest<{ items: Array<{
    id: number;
    status: string;
    created_at: number;
    started_at?: number;
    finished_at?: number;
    error?: string;
    position?: number | null;
    _output_files?: string[];
  }>; total: number }>('/api/draw/my-queue', { requiresAuth: true });
}

export async function clearQueue() {
  return drawRequest<{ ok: boolean; cleared: number }>('/api/draw/queue', {
    method: 'DELETE',
    requiresAuth: true,
  });
}

export async function fetchDebugInfo() {
  return drawRequest<{
    active: { count: number; status: unknown; semaphore_locked: boolean; subscribers: number };
    queue_items: Array<{ id: number; user_id: number; status: string; created_ago: number; workflow_path: string }>;
    stuck: Array<{ id: number; user_id: number; status: string }>;
  }>('/api/draw/debug', { requiresAuth: true });
}

export async function recommendImage(imagePath: string, reason?: string) {
  return drawRequest<{ ok: boolean; recommendation: DrawRecommendation }>('/api/draw/recommend', {
    method: 'POST',
    json: { image_path: imagePath, reason: reason || '' }
  });
}

export async function fetchMyRecommendations() {
  return drawRequest<{ items: DrawRecommendation[]; total: number }>('/api/draw/my-recommendations');
}

export async function fetchWalletBalance() {
  return drawRequest<{ balance: number; total_purchased: number }>('/api/wallet/balance');
}

export async function createWalletOrder(payUrl: string, points: number) {
  return drawRequest<{ pay_url: string; order_id: string; points: number }>('/api/wallet/create-order', {
    method: 'POST',
    json: { pay_url: payUrl, points }
  });
}

async function fetchPublic<T>(path: string): Promise<T> {
  const baseUrl = get(drawEnv.baseUrl);
  const sep = path.includes('?') ? '&' : '?';
  const resp = await fetch(`${baseUrl}${path}${sep}_t=${Date.now()}`);
  if (!resp.ok) throw new Error(`fetchPublic ${path} failed: ${resp.status}`);
  return resp.json();
}

export async function fetchAnnouncement() {
  return fetchPublic<{ announcement: { enabled: boolean; title: string; content: string } | null }>('/api/announcement');
}

export async function fetchOutputMeta(path: string) {
  return drawRequest<{ prompt?: string; workflow_path?: string; speaker?: string; language?: string }>('/api/output/meta', {
    query: { path }
  });
}

export async function fetchPlans() {
  return fetchPublic<{ items: Array<{ id: string; name: string; url: string; points: number }> }>('/api/wallet/plans');
}

export async function fetchPointsConfig() {
  return fetchPublic<{ text_to_image: number; image_to_image: number; text_to_video?: number; llm_translate: number; llm_token_per_point: number; signup_bonus: number; text_to_image_anima: number; text_to_image_real: number; text_to_image_ernie: number; image_to_image_qwen: number; tts_generate: number; tts_per_char: number; tts_per_sec: number }>('/api/wallet/points-config');
}

function _appendToken(url: URL): string {
  const token = forumAuth.getToken();
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

export function getImageUrl(path: string, full = false): string {
  const baseUrl = get(drawEnv.baseUrl);
  const url = new URL('/api/output/file', baseUrl);
  url.searchParams.set('path', path);
  if (full) url.searchParams.set('full', '1');
  return _appendToken(url);
}

export function getImageDownloadUrl(path: string): string {
  const baseUrl = get(drawEnv.baseUrl);
  const url = new URL('/api/output/file', baseUrl);
  url.searchParams.set('path', path);
  url.searchParams.set('raw', '1');
  return _appendToken(url);
}

export function getThumbnailUrl(path: string): string {
  const baseUrl = get(drawEnv.baseUrl);
  const url = new URL('/api/thumbnail', baseUrl);
  url.searchParams.set('path', path);
  return _appendToken(url);
}

export async function fetchPresets() {
  return drawRequest<import('../types').Preset[]>('/api/presets', { requiresAuth: true });
}

export async function createPreset(data: { name: string; content: string; type: string }) {
  return drawRequest<import('../types').Preset>('/api/presets', { method: 'POST', requiresAuth: true, json: data });
}

export async function updatePreset(id: string, data: { name?: string; content?: string; type?: string }) {
  return drawRequest<import('../types').Preset>('/api/presets/' + id, { method: 'PUT', requiresAuth: true, json: data });
}

export async function deletePreset(id: string) {
  return drawRequest<{ ok: boolean }>('/api/presets/' + id, { method: 'DELETE', requiresAuth: true });
}

export function getImageProxyUrl(filename: string, subfolder = '', type = 'output'): string {
  const baseUrl = get(drawEnv.baseUrl);
  const url = new URL('/api/image', baseUrl);
  url.searchParams.set('filename', filename);
  if (subfolder) url.searchParams.set('subfolder', subfolder);
  url.searchParams.set('type', type);
  return _appendToken(url);
}

export interface ChatPayload {
  message: string;
  workflow_path?: string;
  style_tags?: string;
  system_prompt: string;
  negative_prompt?: string;
  workflow_prompt?: string;
  history: Array<{ role: string; content: string }>;
  gen_enabled?: boolean;
  mode?: string;
}

/**
 * 角色扮演聊天 — SSE 流式请求。
 * 返回原始 Response，调用方自行解析 SSE 事件流。
 */
export async function chatRequest(payload: ChatPayload): Promise<Response> {
  await resolveApiRedirect();
  const token = forumAuth.getToken();
  if (!token) {
    throw new DrawApiError(401, {
      message: '未检测到登录令牌，请先在论坛登录。',
      code: 'DRAW_AUTH_TOKEN_MISSING'
    });
  }
  const baseUrl = get(drawEnv.baseUrl);
  const url = buildUrl('/api/draw/chat', undefined, baseUrl);
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const payload_err = (typeof body === 'object' && body
      ? body
      : { message: typeof body === 'string' ? body : undefined }) as DrawApiErrorPayload;
    if (response.status === 401) {
      forumAuth.clear();
      if (typeof window !== 'undefined') {
        const loginUrl = '/forum/auth/login/?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = loginUrl;
      }
    }
    throw new DrawApiError(response.status, payload_err);
  }
  return response;
}

// --- Chat Presets ---

export interface ChatPreset {
  id: string;
  name: string;
  systemPrompt: string;
}

export async function fetchChatPresets() {
  return drawRequest<{ items: ChatPreset[] }>('/api/draw/chat-presets', { requiresAuth: true });
}

export async function saveChatPreset(name: string, systemPrompt: string) {
  return drawRequest<{ ok: boolean; preset: ChatPreset }>('/api/draw/chat-presets', {
    method: 'POST',
    json: { name, systemPrompt },
    requiresAuth: true,
  });
}

export async function deleteChatPreset(id: string) {
  return drawRequest<{ ok: boolean }>(`/api/draw/chat-presets/${id}`, {
    method: 'DELETE',
    requiresAuth: true,
  });
}

export async function fetchChatHistory() {
  return drawRequest<{ items: Array<{ role: string; content: string }> }>('/api/draw/chat-history', { requiresAuth: true });
}

export async function appendChatHistory(messages: Array<{ role: string; content: string }>) {
  return drawRequest<{ ok: boolean; total: number }>('/api/draw/chat-history', {
    method: 'POST',
    json: { messages },
    requiresAuth: true,
  });
}

export async function clearChatHistory() {
  return drawRequest<{ ok: boolean }>('/api/draw/chat-history', {
    method: 'DELETE',
    requiresAuth: true,
  });
}

export async function clearMyImages() {
  return drawRequest<{ ok: boolean; deleted: number }>('/api/draw/my-images/all', {
    method: 'DELETE',
    requiresAuth: true,
  });
}

// --- TTS ---

export async function fetchTtsMyRecords() {
  return drawRequest<{ items: Array<{ id: number; user_id: number; text: string; refText: string | null; xVectorMode: boolean; language: string; audioDuration: number; cost: number; outputPath: string | null; created_at: number; finished_at: number }>; total: number }>(
    '/api/draw/tts/my-records',
    { requiresAuth: true }
  );
}

export function getTtsRecordDownloadUrl(id: number): string {
  const token = forumAuth.getToken();
  const baseUrl = get(drawEnv.baseUrl);
  const url = new URL(`/api/draw/tts/record-download/${id}`, baseUrl);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

export async function deleteTtsMyRecord(id: number) {
  return drawRequest<{ ok: boolean }>(`/api/draw/tts/my-record/${id}`, {
    method: 'DELETE',
    requiresAuth: true,
  });
}

export async function fetchTtsSpeakers() {
  return drawRequest<{ speakers: Array<{ id: string; description: string }> }>('/api/draw/tts/speakers');
}

export async function uploadTtsRefAudio(file: File): Promise<{ filename: string }> {
  const token = forumAuth.getToken();
  const baseUrl = get(drawEnv.baseUrl);
  const fd = new FormData();
  fd.append('audio', file);
  const resp = await fetch(baseUrl + '/api/tts/upload-ref', {
    method: 'POST',
    headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    body: fd,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || '上传失败');
  }
  return resp.json();
}

