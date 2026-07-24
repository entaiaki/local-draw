<script lang="ts">
  import { uploadImg2img, submitToQueue, fetchMyQueue, getImageUrl } from '$lib/api';
  import { onDestroy } from 'svelte';

  interface EditRecord {
    id: number;
    srcName: string;
    srcPreview: string;
    instruction: string;
    queueId: number;
    status: 'queued' | 'running' | 'done' | 'failed';
    outputPath?: string;
    error?: string;
  }

  let imageFile: File | null = $state(null);
  let imagePreview: string = $state('');
  let instruction: string = $state('');
  let records: EditRecord[] = $state([]);
  let uploading = $state(false);
  let errorText = $state('');
  let dragging = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let fileInput: HTMLInputElement | undefined = $state();
  let idCounter = 0;

  const quickInstructions = [
    '换成赛博朋克风格背景',
    '把头发改成粉色',
    '变成冬天的雪景',
    '给她戴上眼镜',
    '转换成吉卜力动画风',
  ];

  function setFile(f: File | null) {
    if (!f) return;
    if (!f.type.startsWith('image/')) { errorText = '只支持图片文件'; return; }
    if (f.size > 5 * 1024 * 1024) { errorText = '图片超过 5MB 限制'; return; }
    errorText = '';
    imageFile = f;
    const reader = new FileReader();
    reader.onload = () => { imagePreview = reader.result as string; };
    reader.readAsDataURL(f);
  }

  function clearImage() {
    imageFile = null;
    imagePreview = '';
    if (fileInput) fileInput.value = '';
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const f = e.dataTransfer?.files?.[0];
    if (f) setFile(f);
  }

  async function generate() {
    if (!imageFile || !instruction.trim() || uploading) return;
    uploading = true;
    errorText = '';
    try {
      const up = await uploadImg2img(imageFile);
      const res = await submitToQueue({
        workflow_path: 'Flux/图片编辑.json',
        direct_prompt: instruction.trim(),
        workflow_prompt: instruction.trim(),
        workflow_negative_prompt: '',
        width: 0,
        height: 0,
        image1_name: up.image1_name,
      });
      records = [{
        id: ++idCounter,
        srcName: up.image1_name,
        srcPreview: imagePreview,
        instruction: instruction.trim(),
        queueId: res.item_id,
        status: 'queued',
      }, ...records];
      if (!pollTimer) pollTimer = setInterval(poll, 2000);
    } catch (e: any) {
      errorText = e.message || '提交失败';
    } finally {
      uploading = false;
    }
  }

  async function poll() {
    const { items } = await fetchMyQueue();
    let active = 0;
    for (const qi of items) {
      if (qi.status === 'pending' || qi.status === 'running' || qi.status === 'waiting') active++;
      const rec = records.find(r => r.queueId === qi.id);
      if (rec) {
        const mapped = qi.status === 'pending' || qi.status === 'waiting' ? 'queued' : qi.status;
        if (mapped !== rec.status) rec.status = mapped as any;
        if (qi.status === 'done' && (qi as any)._output_files?.length) {
          rec.outputPath = (qi as any)._output_files[0];
        }
        if (qi.error) rec.error = qi.error;
      }
    }
    records = records; // trigger reactivity
    if (active === 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      generate();
    }
  }
</script>

<div class="flex flex-col h-full overflow-y-auto">
  <!-- Toolbar -->
  <div class="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50 shrink-0">
    <div class="flex items-center gap-2">
      <span class="text-lg">🖼️</span>
      <span class="font-semibold text-sm">图生图 · Flux Kontext</span>
      <span class="text-[10px] text-muted-foreground">上传图片 + 自然语言编辑指令</span>
    </div>
    <span class="text-[10px] text-muted-foreground">≤5MB · 尺寸跟随原图</span>
  </div>

  <div class="flex-1 min-h-0 flex">
    <!-- Left: workspace -->
    <div class="flex-1 min-w-0 flex flex-col p-4 gap-4 overflow-y-auto">
      <!-- Upload zone -->
      {#if !imagePreview}
        <button
          class="w-full border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center gap-3 transition-colors cursor-pointer
            {dragging ? 'border-primary bg-primary/10' : 'border-border hover:border-muted-foreground/50 hover:bg-muted/30'}"
          onclick={() => fileInput?.click()}
          ondragover={(e) => { e.preventDefault(); dragging = true; }}
          ondragleave={() => dragging = false}
          ondrop={onDrop}
        >
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-muted-foreground">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <path d="M21 15l-5-5L5 21"/>
          </svg>
          <div class="text-sm text-muted-foreground">点击选择或拖拽图片到这里</div>
          <div class="text-[10px] text-muted-foreground/60">PNG / JPG / WebP，最大 5MB</div>
        </button>
      {:else}
        <div class="flex gap-4 items-start">
          <div class="relative group shrink-0">
            <img src={imagePreview} alt="原图" class="max-h-56 rounded-xl border border-border" />
            <button
              class="absolute top-2 right-2 size-6 rounded-full bg-black/60 text-white/80 hover:text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
              onclick={clearImage}
              title="移除图片"
            >✕</button>
          </div>
          <div class="text-xs text-muted-foreground space-y-1 pt-1">
            <div class="font-medium text-foreground">{imageFile?.name}</div>
            <div>{((imageFile?.size || 0) / 1024).toFixed(0)} KB</div>
            <button class="text-primary hover:underline" onclick={() => fileInput?.click()}>换一张</button>
          </div>
        </div>
      {/if}

      <input
        bind:this={fileInput}
        type="file"
        accept="image/*"
        class="hidden"
        onchange={(e) => setFile((e.target as HTMLInputElement).files?.[0] || null)}
      />

      <!-- Instruction input -->
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <textarea
            bind:value={instruction}
            onkeydown={handleKeydown}
            placeholder="描述你想怎么修改这张图… 例如：把背景换成赛博朋克城市夜景"
            rows={2}
            class="flex-1 bg-input border border-border rounded-xl px-4 py-2.5 text-sm placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:border-primary/50 transition-colors"
          ></textarea>
          <button
            onclick={generate}
            disabled={!imageFile || !instruction.trim() || uploading}
            class="shrink-0 h-10 px-5 rounded-xl bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            {#if uploading}
              <span class="inline-block w-3 h-3 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin"></span>
              上传中
            {:else}
              🚀 生成
            {/if}
          </button>
        </div>
        <!-- Quick instructions -->
        <div class="flex flex-wrap gap-1.5">
          {#each quickInstructions as qi}
            <button
              class="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-muted-foreground/60 transition-colors"
              onclick={() => instruction = qi}
            >{qi}</button>
          {/each}
        </div>
      </div>

      {#if errorText}
        <p class="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">{errorText}</p>
      {/if}

      <!-- Records -->
      {#if records.length > 0}
        <div class="space-y-3 pb-4">
          <div class="text-xs text-muted-foreground font-medium">生成记录</div>
          {#each records as rec (rec.id)}
            <div class="bg-card border border-border rounded-xl p-3 space-y-2 animate-slide-up">
              <div class="flex items-center justify-between">
                <div class="text-xs text-foreground/90 truncate flex-1" title={rec.instruction}>「{rec.instruction}」</div>
                {#if rec.status === 'done'}
                  <span class="text-[11px] text-success shrink-0 ml-2">✓ 完成</span>
                {:else if rec.status === 'failed'}
                  <span class="text-[11px] text-destructive shrink-0 ml-2">✗ {rec.error || '失败'}</span>
                {:else}
                  <span class="text-[11px] text-warning shrink-0 ml-2 flex items-center gap-1">
                    <span class="inline-block w-1.5 h-1.5 rounded-full bg-warning" style="animation: pulse-dot 0.8s ease-in-out infinite"></span>
                    {rec.status === 'running' ? '生成中' : '排队中'}
                  </span>
                {/if}
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div class="space-y-1">
                  <div class="text-[10px] text-muted-foreground">原图</div>
                  <img src={rec.srcPreview} alt="原图" class="w-full rounded-lg border border-border/50" />
                </div>
                <div class="space-y-1">
                  <div class="text-[10px] text-muted-foreground">生成结果</div>
                  {#if rec.outputPath}
                    <img src={getImageUrl(rec.outputPath)} alt="生成结果" class="w-full rounded-lg border border-border/50" />
                  {:else}
                    <div class="w-full aspect-square rounded-lg border border-dashed border-border/50 flex items-center justify-center text-muted-foreground/40 text-xs">
                      {rec.status === 'failed' ? '生成失败' : '等待出图…'}
                    </div>
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
