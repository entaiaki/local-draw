<script lang="ts">
  import Icon from '@iconify/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { forumAuth } from '$lib/forum/stores/auth';
  import { drawEnv } from '$lib/draw/stores/env';
  import { get } from 'svelte/store';
  import { addToQueue, fetchPointsConfig } from '$lib/draw/api/client';
  import { forumToast } from '$lib/forum/stores/toast';
  import { onMount } from 'svelte';

  let dataUrl = $state('');
  let uploading = $state(false);
  let videoPrice = $state(600);

  onMount(async () => {
    try {
      const d = await fetchPointsConfig();
      if (d.text_to_video) videoPrice = d.text_to_video;
    } catch {}
    try { dataUrl = localStorage.getItem('draw-video') || ''; } catch {}
  });

  function saveUrl(url: string) {
    dataUrl = url;
    try { localStorage.setItem('draw-video', url); } catch {}
  }
  function clearUrl() {
    dataUrl = '';
    try { localStorage.removeItem('draw-video'); } catch {}
  }

  async function startGeneration() {
    if (uploading || !dataUrl) return;
    const token = forumAuth.getToken();
    if (!token) {
      forumToast.add('error', '登录', '请先在论坛登录');
      return;
    }

    uploading = true;

    try {
      const blob = await fetch(dataUrl).then(r => r.blob());
      const form = new FormData();
      form.append('image1', blob, 'image.png');

      const baseUrl = get(drawEnv.baseUrl);
      const headers = new Headers();
      headers.set('Authorization', `Bearer ${token}`);

      const uploadResp = await fetch(`${baseUrl}/api/img2img/upload?token=${token}`, {
        method: 'POST',
        body: form,
      });
      if (!uploadResp.ok) {
        const body = await uploadResp.json().catch(() => ({ message: uploadResp.statusText }));
        throw new Error(body.error || body.message || body.detail || '上传失败');
      }
      const uploadData = await uploadResp.json();

      const payload: any = {
        image1_name: uploadData.image1_name,
        workflow_path: 'WAN2.2/WAN2.2动态壁纸.json',
        turnstile_token: '',
      };

      await addToQueue(payload);
      uploading = false;
      forumToast.add('success', '成功', '已加入队列！前往"我的"页面查看进度。');
    } catch (e) {
      uploading = false;
      forumToast.add('error', '失败', e instanceof Error ? e.message : '生成失败');
    }
  }

  function handleFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.length) return;
    const file = input.files[0];
    const imgCheck = new Image();
    imgCheck.onload = () => {
      if (imgCheck.width > 4096 || imgCheck.height > 4096) {
        forumToast.add('error', '限制', `图片分辨率超出限制（${imgCheck.width}x${imgCheck.height}），最大支持 4096x4096`);
        input.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => saveUrl(reader.result as string);
      reader.readAsDataURL(file);
    };
    imgCheck.onerror = () => { forumToast.add('error', '错误', '无法读取图片'); };
    imgCheck.src = URL.createObjectURL(file);
    input.value = '';
  }

  function removeImage() {
    clearUrl();
  }
</script>

<div class="bg-zinc-900/50 rounded-lg p-3 text-xs text-zinc-400 border border-zinc-800 space-y-1">
  <p>⚡ 测试功能，生成时间≈200s，请耐心等待</p>
  <p>上传一张图片，AI 将生成动态壁纸视频（mp4）</p>
</div>

<div class="space-y-4 mt-4">
  <!-- Image Upload -->
  <div class="space-y-2">
    <h3 class="text-sm font-medium flex items-center gap-1.5">
      <Icon icon="mdi:image-plus" class="size-4" />
      上传图片
    </h3>
    <div class="flex gap-3 flex-wrap">
      {#if dataUrl}
        <div class="relative group">
          <img src={dataUrl} alt="preview" class="size-40 object-cover rounded-lg border border-border" />
          <button class="absolute -top-2 -right-2 size-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center" onclick={removeImage} title="移除">
            <Icon icon="mdi:close" class="size-3" />
          </button>
        </div>
      {:else}
        <label class="size-40 rounded-lg border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-primary/50 transition-colors text-muted-foreground">
          <Icon icon="mdi:plus" class="size-8" />
          <span class="text-xs">选择图片</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange={handleFileInput} />
        </label>
      {/if}
    </div>
  </div>

  <!-- Generate Button -->
  <Button class="w-full gap-2" onclick={startGeneration} disabled={!dataUrl || uploading}>
    {#if uploading}
      <Icon icon="mdi:loading" class="size-4 animate-spin" />
      加入队列中...
    {:else}
      <Icon icon="mdi:playlist-plus" class="size-5 mr-1.5" />
      加入队列
      <Badge variant="secondary" class="ml-1.5 text-[10px] px-1">⚡{videoPrice}</Badge>
    {/if}
  </Button>
</div>
