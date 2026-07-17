<script lang="ts">
  import Icon from '@iconify/svelte';
  import { siteConfig } from '$lib/config/site';
  import { Button } from '$lib/components/ui/button';
  import { Alert, AlertDescription } from '$lib/components/ui/alert';
  import { Badge } from '$lib/components/ui/badge';
  import { forumAuth } from '$lib/forum/stores/auth';
  import { drawEnv, resolveApiRedirect, apiError } from '$lib/draw/stores/env';
  import EnvironmentSwitcher from '$lib/components/draw/EnvironmentSwitcher.svelte';
  import { forumToast } from '$lib/forum/stores/toast';
  import { get } from 'svelte/store';

  let currentBaseUrl = $state('');
  let authToken = $state<string | null>(null);
  let isLoggedIn = $derived(!!authToken);
  let apiErrorMessage = $state('');

  let images = $state<File[]>([]);
  let imagePreviews = $state<string[]>([]);
  let prompt = $state('');
  let generating = $state(false);
  let translating = $state(false);
  let error = $state('');
  let resultImages = $state<{ url: string; filename: string; subfolder: string; image_type: string }[]>([]);

  $effect(() => {
    const unsub = apiError.subscribe((v) => {
      apiErrorMessage = v || '';
      if (v) forumToast.add('error', 'API 错误', v);
    });
    return unsub;
  });

  $effect(() => {
    const u1 = drawEnv.baseUrl.subscribe((v) => (currentBaseUrl = v));
    authToken = forumAuth.getToken();
    return u1;
  });

  $effect(() => {
    if (error) forumToast.add('error', '错误', error);
  });

  function handleFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.length) return;
    const newFiles = Array.from(input.files);
    const remaining = 2 - images.length;
    if (remaining <= 0) return;
    const added = newFiles.slice(0, remaining);
    for (const f of added) {
      images.push(f);
      imagePreviews.push(URL.createObjectURL(f));
    }
    input.value = '';
  }

  function removeImage(idx: number) {
    URL.revokeObjectURL(imagePreviews[idx]);
    images.splice(idx, 1);
    imagePreviews.splice(idx, 1);
  }

  async function handleTranslate() {
    if (!prompt.trim() || translating) return;
    translating = true;
    try {
      const token = forumAuth.getToken();
      const baseUrl = get(drawEnv.baseUrl);
      const resp = await fetch(`${baseUrl}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ prompt, mode: 'anima' }),
      });
      const data = await resp.json();
      if (data.ok) prompt = data.positive;
      else error = data.error || '翻译失败';
    } catch (e) {
      error = '翻译失败: ' + (e instanceof Error ? e.message : '未知错误');
    } finally {
      translating = false;
    }
  }

  async function startGeneration() {
    if (generating || images.length === 0) return;

    await resolveApiRedirect();
    const token = forumAuth.getToken();
    if (!token) {
      error = '请先在论坛登录';
      return;
    }
    if (!prompt.trim()) {
      error = '请输入描述';
      return;
    }

    generating = true;
    error = '';
    resultImages = [];

    try {
      const form = new FormData();
      form.append('token', token);
      form.append('prompt', prompt.trim());
      form.append('image1', images[0]);
      if (images.length > 1) form.append('image2', images[1]);

      const baseUrl = get(drawEnv.baseUrl);
      const resp = await fetch(`${baseUrl}/api/img2img/run`, {
        method: 'POST',
        body: form,
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ message: resp.statusText }));
        throw new Error(body.message || body.detail || '生成失败');
      }

      const data = await resp.json();
      resultImages = data.images || [];
    } catch (e) {
      error = e instanceof Error ? e.message : '生成失败';
    } finally {
      generating = false;
    }
  }

  function getResultUrl(img: { url: string; filename: string; subfolder: string; image_type: string }): string {
    const baseUrl = get(drawEnv.baseUrl);
    const url = new URL('/api/image', baseUrl);
    url.searchParams.set('filename', img.filename);
    url.searchParams.set('subfolder', img.subfolder);
    url.searchParams.set('type', img.image_type);
    return url.toString();
  }
</script>

<svelte:head>
  <title>图生图 - {siteConfig.title}</title>
</svelte:head>

<div class="w-full max-w-2xl mx-auto px-4 py-6 space-y-4">
  <!-- Header -->
  <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
    <div class="flex items-center gap-2">
      <Icon icon="mdi:image-edit-outline" class="size-6 text-primary" />
      <h1 class="text-xl font-bold">图生图</h1>
    </div>
    <div class="flex items-center gap-2">
      <a href="/draw" class="text-sm text-muted-foreground hover:text-foreground underline">文生图</a>
    </div>
  </div>

  <EnvironmentSwitcher />

  {#if !isLoggedIn}
    <Alert>
      <Icon icon="mdi:account-alert-outline" class="size-4" />
      <AlertDescription class="text-xs">
        请先<a href="/forum/auth/login?redirect=/draw/img2img/" class="underline font-medium">登录论坛</a>后使用图生图功能。
      </AlertDescription>
    </Alert>
  {/if}

  <!-- Image Upload -->
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium flex items-center gap-1.5">
        <Icon icon="mdi:image-plus" class="size-4" />
        上传图片
        <Badge variant="secondary" class="text-xs">{images.length}/2</Badge>
      </h3>
    </div>

    <div class="flex gap-3 flex-wrap">
      {#each imagePreviews as preview, i}
        <div class="relative group">
          <img
            src={preview}
            alt="preview {i}"
            class="size-28 object-cover rounded-lg border border-border"
          />
          <button
            class="absolute -top-2 -right-2 size-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            onclick={() => removeImage(i)}
            title="移除"
          >
            <Icon icon="mdi:close" class="size-3" />
          </button>
        </div>
      {/each}

      {#if images.length < 2}
        <label class="size-28 rounded-lg border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-primary/50 transition-colors text-muted-foreground">
          <Icon icon="mdi:plus" class="size-6" />
          <span class="text-xs">{images.length === 0 ? '选择图片' : '第二张'}</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            class="hidden"
            onchange={handleFileInput}
          />
        </label>
      {/if}
    </div>
  </div>

  <!-- Prompt -->
  <div class="space-y-2">
    <h3 class="text-sm font-medium flex items-center gap-1.5">
      <Icon icon="mdi:text-box-outline" class="size-4" />
      描述
    </h3>
    <textarea
      bind:value={prompt}
      placeholder="输入你想要的修改描述，例如：把人物的衣服换成红色"
      class="w-full min-h-[80px] rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
      disabled={generating}
    ></textarea>
    <div class="flex items-center gap-2">
      <Button size="sm" variant="outline" onclick={handleTranslate} disabled={translating || !prompt.trim()}>
        <Icon icon={translating ? "mdi:loading" : "mdi:auto-fix"} class="size-4 mr-1 {translating ? 'animate-spin' : ''}" />
        {translating ? "转换中..." : "翻译为英文"}
      </Button>
      <span class="text-[11px] text-muted-foreground">支持中文，但英文遵从度更好</span>
    </div>
  </div>

  <!-- Run Button -->
  <Button
    class="w-full gap-2"
    onclick={startGeneration}
    disabled={!isLoggedIn || generating || images.length === 0}
  >
    {#if generating}
      <Icon icon="mdi:loading" class="size-4 animate-spin" />
      生成中...
    {:else}
      <Icon icon="mdi:play" class="size-4" />
      开始生成
    {/if}
  </Button>

  <!-- Results -->
  {#if resultImages.length > 0}
    <div class="space-y-3">
      <h3 class="text-sm font-medium flex items-center gap-1.5">
        <Icon icon="mdi:image-check" class="size-4" />
        生成结果
      </h3>
      <div class="grid grid-cols-2 gap-3">
        {#each resultImages as img}
          <div class="relative group">
            <img
              src={getResultUrl(img)}
              alt="result"
              class="w-full rounded-lg border border-border"
              loading="lazy"
            />
            <div class="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100">
              <a
                href={getResultUrl(img)}
                download={img.filename}
                class="p-2 rounded-full bg-background/90 text-foreground shadow"
              >
                <Icon icon="mdi:download" class="size-5" />
              </a>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
