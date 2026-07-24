<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchMyImages, getImageUrl, type MyImage } from '$lib/api';

  let { mode = 'mine' }: { mode?: 'mine' | 'featured' } = $props();

  let images: MyImage[] = $state([]);
  let loading = $state(false);
  let loaded = $state(false);
  let lightboxIndex = $state<number | null>(null);

  async function loadImages() {
    loading = true;
    try {
      const { items } = await fetchMyImages();
      images = items.sort((a, b) => b.mtime - a.mtime);
      loaded = true;
    } catch {
      images = [];
    }
    loading = false;
  }

  onMount(() => {
    loadImages();
  });

  // Simple masonry: 3 columns
  let columns = $derived.by(() => {
    const cols: MyImage[][] = [[], [], []];
    images.forEach((img, i) => cols[i % 3].push(img));
    return cols;
  });
</script>

<div class="h-full overflow-y-auto p-4">
  {#if loading && !loaded}
    <div class="flex items-center justify-center h-32 text-sm text-muted-foreground">加载中...</div>
  {:else if images.length === 0}
    <div class="flex flex-col items-center justify-center h-64 text-muted-foreground gap-2">
      <span class="text-4xl">📭</span>
      <span class="text-sm">还没有作品，去生成第一张吧！</span>
    </div>
  {:else}
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {#each images as img, i}
        <div
          class="relative group rounded-xl overflow-hidden border border-border cursor-pointer bg-muted/20"
          onclick={() => lightboxIndex = i}
        >
          <img
            src={getImageUrl(img.path)}
            alt=""
            loading="lazy"
            class="w-full object-cover transition-transform group-hover:scale-105"
          />
          <div class="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2">
            <span class="text-[10px] text-white/80">{new Date(img.mtime * 1000).toLocaleString('zh-CN')}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Lightbox -->
  {#if lightboxIndex !== null && images[lightboxIndex]}
    <div
      class="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
      onclick={() => lightboxIndex = null}
      onkeydown={(e) => {
        if (e.key === 'Escape') lightboxIndex = null;
        if (e.key === 'ArrowLeft' && lightboxIndex > 0) lightboxIndex--;
        if (e.key === 'ArrowRight' && lightboxIndex < images.length - 1) lightboxIndex++;
      }}
      role="button"
      tabindex="0"
    >
      <img
        src={getImageUrl(images[lightboxIndex].path)}
        alt=""
        class="max-w-full max-h-full object-contain rounded-lg"
      />
      <button
        class="absolute top-4 right-4 text-white/70 hover:text-white"
        onclick={() => lightboxIndex = null}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      {#if lightboxIndex > 0}
        <button class="absolute left-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white" onclick={() => lightboxIndex--}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
      {/if}
      {#if lightboxIndex < images.length - 1}
        <button class="absolute right-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white" onclick={() => lightboxIndex++}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      {/if}
    </div>
  {/if}
</div>
