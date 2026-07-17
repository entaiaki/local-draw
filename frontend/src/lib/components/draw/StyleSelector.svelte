<script lang="ts">
  import Icon from '@iconify/svelte';
  import { fetchStyles } from '$lib/draw/api/client';
  import { drawEnv } from '$lib/draw/stores/env';
  import type { DrawStyle } from '$lib/draw/types';

  let {
    value = $bindable(''),
    onselect,
    showTitle = true,
    constrainHeight = true,
    prefix = ''
  }: {
    value?: string;
    onselect?: (tags: string, name: string) => void;
    showTitle?: boolean;
    constrainHeight?: boolean;
    prefix?: string;
  } = $props();

  let styles = $state<DrawStyle[]>([]);
  let loading = $state(true);
  let showAll = $state(false);
  let baseUrl = $state('');

  $effect(() => {
    const u = drawEnv.baseUrl.subscribe((v) => (baseUrl = v));
    return u;
  });

  const sortedStyles = $derived(() => {
    const list = showAll ? styles : styles.filter((s) => s.thumbnail_url);
    const score = (s: DrawStyle) => (s.thumbnail_url ? 2 : 0) + (s.name ? 1 : 0);
    return [...list].sort((a, b) => score(b) - score(a));
  });

  $effect(() => {
    loadStyles();
  });

  async function loadStyles() {
    loading = true;
    try {
      const res = await fetchStyles();
      styles = res.styles;
    } catch {
      styles = [];
    } finally {
      loading = false;
    }
  }

  function toggleStyle(s: DrawStyle) {
    const tag = prefix + s.tags;
    if (value === tag) {
      value = '';
      onselect?.('', '');
    } else {
      value = tag;
      onselect?.(tag, s.name || s.tags);
    }
  }
</script>

{#if styles.length > 0}
  <div class="space-y-2">
    {#if showTitle}
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-medium flex items-center gap-1.5">
          <Icon icon="mdi:palette-outline" class="size-4" />
          风格
        </h3>
        <button
          class="text-xs text-muted-foreground hover:text-foreground transition-colors"
          onclick={() => (showAll = !showAll)}
        >
          {showAll ? '收起' : '更多'}
        </button>
      </div>
    {/if}

    {#if loading}
      <div class="text-xs text-muted-foreground py-4 text-center">加载中...</div>
    {:else}
      <div class="{constrainHeight ? 'max-h-64' : ''} overflow-y-auto pr-1">
        <div class="flex flex-wrap gap-1.5">
          {#each sortedStyles() as s (s.tags)}
            <button
              class="inline-flex flex-col items-center gap-1.5 p-2 rounded-md border text-center text-xs transition-all hover:bg-accent {value === s.tags ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border'}"
              onclick={() => toggleStyle(s)}
              title={s.tags}
            >
              {#if s.thumbnail_url}
                <img
                  src="{baseUrl}{s.thumbnail_url}"
                  alt=""
                  class="h-20 rounded object-contain shrink-0"
                  loading="lazy"
                />
              {:else}
                <div class="size-20 rounded bg-muted flex items-center justify-center shrink-0">
                  <Icon icon="mdi:palette-outline" class="size-8 text-muted-foreground" />
                </div>
              {/if}
              <span class="truncate">{s.name || s.tags}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}
