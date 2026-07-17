<script lang="ts">
  import Icon from '@iconify/svelte';
  import { Button } from '$lib/components/ui/button';
  import { fetchOutputList, getImageUrl, getImageProxyUrl } from '$lib/draw/api/client';
  import ImageLightbox from '$lib/components/draw/ImageLightbox.svelte';
  import type { DrawOutputItem } from '$lib/draw/types';

  let {
    onFork
  }: {
    onFork?: (path: string) => void;
  } = $props();

  let items = $state<DrawOutputItem[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let offset = $state(0);
  const limit = 30;
  let hasMore = $derived(offset < total);

  // Lightbox state
  let lbOpen = $state(false);
  let lbIndex = $state(0);
  let lbImages = $derived(items.map((it) => ({ src: getImageUrl(it.path), cached: getThumbnailUrl(it.path), creator_id: it.creator_id || '' })));

  function openLightbox(i: number) {
    lbIndex = i;
    lbOpen = true;
  }

  $effect(() => {
    loadGallery();
  });

  async function loadGallery() {
    loading = true;
    try {
      const res = await fetchOutputList(limit, 0);
      items = res.items;
      total = res.total;
      offset = res.items.length;
    } catch {
      items = [];
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    try {
      const res = await fetchOutputList(limit, offset);
      items = [...items, ...res.items];
      offset += res.items.length;
    } catch {
      // ignore
    } finally {
      loading = false;
    }
  }
</script>

<div class="space-y-3">
  <div class="flex items-center justify-between">
    <h3 class="text-sm font-medium flex items-center gap-1.5">
      <Icon icon="mdi:image-multiple-outline" class="size-4" />
      画廊
      <span class="text-xs text-muted-foreground">({items.length}/{total})</span>
    </h3>
    <Button variant="ghost" size="sm" onclick={loadGallery} disabled={loading}>
      <Icon icon="mdi:refresh" class="size-4" />
    </Button>
  </div>

  {#if items.length === 0 && !loading}
    <div class="text-xs text-muted-foreground py-8 text-center">暂无图片</div>
  {:else}
    <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-1.5">
      {#each items as item, i}
        <button
          type="button"
          class="aspect-square rounded-md overflow-hidden border hover:ring-2 hover:ring-primary/50 transition-all cursor-pointer"
          onclick={() => openLightbox(i)}
        >
          <img
            src={getImageProxyUrl(item.path)}
            alt={item.path}
            class="w-full h-full object-cover"
            loading="lazy"
          />
        </button>
      {/each}
    </div>

    {#if hasMore}
      <div class="text-center">
        <Button variant="outline" size="sm" onclick={loadMore} disabled={loading}>
          {#if loading}
            <Icon icon="mdi:loading" class="size-4 animate-spin mr-1" />
          {/if}
          加载更多
        </Button>
      </div>
    {/if}
  {/if}
</div>

<ImageLightbox
  open={lbOpen}
  images={lbImages}
  index={lbIndex}
  onclose={() => (lbOpen = false)}
  onfork={onFork}
/>
