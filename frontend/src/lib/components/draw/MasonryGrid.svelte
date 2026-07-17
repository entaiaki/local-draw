<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { getImageProxyUrl } from '$lib/draw/api/client';

  let {
    items = [],
    itemClass = 'masonry-item',
    sizerClass = 'masonry-sizer',
    onItemClick,
    children,
  }: {
    items: { path: string; creator_id?: string; user_id?: string }[];
    itemClass?: string;
    sizerClass?: string;
    onItemClick?: (path: string) => void;
    children?: import('svelte').Snippet<[{ item: { path: string; creator_id?: string; user_id?: string }; imgUrl: string }]>;
  } = $props();

  let masonryEl: HTMLDivElement | undefined;
  let displayLimit = $state(5);
  let hasMore = $derived(displayLimit < items.length);

  $effect(() => {
    if (masonryEl && items.length > 0) {
      const timer = setTimeout(() => {
        import('masonry-layout').then(m => {
          new m.default(masonryEl!, {
            itemSelector: '.' + itemClass.split(' ')[0],
            columnWidth: '.' + sizerClass.split(' ')[0],
            percentPosition: true,
          });
        });
      }, 50);
      return () => clearTimeout(timer);
    }
  });

  function loadMore() {
    displayLimit = Math.min(displayLimit + 10, items.length);
    setTimeout(() => {
      if (masonryEl) {
        import('masonry-layout').then(m => {
          new m.default(masonryEl!, {
            itemSelector: '.' + itemClass.split(' ')[0],
            columnWidth: '.' + sizerClass.split(' ')[0],
            percentPosition: true,
          });
        });
      }
    }, 100);
  }
</script>

<div bind:this={masonryEl} class="relative w-full">
  <div class="{sizerClass} w-1/2 md:w-1/3 lg:w-1/4 xl:w-1/5"></div>
  {#each items.slice(0, displayLimit) as item (item.path)}
    <div class="{itemClass} w-1/2 md:w-1/3 lg:w-1/4 xl:w-1/5 p-1">
      {#if children}
        {@render children({ item, imgUrl: getImageProxyUrl(item.path) })}
      {:else}
        <button
          type="button"
          class="w-full rounded-lg overflow-hidden border hover:ring-2 hover:ring-primary/50 transition-all cursor-pointer"
          onclick={() => onItemClick?.(item.path)}
        >
          <img
            src={getImageProxyUrl(item.path)}
            alt={item.path}
            loading="lazy"
            decoding="async"
            class="block w-full h-auto bg-muted"
          />
        </button>
      {/if}
    </div>
  {/each}
</div>
{#if hasMore}
  <div class="flex justify-center pt-2">
    <Button variant="outline" size="sm" onclick={loadMore}>
      加载更多（{items.length - displayLimit} 张）
    </Button>
  </div>
{/if}
