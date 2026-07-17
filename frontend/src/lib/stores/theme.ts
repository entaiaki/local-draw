import { writable, derived } from 'svelte/store';
import { browser } from '$app/environment';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';

function getStored(): ThemeMode {
  if (!browser) return 'system';
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'system';
}

function getSystemDark(): boolean {
  if (!browser) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export const themeMode = writable<ThemeMode>(getStored());

export const isDark = derived(themeMode, ($mode) => {
  if ($mode === 'system') return getSystemDark();
  return $mode === 'dark';
});

function applyTheme(dark: boolean) {
  if (!browser) return;
  const el = document.documentElement;
  if (dark) {
    el.classList.add('dark');
  } else {
    el.classList.remove('dark');
  }
  // update theme-color meta
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0a0a0a' : '#ffffff');
}

// Subscribe to isDark and apply
if (browser) {
  isDark.subscribe((dark) => {
    applyTheme(dark);
  });

  // Listen for system preference changes
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    // Only re-evaluate if mode is system
    themeMode.update((mode) => {
      if (mode === 'system') {
        applyTheme(getSystemDark());
      }
      return mode;
    });
  });

  // Persist on change
  themeMode.subscribe((mode) => {
    localStorage.setItem(STORAGE_KEY, mode);
  });
}
