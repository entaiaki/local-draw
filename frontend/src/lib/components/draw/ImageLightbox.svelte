<script lang="ts">
  import Icon from '@iconify/svelte';
  import { resolveUsername } from '$lib/draw/stores/username';
  import { getImageDownloadUrl } from '$lib/draw/api/client';

  let {
    open = false,
    images = [],
    index = 0,
    onclose,
    onfork,
    onrecommend
  }: {
    open?: boolean;
    images?: { src: string; creator_id?: string; cached?: string }[];
    index?: number;
    onclose?: () => void;
        onrecommend?: (path: string) => void;
  } = $props();

  let creatorName = $state('');

  $effect(() => {
    const img = images[index];
    if (!img?.creator_id) {
      creatorName = '';
      return;
    }
    creatorName = '';
    resolveUsername(img.creator_id).then((name) => {
      if (images[index]?.creator_id === img.creator_id) {
        creatorName = name;
      }
    });
  });

  function getPath(src: string): string | null {
    return new URL(src, location.origin).searchParams.get('path');
  }

  function prev() {
    if (index > 0) index--;
  }

  function next() {
    if (index < images.length - 1) index++;
  }

  function handleKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') onclose?.();
    if (e.key === 'ArrowLeft') prev();
    if (e.key === 'ArrowRight') next();
  }

  function handleBackdrop(e: MouseEvent) {
    if ((e.target as HTMLElement).dataset.backdrop) onclose?.();
  }

  function handleForkClick() {
    console.log('[FORK] lightbox handleForkClick start');
    const img = images[index];
    if (!img) return;
    const p = getPath(img.src);
    if (p) {
        console.log('[FORK] lightbox calling onfork');
        onfork?.(p);
      }
      console.log('[FORK] lightbox about to close');
      onclose?.();
    onclose?.();
  }

  function recommend() {
    const img = images[index];
    if (!img) return;
    const p = getPath(img.src);
    if (p) onrecommend?.(p);
  }

  function handleDownload() {
    const img = images[index];
    if (!img) return;
    const p = getPath(img.src);
    if (!p) return;
    const a = document.createElement('a');
    a.href = getImageDownloadUrl(p);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
</script>

<svelte:window onkeydown={handleKey} />

{#if open && images.length > 0}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
    data-backdrop="1"
    onclick={handleBackdrop}
    role="dialog"
    aria-modal="true"
  >
    <!-- Close -->
    <button
      class="absolute top-4 right-4 text-white/80 hover:text-white z-10"
      onclick={() => onclose?.()}
    >
      <Icon icon="mdi:close" class="size-8" />
    </button>

    <!-- Image / Video -->
    <div class="relative flex items-center justify-center w-full h-full px-16 py-12">
      {#if (images[index].cached || images[index].src).match(/\.(mp4|webm)(\?|&|$)/)}
        <video
          src={images[index].cached || images[index].src}
          controls autoplay loop
          class="max-w-full max-h-full"
        />
      {:else}
        <img
          src={images[index].cached || images[index].src}
          alt=""
          class="max-w-full max-h-full object-contain"
          oncontextmenu={(e) => e.stopPropagation()}
        />
      {/if}
    </div>

    <!-- Prev -->
    {#if index > 0}
      <button
        class="absolute left-2 top-1/2 -translate-y-1/2 text-white/60 hover:text-white p-2"
        onclick={prev}
      >
        <Icon icon="mdi:chevron-left" class="size-10" />
      </button>
    {/if}

    <!-- Next -->
    {#if index < images.length - 1}
      <button
        class="absolute right-2 top-1/2 -translate-y-1/2 text-white/60 hover:text-white p-2"
        onclick={next}
      >
        <Icon icon="mdi:chevron-right" class="size-10" />
      </button>
    {/if}

    <!-- Bottom bar -->
    <div class="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-4">
      <button
        class="text-white/90 text-sm bg-white/10 px-3 py-1.5 rounded hover:bg-white/20 transition-colors flex items-center gap-1.5"
        onclick={handleDownload}
        title="下载原图（不经过 Webp 转换）"
      >
        <Icon icon="mdi:download" class="size-4" />
        下载原图
      </button>
      {#if images[index].creator_id}
        <a
          href={`/forum/u/?id=${images[index].creator_id}`}
          target="_blank"
          class="text-white/90 text-sm bg-white/10 px-3 py-1.5 rounded hover:bg-white/20 transition-colors"
        >
          生图者: {creatorName ? `${creatorName} (UID:${images[index].creator_id})` : `UID:${images[index].creator_id}`}
        </a>
      {/if}
      {#if onfork}
        <button
          class="text-white/90 text-sm bg-white/10 px-3 py-1.5 rounded hover:bg-white/20 transition-colors flex items-center gap-1.5"
          onclick={handleForkClick}
        >
          <Icon icon="mdi:source-fork" class="size-4" />
          Fork
        </button>
      {/if}
      {#if onrecommend}
        <button
          class="text-white/90 text-sm bg-white/10 px-3 py-1.5 rounded hover:bg-white/20 transition-colors flex items-center gap-1.5"
          onclick={recommend}
        >
          <Icon icon="mdi:star-plus-outline" class="size-4" />
          自荐
        </button>
      {/if}
      <span class="text-white/50 text-xs">{index + 1} / {images.length}</span>
    </div>
  </div>
{/if}
