/**
 * 持久化工具 — 自动存 localStorage，一劳永逸。
 *
 * 用法 (在 .svelte 组件中):
 *   import { persisted } from '$lib/draw/utils/persistedState';
 *   let count = persisted('my-key', 0);          // 像 $state 一样用
 *   let user = persisted('user-key', null);       // 对象
 *
 * 图片用:
 *   import { persistedImage } from '$lib/draw/utils/persistedState';
 *   let { dataUrl, save, clear } = $state(persistedImage('img-key'));
 *
 * 原理: 在 $effect 中自动监听变化并写入 localStorage，
 *       不需要每个组件手写 save/restore。
 */

/** 普通值持久化（JSON 序列化） */
export function persisted<T>(key: string, initial: T): T {
  let current: T = initial;
  if (typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) current = JSON.parse(saved);
    } catch {}
  }

  // $effect 自动写回 localStorage
  $effect(() => {
    try { localStorage.setItem(key, JSON.stringify(current)); } catch {}
  });

  return current;
}

/** 图片持久化（存 dataURL） */
export function persistedImage(key: string) {
  let _dataUrl: string = '';
  if (typeof localStorage !== 'undefined') {
    try { _dataUrl = localStorage.getItem(key) || ''; } catch {}
  }

  $effect(() => {
    try {
      if (_dataUrl) localStorage.setItem(key, _dataUrl);
      else localStorage.removeItem(key);
    } catch {}
  });

  return {
    get dataUrl() { return _dataUrl; },
    save(url: string) { _dataUrl = url; },
    clear() { _dataUrl = ''; },
  };
}
