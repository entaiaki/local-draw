<script lang="ts">
import Icon from '@iconify/svelte';
import { Button } from '$lib/components/ui/button';
import { Label } from '$lib/components/ui/label';
import { Alert, AlertDescription } from '$lib/components/ui/alert';
import { Badge } from '$lib/components/ui/badge';
  import { forumAuth } from '$lib/forum/stores/auth';
  import { drawEnv, apiError } from '$lib/draw/stores/env';
  import TurnstileWidget from '$lib/components/TurnstileWidget.svelte';
  import { compressPostImage } from '$lib/forum/utils/image-compression';
  import { addToQueue } from '$lib/draw/api/client';
  import { get } from 'svelte/store';

  let {
    turnstileToken = $bindable(''),
      turnstileTick = $bindable(0),
    pointsCostSubmit = 0,
    llmTokenPerPoint = 0,
    turnstileEnabled = false,
    maxImages = 2,
    workflowPath = '',
    showConsistency = false,
  }: {
    turnstileToken?: string;
      turnstileTick?: number;
    pointsCostSubmit?: number;
    llmTokenPerPoint?: number;
    turnstileEnabled?: boolean;
    maxImages?: number;
    workflowPath?: string;
    showConsistency?: boolean;
  } = $props();
  let storageKey = $derived('draw-img2img-' + (workflowPath || 'flux'));

  let currentBaseUrl = $state('');
  let authToken = $state<string | null>(null);
  let isLoggedIn = $derived(!!authToken);
  let apiErrorMessage = $state('');

  let images = $state<{ file: File; dataUrl: string }[]>([]);
  let dragIndex = $state<number | null>(null);
  let dragOverIndex = $state<number | null>(null);
  let cnPrompt = $state('');
  let enPrompt = $state('');
  let uploading = $state(false);
  let translating = $state(false);
  let consistency = $state(false);
  let uploadProgress = $state(0);
  let error = $state('');
  let queueSuccess = $state('');

  function uploadFileWithProgress(url: string, headers: Headers, form: FormData, onProgress: (pct: number) => void): Promise<Response> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      headers.forEach((value, key) => xhr.setRequestHeader(key, value));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        const headers = new Headers();
        xhr.getAllResponseHeaders().split('\r\n').forEach(line => {
          const [k, ...v] = line.split(': ');
          if (k) headers.set(k, v.join(': '));
        });
        resolve(new Response(xhr.responseText, { status: xhr.status, headers }));
      };
      xhr.onerror = () => reject(new Error('上传失败'));
      xhr.send(form);
    });
  }

  function handleDragStart(i: number) {
    dragIndex = i;
  }

  function handleDragOver(e: Event, i: number) {
    e.preventDefault();
    dragOverIndex = i;
  }

  function handleDrop(i: number) {
    if (dragIndex === null || dragIndex === i) {
      dragIndex = null;
      dragOverIndex = null;
      return;
    }
    const arr = [...images];
    const [moved] = arr.splice(dragIndex, 1);
    arr.splice(i, 0, moved);
    images = arr;
    dragIndex = null;
    dragOverIndex = null;
    saveState();
  }

  function handleDragEnd() {
    dragIndex = null;
    dragOverIndex = null;
  }

  let touchStartX = 0;
  let touchStartY = 0;

  function handleTouchStart(e: TouchEvent, i: number) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    dragIndex = i;
  }

  function handleTouchMove(e: TouchEvent) {
    if (dragIndex === null) return;
    e.preventDefault();
    const touch = e.touches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('[data-img-index]') as HTMLElement | null;
    if (el) {
      const idx = parseInt(el.dataset.imgIndex || '', 10);
      if (!isNaN(idx)) dragOverIndex = idx;
    }
  }

  function handleTouchEnd() {
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      const arr = [...images];
      const [moved] = arr.splice(dragIndex, 1);
      arr.splice(dragOverIndex, 0, moved);
      images = arr;
      saveState();
    }
    dragIndex = null;
    dragOverIndex = null;
  }

  $effect(() => {
    const unsub = apiError.subscribe((v) => {
      apiErrorMessage = v || '';
    });
    return unsub;
  });

  $effect(() => {
    const u1 = drawEnv.baseUrl.subscribe((v) => (currentBaseUrl = v));
    authToken = forumAuth.getToken();
    return u1;
  });

  // Restore state from localStorage
  $effect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (parsed.cnPrompt) cnPrompt = parsed.cnPrompt;
      if (parsed.enPrompt) enPrompt = parsed.enPrompt;
      if (parsed.images?.length) {
        for (const dataUrl of parsed.images) {
          fetch(dataUrl)
            .then(r => r.blob())
            .then(blob => {
              const ext = dataUrl.split(';')[0].split('/')[1] || 'png';
              const file = new File([blob], `img2img.${ext}`, { type: blob.type });
              images = [...images, { file, dataUrl }];
            })
            .catch(() => {});
        }
      }
    } catch {}
  });

  function saveState() {
    try {
      if (typeof localStorage === 'undefined') return;
      const data: any = { cnPrompt, enPrompt };
      const savedDataUrls = images.map(i => i.dataUrl).filter(u => u.startsWith('data:'));
      if (savedDataUrls.length) data.images = savedDataUrls;
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {}
  }

  function handleFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.length) return;
    const newFiles = Array.from(input.files);
    const remaining = maxImages - images.length;
    if (remaining <= 0) return;
    const added = newFiles.slice(0, remaining);
    let loaded = 0;
    for (const f of added) {
      const idx = images.length;
      const url = URL.createObjectURL(f);
      images = [...images, { file: f, dataUrl: url }];
      const reader = new FileReader();
      reader.onload = () => {
        const arr = images;
        arr[idx] = { ...arr[idx], dataUrl: reader.result as string };
        images = arr;
        URL.revokeObjectURL(url);
        if (++loaded >= added.length) saveState();
      };
      reader.readAsDataURL(f);
    }
    input.value = '';
  }

  function removeImage(idx: number) {
    URL.revokeObjectURL(images[idx].dataUrl);
    images = images.filter((_, i) => i !== idx);
    saveState();
  }

  async function handleTranslate() {
    if (!cnPrompt.trim() || translating) return;
    translating = true;
    try {
      const token = forumAuth.getToken();
      const baseUrl = get(drawEnv.baseUrl);
      const resp = await fetch(`${baseUrl}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ prompt: cnPrompt, mode: 'anima' }),
      });
      const data = await resp.json();
      if (data.ok) { enPrompt = data.positive; saveState(); }
      else error = data.error || '翻译失败';
    } catch (e) {
      error = '翻译失败: ' + (e instanceof Error ? e.message : '未知错误');
    } finally {
      translating = false;
    }
  }

  function handleCnInput(e: Event) {
    cnPrompt = (e.target as HTMLTextAreaElement).value;
    saveState();
  }

  function handleEnInput(e: Event) {
    enPrompt = (e.target as HTMLTextAreaElement).value;
    saveState();
  }
  async function doUpload(): Promise<{ image1_name: string; image2_name?: string; image3_name?: string }> {
    const token = forumAuth.getToken()!;
    const form = new FormData();
    const compressed1 = await compressPostImage(images[0].file);
      form.append('image1', compressed1);
    if (images.length > 1) {
      const compressed2 = await compressPostImage(images[1].file);
      form.append('image2', compressed2);
    }

    const baseUrl = get(drawEnv.baseUrl);
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${token}`);

    const uploadResp = await uploadFileWithProgress(`${baseUrl}/api/img2img/upload`, headers, form, (pct) => {
      uploadProgress = pct;
    });

    if (!uploadResp.ok) {
      const body = await uploadResp.json().catch(() => ({ message: uploadResp.statusText }));
      throw new Error(body.message || body.detail || '上传失败');
    }

    return await uploadResp.json();
  }

  async function startGeneration() {
    if (uploading || images.length === 0) return;

    const token = forumAuth.getToken();
    if (!token) {
      error = '请先在论坛登录';
      return;
    }
    if (!enPrompt.trim() && !cnPrompt.trim()) {
      error = '请输入描述';
      return;
    }

    error = '';
    queueSuccess = '';
    uploading = true;
    uploadProgress = 0;

    try {
      const uploadData = await doUpload();
      const queuePayload: any = {
        direct_prompt: enPrompt.trim() || cnPrompt.trim(),
        image1_name: uploadData.image1_name,
        turnstile_token: turnstileToken || undefined,
      };
      if (uploadData.image2_name) queuePayload.image2_name = uploadData.image2_name;
      if (uploadData.image3_name) queuePayload.image3_name = uploadData.image3_name;
      if (workflowPath) queuePayload.workflow_path = workflowPath;
      await addToQueue(queuePayload);
      uploading = false;
        turnstileTick++;
      queueSuccess = '成功加入队列！等待生图中，前往"我的"页面查看详情。';
    } catch (e) {
      uploading = false;
      error = e instanceof Error ? e.message : '生成失败';
    }
  }
</script>

<div class="space-y-4">
  {#if !isLoggedIn}
    <Alert>
      <Icon icon="mdi:account-alert-outline" class="size-4" />
      <AlertDescription class="text-xs">
        请先<a href="/forum/auth/login?redirect=/draw/" class="underline font-medium">登录论坛</a>后使用图生图功能。
      </AlertDescription>
    </Alert>
  {/if}

  {#if apiErrorMessage}
    <Alert>
      <Icon icon="mdi:cloud-alert" class="size-4 shrink-0" />
      <AlertDescription class="text-xs">{apiErrorMessage}</AlertDescription>
    </Alert>
  {/if}

  <!-- Image Upload -->
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium flex items-center gap-1.5">
        <Icon icon="mdi:image-plus" class="size-4" />
        上传图片
        <Badge variant="secondary" class="text-xs">{images.length}/{maxImages}</Badge>
      </h3>
      {#if images.length > 1}
        <span class="text-xs text-muted-foreground">拖拽调整顺序</span>
      {/if}
    </div>

    <div class="flex gap-3 flex-wrap">
      {#each images as item, i}
        <div
          class="relative group {dragOverIndex === i && dragIndex !== null && dragIndex !== i ? 'ring-2 ring-primary rounded-lg' : ''}"
          data-img-index={i}
          draggable="true"
          ondragstart={() => handleDragStart(i)}
          ondragover={(e) => handleDragOver(e, i)}
          ondrop={() => handleDrop(i)}
          ondragend={handleDragEnd}
          ontouchstart={(e) => handleTouchStart(e, i)}
          ontouchmove={handleTouchMove}
          ontouchend={handleTouchEnd}
          oncontextmenu={(e) => e.preventDefault()}
          role="button"
          tabindex="-1"
        >
          <img
            src={item.dataUrl}
            alt="preview {i}"
            class="size-28 object-cover rounded-lg border border-border"
          />
          <div class="absolute top-1 left-1 size-5 rounded-full bg-background/80 flex items-center justify-center text-xs font-medium text-muted-foreground">
            {i + 1}
          </div>
          <button
            class="absolute -top-2 -right-2 size-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center "
            onclick={() => removeImage(i)}
            title="移除"
          >
            <Icon icon="mdi:close" class="size-3" />
          </button>
        </div>
      {/each}

      {#if images.length < maxImages}
        <label class="size-28 rounded-lg border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-primary/50 transition-colors text-muted-foreground">
          <Icon icon="mdi:plus" class="size-6" />
          <span class="text-xs">{images.length === 0 ? '选择图片' : '上传更多'}</span>
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
    <div class="space-y-1">
      <Label class="text-xs text-muted-foreground">中文描述</Label>
      <textarea
        value={cnPrompt}
        oninput={handleCnInput}
        placeholder="把人物的衣服换成红色"
        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
        rows={2}
        disabled={uploading}
      ></textarea>
    </div>
    <div class="flex items-center gap-2">
      <Button size="sm" variant="outline" onclick={handleTranslate} disabled={translating || !cnPrompt.trim()}>
        <Icon icon={translating ? "mdi:loading" : "mdi:auto-fix"} class="size-4 mr-1 {translating ? 'animate-spin' : ''}" />
        {translating ? "转换中..." : "翻译为英文"}
        {#if llmTokenPerPoint > 0 && cnPrompt?.length}{@const est = Math.max(1, Math.ceil(cnPrompt.length * 2 / (llmTokenPerPoint || 1)))}<Badge variant="secondary" class="ml-1 text-[10px] px-1">≈⚡{est}</Badge>{/if}
      </Button>
      <span class="text-[11px] text-muted-foreground">支持中文，但英文遵从度更好</span>
    </div>
    <div class="space-y-1">
      <Label class="text-xs text-muted-foreground">英文描述（最终使用的提示词）</Label>
      <textarea
        value={enPrompt}
        oninput={handleEnInput}
        placeholder="change the character's clothes to red"
        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
        rows={3}
        disabled={uploading}
      ></textarea>
    </div>
  </div>

  {#if showConsistency}
    <label class="flex items-center gap-2 text-xs cursor-pointer">
      <input type="checkbox" bind:checked={consistency} class="size-4 accent-primary" />
      <span>人物一致性</span>
    </label>
  {/if}

  {#if turnstileEnabled}
    <TurnstileWidget
        siteKey="0x4AAAAAADSVSh5jjelMNlrv"
        tick={turnstileTick}
        onToken={(t) => (turnstileToken = t)}
        onExpired={() => (turnstileToken = '')}
      />
  {/if}

    <!-- Run Button -->
  <Button
    class="w-full gap-2"
    onclick={startGeneration}
    disabled={!isLoggedIn || uploading || images.length === 0}
  >
    {#if uploading}
      <Icon icon="mdi:loading" class="size-4 animate-spin" />
      上传中 {uploadProgress}%
    {:else}
      <Icon icon="mdi:playlist-plus" class="size-5 mr-1.5" />
      加入队列
      {#if pointsCostSubmit > 0}<Badge variant="secondary" class="ml-1.5 text-[10px] px-1">⚡{pointsCostSubmit}</Badge>{/if}
    {/if}
  </Button>

  <!-- Error -->
  {#if error}
    <Alert variant="destructive">
      <Icon icon="mdi:alert-circle" class="size-4" />
      <AlertDescription class="text-xs">{error}</AlertDescription>
    </Alert>
  {/if}
    {#if queueSuccess}
      <Alert>
        <Icon icon="mdi:check-circle" class="size-4" />
        <AlertDescription class="text-xs">{queueSuccess}</AlertDescription>
      </Alert>
    {/if}
</div>
