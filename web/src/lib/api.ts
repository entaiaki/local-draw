// API client for natureDrawImage backend

const TOKEN_KEY = 'draw_local_token';

export function getToken(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(TOKEN_KEY, token);
  }
}

export function clearToken(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Auto-login via /api/dev-login (local dev only) */
export async function devLogin(): Promise<boolean> {
  try {
    const resp = await fetch('/api/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    if (data.token) {
      setToken(data.token);
      return true;
    }
  } catch {}
  return false;
}

/** Ensure we have a token, auto-login if not */
export async function ensureAuth(): Promise<boolean> {
  if (getToken()) return true;
  return devLogin();
}

// ── Assistant ──
export interface AssistantCard {
  reply: string;
  card: {
    workflow_path: string;
    positive: string;
    negative: string;
    width: number;
    height: number;
    style: string | null;
    character: string | null;
  };
}

export async function assistantChat(
  message: string,
  history: Array<{ role: string; content: string }> = []
): Promise<AssistantCard> {
  const resp = await fetch('/api/assistant/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ message, history }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || data.detail || '请求失败');
  return data;
}

export async function fetchCharacters(): Promise<any[]> {
  try {
    const resp = await fetch('/api/assistant/characters');
    const data = await resp.json();
    return data.characters || [];
  } catch { return []; }
}

export async function fetchStyles(): Promise<string[]> {
  try {
    const resp = await fetch('/api/assistant/styles');
    const data = await resp.json();
    return data.styles || [];
  } catch { return []; }
}

export async function fetchResolutions(): Promise<Record<string, { width: number; height: number }>> {
  try {
    const resp = await fetch('/api/resolutions');
    return await resp.json();
  } catch { return {}; }
}

// ── Img2img ──
export interface Img2imgUploadResult {
  ok: boolean;
  image1_name: string;
  image2_name?: string;
  image3_name?: string;
}

export async function uploadImg2img(image1: File, image2?: File, image3?: File): Promise<Img2imgUploadResult> {
  await ensureAuth();
  const fd = new FormData();
  fd.append('image1', image1);
  if (image2) fd.append('image2', image2);
  if (image3) fd.append('image3', image3);
  const resp = await fetch('/api/img2img/upload', {
    method: 'POST',
    headers: { ...authHeaders() },
    body: fd,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || data.detail || '上传失败');
  return data;
}

// ── Queue ──
export interface QueueSubmitResult {
  queued: boolean;
  position: number;
  item_id: number;
}

export async function submitToQueue(params: {
  workflow_path: string;
  direct_prompt: string;
  workflow_prompt?: string;
  workflow_negative_prompt?: string;
  width: number;
  height: number;
  style_tags?: string;
  seed?: number;
  image1_name?: string;
  image2_name?: string;
  image3_name?: string;
}): Promise<QueueSubmitResult> {
  await ensureAuth();
  const resp = await fetch('/api/draw/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(params),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || data.detail || '提交失败');
  return data;
}

export interface QueueItem {
  id: number;
  status: string;
  created_at: number;
  started_at?: number;
  finished_at?: number;
  error?: string;
  position?: number | null;
}

export async function fetchMyQueue(): Promise<{ items: QueueItem[] }> {
  try {
    const resp = await fetch('/api/draw/my-queue', { headers: authHeaders() });
    if (!resp.ok) return { items: [] };
    return await resp.json();
  } catch { return { items: [] }; }
}

export async function cancelQueueItem(id: number): Promise<void> {
  try {
    await fetch(`/api/draw/my-queue/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
  } catch {}
}

// ── Images ──
export interface MyImage {
  path: string;
  mtime: number;
}

export async function fetchMyImages(): Promise<{ items: MyImage[]; total: number }> {
  try {
    const resp = await fetch('/api/draw/my-images', { headers: authHeaders() });
    if (!resp.ok) return { items: [], total: 0 };
    return await resp.json();
  } catch { return { items: [], total: 0 }; }
}

export function getImageUrl(path: string): string {
  return `/api/image?filename=${encodeURIComponent(path.split('/').pop() || path)}&subfolder=${encodeURIComponent(path.includes('/') ? path.split('/').slice(0, -1).join('/') : '')}`;
}

// ── WebSocket ──
export interface WsStatusEvent {
  type: 'status' | 'online' | 'queue_update';
  online?: number;
  busy?: boolean;
  stage?: string;
  node?: string;
  value?: number;
  max?: number;
}

export function connectWs(onMessage: (msg: WsStatusEvent) => void): WebSocket | null {
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/status`);
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch {}
    };
    ws.onclose = () => {
      // Reconnect after 3s
      setTimeout(() => connectWs(onMessage), 3000);
    };
    return ws;
  } catch { return null; }
}

// ── Workflow ──
export interface DrawWorkflow {
  path: string;
  name: string;
  thumbnail: boolean;
  category: string;
}

export async function fetchWorkflows(): Promise<{ workflows: DrawWorkflow[]; category_order: string[] }> {
  try {
    const resp = await fetch('/api/workflows');
    return await resp.json();
  } catch { return { workflows: [], category_order: [] }; }
}
