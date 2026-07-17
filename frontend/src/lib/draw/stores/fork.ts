import { writable, get } from 'svelte/store';

interface ForkData {
  workflow: object;
  builtin_prompt: string;
  builtin_negative_prompt: string;
  default_width: number | null;
  default_height: number | null;
  seed?: number;
  style_tags?: string;
  matched_workflow?: string;
  workflow_api?: Record<string, any> | null;
}

export const pendingFork = writable<ForkData | null>(null);

export function consumeFork(): ForkData | null {
  const data = get(pendingFork);
  if (data) pendingFork.set(null);
  return data;
}
