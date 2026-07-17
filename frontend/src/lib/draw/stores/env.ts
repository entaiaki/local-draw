import type { DrawApiEnv } from '../types';
import type { Readable, Writable } from 'svelte/store';
import { readLocalStorage, writeLocalStorage } from '$lib/forum/utils/storage';
import { derived, get, writable } from 'svelte/store';

export const DRAW_API_ENV_STORAGE_KEY = 'draw-api-env';
export const DRAW_API_CUSTOM_BASE_URL_STORAGE_KEY = 'draw-api-custom-base-url';

/** 全局 API 错误状态：当 drawRequest 彻底失败时设置 */
export const apiError = writable<string | null>(null);

/** 重定向检测日志（可在页面上展示） */
export const redirectLogs = writable<string[]>([]);
let _logIdx = 0;
export function addRedirectLog(msg: string) {
  redirectLogs.update(arr => {
    const newLog = `[${++_logIdx}] ${msg}`;
    arr = [...arr, newLog];
    if (arr.length > 20) arr = arr.slice(-20);
    return arr;
  });
}

export type ApiStatus = 'checking' | 'online' | 'offline';
export const apiStatus = writable<ApiStatus>('checking');


export const DRAW_API_BASE_URLS: Record<DrawApiEnv, string> = {
  prod: 'https://api-ai.2x.nz',
  dev: 'http://localhost:8080'
};

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function normalizeEnv(value: DrawApiEnv | string | null | undefined): DrawApiEnv {
  return value === 'dev' ? 'dev' : 'prod';
}

function sanitizeBaseUrl(value: string | null | undefined, env: DrawApiEnv) {
  const v = normalizeBaseUrl(value || '');
  if (!v) return DRAW_API_BASE_URLS[env];
  try {
    const url = new URL(v);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return DRAW_API_BASE_URLS[env];
    }
    return normalizeBaseUrl(url.toString());
  } catch {
    return DRAW_API_BASE_URLS[env];
  }
}

interface DrawCustomBaseUrlStore {
  subscribe: Writable<string>['subscribe'];
  set(value: string): void;
  reset(env: DrawApiEnv): void;
}

interface DrawEnvStore {
  subscribe: Writable<DrawApiEnv>['subscribe'];
  baseUrl: Readable<string>;
  customBaseUrl: DrawCustomBaseUrlStore;
  set(value: DrawApiEnv): void;
  toggle(): void;
  getBaseUrl(env: DrawApiEnv): string;
}

function createEnvStore(): DrawEnvStore {
  const initialEnv = normalizeEnv(
    readLocalStorage<DrawApiEnv | string>(DRAW_API_ENV_STORAGE_KEY, 'prod')
  );
  const envStore = writable<DrawApiEnv>(initialEnv);
  // 开发模式保留自定义地址，生产模式每次刷新重置为默认
  const savedUrl = initialEnv === 'dev' ? readLocalStorage<string>(DRAW_API_CUSTOM_BASE_URL_STORAGE_KEY, '') : '';
  const customBaseUrlStore = writable<string>(savedUrl || DRAW_API_BASE_URLS[initialEnv]);

  const baseUrl = derived([envStore, customBaseUrlStore], ([$env, $custom]) =>
    sanitizeBaseUrl($custom, $env)
  );

  return {
    subscribe: envStore.subscribe,
    baseUrl,
    customBaseUrl: {
      subscribe: customBaseUrlStore.subscribe,
      set: (v) => {
      const url = sanitizeBaseUrl(v, get(envStore));
      writeLocalStorage(DRAW_API_CUSTOM_BASE_URL_STORAGE_KEY, url);
            apiStatus.set('checking');
      customBaseUrlStore.set(url);
    },
      reset: (env) => {
      writeLocalStorage(DRAW_API_CUSTOM_BASE_URL_STORAGE_KEY, '');
            customBaseUrlStore.set(DRAW_API_BASE_URLS[env]);
    }
    },
    set: (v) => {
      const next = normalizeEnv(v);
      writeLocalStorage(DRAW_API_ENV_STORAGE_KEY, next);
            envStore.set(next);
      customBaseUrlStore.set(DRAW_API_BASE_URLS[next]);
    },
    toggle: () => {
      let next: DrawApiEnv = 'prod';
      envStore.update((cur) => {
        next = cur === 'prod' ? 'dev' : 'prod';
        writeLocalStorage(DRAW_API_ENV_STORAGE_KEY, next);
        return next;
      });
            customBaseUrlStore.set(DRAW_API_BASE_URLS[next]);
    },
    getBaseUrl: (env) => DRAW_API_BASE_URLS[env]
  };
}

export const drawEnv: DrawEnvStore = createEnvStore();

let _redirectPromise: Promise<void> | null = null;

export async function resolveApiRedirect(): Promise<void> {
  if (_redirectPromise) return _redirectPromise;
  console.log('[API] resolveApiRedirect 开始');
  apiStatus.set('checking');
  _redirectPromise = (async () => {
    const baseUrl = get(drawEnv.baseUrl);
    try {
      const resp = await fetch(baseUrl + '/health?_t=' + Date.now(), { method: 'GET' });
      console.log('[API] health 响应', resp.status, resp.url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const finalUrl = resp.url.replace(/\/health[\?&].*$/, '').replace(/\/health$/, '');
      if (finalUrl !== baseUrl && finalUrl.startsWith('http')) {
        console.log('[API] 检测到重定向', baseUrl, '->', finalUrl);
        drawEnv.customBaseUrl.set(finalUrl);
      }
      console.log('[API] 设为 online');
      apiStatus.set('online');
      apiError.set(null);
    } catch (e: any) {
      console.log('[API] 失败', e.message);
      apiStatus.set('offline');
    }
  })();
  return _redirectPromise;
}
