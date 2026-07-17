<script lang="ts">
  import Icon from '@iconify/svelte';
  import { siteConfig } from '$lib/config/site';
  import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
  import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '$lib/components/ui/card';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { Alert, AlertDescription } from '$lib/components/ui/alert';
  import { forumAuth } from '$lib/forum/stores/auth';
  import { drawEnv } from '$lib/draw/stores/env';
  import { getImageProxyUrl, getImageUrl } from '$lib/draw/api/client';
  import * as collab from '$lib/draw/api/collaborator';
  import { onMount, onDestroy } from 'svelte';
  import ImageLightbox from '$lib/components/draw/ImageLightbox.svelte';

  let authToken = $state<string | null>(null);
  let currentBaseUrl = $state('');

  // Images tab
  let allImages = $state<{ path: string; mtime: number; user_id: string }[]>([]);
  let imagesTotal = $state(0);
  let imagesOffset = $state(0);
  let imagesLimit = $state(50);
  let imagesLoading = $state(false);
  let loadingMore = $state(false);
  let hasMore = $state(false);
  let sentinelEl: HTMLDivElement | undefined = $state();
  let io: IntersectionObserver | null = null;
  let selectedPaths = $state<Set<string>>(new Set());
  let selectMode = $state(false);

  // Column masonry
  let columnCount = $state(4);
  let imgColumns = $state<string[][]>([[], [], [], []]);
  let columnHeights: number[] = [0, 0, 0, 0];

  // Nominations tab
  let myNominations = $state<any[]>([]);
  let nominationsLoaded = $state(false);
  let nomItems = $derived(myNominations.flatMap((n: any) => n.image_paths.map((p: string) => ({ path: p, status: n.status, submitted_at: n.submitted_at, id: n.id, note: n.note, admin_reason: n.admin_reason }))));
  let nomColumns = $state<string[][]>([]);
  let nomColumnHeights: number[] = [];

  // Common
  let loading = $state(false);
  let message = $state<{ type: 'success' | 'error'; text: string } | null>(null);
  let activeTab = $state('images');

  // Lightbox
  let lbOpen = $state(false);
  let lbIndex = $state(0);
  let lbImages = $state<{ src: string; creator_id?: string; cached?: string }[]>([]);

  function showMsg(type: 'success' | 'error', text: string) {
    message = { type, text };
    setTimeout(() => (message = null), 3000);
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

  function pushToShortest(path: string) {
    let minIdx = 0;
    for (let i = 1; i < columnHeights.length; i++) {
      if (columnHeights[i] < columnHeights[minIdx]) minIdx = i;
    }
    imgColumns[minIdx] = [...imgColumns[minIdx], path];
    columnHeights[minIdx] += 1;
  }

  function rebuildColumns() {
    columnCount = getColumnCount();
    imgColumns = Array.from({ length: columnCount }, () => []);
    columnHeights = new Array(columnCount).fill(0);
    for (const item of allImages) pushToShortest(item.path);
    imgColumns = [...imgColumns];
  }

  function rebuildNomColumns() {
    const cc = getColumnCount();
    nomColumns = Array.from({ length: cc }, () => []);
    nomColumnHeights = new Array(cc).fill(0);
    for (const item of nomItems) {
      let minIdx = 0;
      for (let i = 1; i < nomColumnHeights.length; i++) {
        if (nomColumnHeights[i] < nomColumnHeights[minIdx]) minIdx = i;
      }
      nomColumns[minIdx] = [...nomColumns[minIdx], item.path];
      nomColumnHeights[minIdx] += 1;
    }
  }

  function handleResize() {
    const nu = getColumnCount();
    if (nu === columnCount) return;
    columnCount = nu;
    rebuildColumns();
  }

  function toggleSelect(path: string) {
    const next = new Set(selectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    selectedPaths = next;
  }

  function handleImgLoad(e: Event) {
    const img = e.currentTarget as HTMLImageElement;
    if (img.naturalWidth && img.naturalHeight) {
      img.style.aspectRatio = `${img.naturalWidth / img.naturalHeight}`;
    }
  }

  function openLb(index: number) {
    lbIndex = index;
    lbImages = allImages.map(i => ({ src: getImageUrl(i.path), creator_id: i.user_id, cached: getImageProxyUrl(i.path) }));
    lbOpen = true;
  }

  async function loadImages() {
    console.log('[collab] loadImages called, loading=', imagesLoading, 'auth=', !!authToken);
    if (imagesLoading) return;
    imagesLoading = true;
    console.log('[collab] fetching images...');
    try {
      const res = await collab.getAllImages(imagesLimit, 0);
      console.log('[collab] API response:', res);
      allImages = res.items;
      imagesTotal = res.total;
      imagesOffset = res.items.length;
      imagesLoading = false;
      hasMore = imagesOffset < imagesTotal;
      console.log('[collab] rebuilding columns, total=', imagesTotal);
      rebuildColumns();
      if (sentinelEl && !io) {
        io = new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting && !loadingMore && hasMore)) loadMoreImages();
          },
          { rootMargin: '400px 0px' }
        );
        io.observe(sentinelEl);
      }
      console.log('[collab] done, imagesLoading=', imagesLoading);
    } catch (e) {
      console.error('[collab] loadImages ERROR:', e, 'msg:', (e as any).message);
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    } finally {
      console.log('[collab] finally block, setting imagesLoading=false');
      imagesLoading = false;
    }
  }

  async function loadMoreImages() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    try {
      const res = await collab.getAllImages(imagesLimit, imagesOffset);
      const newItems = res.items.filter((v: any) => !allImages.some((ex: any) => ex.path === v.path));
      allImages = [...allImages, ...newItems];
      imagesOffset += res.items.length;
      for (const item of newItems) pushToShortest(item.path);
      imgColumns = [...imgColumns];
      hasMore = imagesOffset < imagesTotal;
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    } finally {
      loadingMore = false;
    }
  }

  async function loadMyNominations() {
    if (nominationsLoaded) return;
    try {
      const res = await collab.getMyNominations();
      myNominations = res.items;
      nominationsLoaded = true;
      rebuildNomColumns();
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    }
  }

  async function submitNomination() {
    const paths = [...selectedPaths];
    if (!paths.length) return;
    loading = true;
    try {
      await collab.submitNomination(paths);
      showMsg('success', `已提交 ${paths.length} 张图片的精选提名，等待管理员审核`);
      selectedPaths = new Set();
      selectMode = false;
      nominationsLoaded = false;
      loadMyNominations();
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '提交失败');
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    authToken = forumAuth.getToken();
    console.log("[collab] auth effect: token=", authToken ? authToken.slice(0,10)+"..." : null);
    const u = drawEnv.baseUrl.subscribe((v) => (currentBaseUrl = v));
    return u;
  });

  $effect(() => {
    const tab = activeTab;
    console.log('[collab] tab effect: tab=', tab, 'authToken=', !!authToken);
    if (!authToken) return;
    switch (tab) {
      case 'images': if (allImages.length === 0) { console.log('[collab] tab switch -> loadImages'); loadImages(); } break;
      case 'nominations': loadMyNominations(); break;
    }
  });

  onMount(() => {
    columnCount = getColumnCount();
    imgColumns = Array.from({ length: columnCount }, () => []);
    columnHeights = new Array(columnCount).fill(0);
    window.addEventListener('resize', handleResize, { passive: true });
  });


  $effect(() => {
    const el = sentinelEl;
    if (!el) return;
    io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting && !loadingMore && hasMore)) loadMoreImages();
      },
      { rootMargin: '400px 0px' }
    );
    io.observe(el);
    return () => io?.disconnect();
  });

  onDestroy(() => {
    window.removeEventListener('resize', handleResize);
  });
</script>

<svelte:head>
  <title>协作者 - {siteConfig.title}</title>
</svelte:head>

<div class="w-full max-w-4xl mx-auto px-4 py-6 space-y-4">
  <div class="flex items-center gap-2">
    <Icon icon="mdi:account-group-outline" class="size-6 text-primary" />
    <h1 class="text-xl font-bold">协作者面板</h1>
  </div>

  {#if !authToken}
    <Alert>
      <Icon icon="mdi:account-alert-outline" class="size-4" />
      <AlertDescription class="text-xs">
        请先<a href="/forum/auth/login?redirect=/draw/admin/collaborator/" class="underline font-medium">登录论坛</a>后使用。
      </AlertDescription>
    </Alert>
  {:else}
    {#if message}
      <Alert variant={message.type === 'error' ? 'destructive' : 'default'}>
        <Icon icon={message.type === 'error' ? 'mdi:alert-circle' : 'mdi:check-circle'} class="size-4" />
        <AlertDescription class="text-xs">{message.text}</AlertDescription>
      </Alert>
    {/if}

    <Tabs bind:value={activeTab} class="w-full">
      <TabsList class="w-full">
        <TabsTrigger value="images" class="flex-1">
          <Icon icon="mdi:image-multiple-outline" class="size-4 mr-1" />图片
        </TabsTrigger>

        <TabsTrigger value="nominations" class="flex-1">
          <Icon icon="mdi:send-outline" class="size-4 mr-1" />我的提名
        </TabsTrigger>
      </TabsList>

      <!-- Images Tab -->
      <TabsContent value="images" class="mt-4 space-y-4">
        <div class="sticky top-14 z-10 bg-background py-2 flex flex-wrap gap-2 items-center border-b">
          <Button variant={selectMode ? 'default' : 'outline'} size="sm" onclick={() => { selectMode = !selectMode; }}>
            <Icon icon="mdi:select" class="size-4 mr-1" />
            {selectMode ? '取消选择' : '选择'}
          </Button>
          {#if selectedPaths.size > 0}
            <Button variant="default" size="sm" onclick={submitNomination} disabled={loading}>
              <Icon icon="mdi:send" class="size-4 mr-1" />
              提交提名 ({selectedPaths.size})
            </Button>
          {/if}
        </div>

        {#if imagesLoading}
          <div class="text-sm text-muted-foreground py-8 text-center">加载中...</div>
        {:else if allImages.length === 0}
          <div class="text-sm text-muted-foreground py-8 text-center">暂无图片</div>
        {:else}
          <div class="flex gap-2 items-start">
            {#each imgColumns as col, ci (ci)}
              <div class="flex flex-1 flex-col gap-2 min-w-0">
                {#each col as path (ci + '-' + path)}
                  {@const img = allImages.find(i => i.path === path)}
                  {#if img}
                    <div class="relative group rounded-md overflow-hidden border hover:ring-2 hover:ring-primary/50 transition-all cursor-pointer"
                      role="button" tabindex="0"
                      onclick={() => { if (selectMode) toggleSelect(img.path); else openLb(allImages.indexOf(img)); }}
                    >
                      <img
                        src={getImageProxyUrl(img.path)}
                        alt={img.path}
                        loading="lazy"
                        decoding="async"
                        style="aspect-ratio: 1;"
                        onload={handleImgLoad}
                        class="block w-full h-auto bg-muted"
                      />
                      {#if selectMode}
                        <div class="absolute top-1 left-1 flex items-center justify-center" onclick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={selectedPaths.has(img.path)} onchange={() => toggleSelect(img.path)} class="size-4 accent-primary" />
                        </div>
                      {/if}
                      <div class="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[10px] px-1 py-0.5 truncate pointer-events-none">
                        UID {img.user_id || '?'}
                      </div>
                    </div>
                  {/if}
                {/each}
              </div>
            {/each}
          </div>
          {#if !hasMore && allImages.length > 0}
            <div class="text-center text-xs text-muted-foreground py-2">已加载全部</div>
          {/if}
          <div bind:this={sentinelEl} class="h-4"></div>
        {/if}
      </TabsContent>

      <!-- My Nominations Tab -->
      <TabsContent value="nominations" class="mt-4">
        {#if !nominationsLoaded}
          <div class="text-sm text-muted-foreground py-8 text-center">加载中...</div>
        {:else if nomItems.length === 0}
          <div class="text-sm text-muted-foreground py-8 text-center">暂无提名记录</div>
        {:else}
          <div class="flex gap-2 items-start">
            {#each nomColumns as col, ci (ci)}
              <div class="flex flex-1 flex-col gap-2 min-w-0">
                {#each col as path (ci + '-' + path)}
                  {@const item = nomItems.find(i => i.path === path)}
                  {#if item}
                    <div class="relative group rounded-md overflow-hidden border">
                      <img src={getImageProxyUrl(item.path)} alt={item.path} loading="lazy" decoding="async" style="aspect-ratio: 1;" onload={handleImgLoad} class="block w-full h-auto bg-muted" />
                      <div class="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[10px] px-1 py-0.5 truncate pointer-events-none flex items-center gap-1">
                        <span class="flex-1">{item.path}</span>
                        <Badge variant={item.status === 'approved' ? 'default' : item.status === 'rejected' ? 'destructive' : 'secondary'} class="text-[9px] px-1 py-0 shrink-0">
                          {item.status === 'approved' ? '已批准' : item.status === 'rejected' ? '已拒绝' : '待审核'}
                        </Badge>
                      </div>
                    </div>
                  {/if}
                {/each}
              </div>
            {/each}
          </div>
        {/if}
      </TabsContent>
    </Tabs>

    <ImageLightbox
      open={lbOpen}
      images={lbImages}
      index={lbIndex}
      onclose={() => (lbOpen = false)}
    />
  {/if}
</div>
