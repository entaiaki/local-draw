<script lang="ts">
  import Icon from '@iconify/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Alert, AlertDescription } from '$lib/components/ui/alert';
  import { fetchFeatured, getImageUrl, getImageProxyUrl } from '$lib/draw/api/client';
  import ImageLightbox from '$lib/components/draw/ImageLightbox.svelte';
  import type { DrawOutputItem } from '$lib/draw/types';
import { onMount, onDestroy } from 'svelte';

  const tip = '精选图片由管理员挑选，展示社区优质作品。仅收录SFW';

  let {
    onFork
  }: {
    onFork?: (path: string) => void;
  } = $props();

  let items = $state<DrawOutputItem[]>([]);
  let loading = $state(true);
  let displayLimit = $state(50);
  let hasMore = $state(false);
  let sentinelEl: HTMLDivElement | undefined;
  let io: IntersectionObserver | null = null;

  let columnCount = $state(4);
  let imgColumns = $state<string[][]>([[], [], [], []]);
  let columnHeights: number[] = [0, 0, 0, 0];

  let lbOpen = $state(false);
  let lbIndex = $state(0);
  let lbImages = $derived(items.map((it) => ({ src: getImageUrl(it.path), creator_id: it.creator_id || '', cached: getImageProxyUrl(it.path) })));

  function openLightbox(i: number) {
    lbIndex = i;
    lbOpen = true;
  }

  function getColumnCount(): number {
    if (typeof window === 'undefined') return 4;
    const w = window.innerWidth;
    if (w >= 1400) return 6;
    if (w >= 1024) return 5;
    if (w >= 768) return 4;
    if (w >= 480) return 3;
    return 2;
  }

  function rebuildColumns() {
    const display = items.slice(0, displayLimit);
    columnCount = getColumnCount();
    imgColumns = Array.from({ length: columnCount }, () => []);
    columnHeights = new Array(columnCount).fill(0);
    for (const item of display) {
      let minIdx = 0;
      for (let i = 1; i < columnHeights.length; i++) {
        if (columnHeights[i] < columnHeights[minIdx]) minIdx = i;
      }
      imgColumns[minIdx] = [...imgColumns[minIdx], item.path];
      columnHeights[minIdx] += 1;
    }
    hasMore = displayLimit < items.length;
  }

  function handleImgLoad(e: Event) {
    const img = e.currentTarget as HTMLImageElement;
    if (img.naturalWidth && img.naturalHeight) {
      img.style.aspectRatio = `${img.naturalWidth / img.naturalHeight}`;
    }
  }

  function handleResize() {
    const nu = getColumnCount();
    if (nu === columnCount) return;
    rebuildColumns();
  }

  function showMore() {
    displayLimit = Math.min(displayLimit + 50, items.length);
    rebuildColumns();
  }

  async function loadFeatured() {
    loading = true;
    try {
      const res = await fetchFeatured();
      items = res.items;
      displayLimit = 50;
      rebuildColumns();
    } catch {
      items = [];
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    loadFeatured();
  });

  $effect(() => {
    if (sentinelEl && !loading) {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting && !loading && hasMore)) showMore();
        },
        { rootMargin: '400px 0px' }
      );
      io.observe(sentinelEl);
    }
    return () => io?.disconnect();
  });

    onMount(() => {
    columnCount = getColumnCount();
    window.addEventListener('resize', handleResize, { passive: true });
  });
  onDestroy(() => {
    io?.disconnect();
    window.removeEventListener('resize', handleResize);
  });
</script>

<div class="space-y-3">
  <div class="flex items-center justify-between">
    <h3 class="text-sm font-medium flex items-center gap-1.5">
      <Icon icon="mdi:star-outline" class="size-4" />
      精选
      <span class="text-xs text-muted-foreground">({items.length})</span>
    </h3>
    <Button variant="ghost" size="sm" onclick={loadFeatured} disabled={loading}>
      <Icon icon="mdi:refresh" class="size-4" />
    </Button>
  </div>

  <Alert>
    <AlertDescription class="text-xs">
      {tip}<br />
      <b>你可以前往"我的"页面自荐自己的图片，管理员审核通过后自动加入精选。</b>
    </AlertDescription>
  </Alert>

  {#if loading}
    <div class="text-xs text-muted-foreground py-8 text-center">加载中...</div>
  {:else if items.length === 0}
    <div class="text-xs text-muted-foreground py-8 text-center">暂无精选图片</div>
  {:else}
    <div class="flex gap-2 items-start">
      {#each imgColumns as col, ci (ci)}
        <div class="flex flex-1 flex-col gap-2 min-w-0">
          {#each col as path (ci + '-' + path)}
            {@const item = items.find(i => i.path === path)}
            {#if item}
              <div class="relative group rounded-md overflow-hidden border">
                <button
                  type="button"
                  class="w-full block cursor-pointer"
                  onclick={() => openLightbox(items.indexOf(item))}
                >
                  <img
                    src={getImageProxyUrl(item.path)}
                    alt={item.path}
                    loading="lazy"
                    decoding="async"
                    style="aspect-ratio: 1;"
                    onload={handleImgLoad}
                    class="block w-full h-auto bg-muted"
                  />
                </button>
                <div class="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[10px] px-1 py-0.5 truncate rounded-b-lg pointer-events-none">
                  {item.creator_id || '?'}
                </div>
              </div>
            {/if}
          {/each}
        </div>
      {/each}
    </div>
    {#if !hasMore && items.length > 0}
      <div class="text-center text-xs text-muted-foreground py-2">已加载全部</div>
    {/if}
    <div bind:this={sentinelEl} class="h-4"></div>
  {/if}
</div>

<ImageLightbox
  open={lbOpen}
  images={lbImages}
  index={lbIndex}
  onclose={() => (lbOpen = false)}
  onfork={onFork}
/>