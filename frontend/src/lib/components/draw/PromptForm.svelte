<script lang="ts">
  import Icon from '@iconify/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { Input } from '$lib/components/ui/input';
  import { Badge } from '$lib/components/ui/badge';
  import * as Dialog from '$lib/components/ui/dialog';
  import TurnstileWidget from '$lib/components/TurnstileWidget.svelte';
  import { fetchResolutions, fetchPresets, createPreset, updatePreset, deletePreset } from '$lib/draw/api/client';
  import { autoResize } from '$lib/utils/actions';
import { drawEnv } from '$lib/draw/stores/env';
  import { forumAuth } from '$lib/forum/stores/auth';
  import { get } from 'svelte/store';
  import type { DrawResolution, Preset } from '$lib/draw/types';

  let {
    directPrompt = $bindable(''),
    negativePrompt = $bindable(''),
    nlPrompt = $bindable(''),
    workflowPrompt = $bindable(''),
    workflowNegativePrompt = $bindable(''),
    width = $bindable(0),
    height = $bindable(0),
        onsubmit,
    disabled = false,
    busy = false,
    otherNode = $bindable(''),
    otherValue = $bindable(0),
    otherMax = $bindable(0),
    otherStage = $bindable(''),
    sameSeed = $bindable(false),
    forkSeed = $bindable<number | undefined>(undefined),
      turnstileToken = $bindable(''),
      turnstileTick = $bindable(0),
    pointsCostSubmit = 0,
    llmMode = '',
    llmTokenPerPoint = 0,
    turnstileEnabled = false,
  }: {
    directPrompt?: string;
    negativePrompt?: string;
    nlPrompt?: string;
    workflowPrompt?: string;
    workflowNegativePrompt?: string;
    width?: number;
    height?: number;
        onsubmit?: () => void;
    disabled?: boolean;
    busy?: boolean;
    otherNode?: string;
    otherValue?: number;
    otherMax?: number;
    otherStage?: string;
    sameSeed?: boolean;
    forkSeed?: number;
    pointsCostSubmit?: number;
    llmTokenPerPoint?: number;
    llmMode?: string;
    turnstileEnabled?: boolean;
    turnstileToken?: string;
    turnstileTick?: number;
  } = $props();

  let resolutions = $state<DrawResolution[]>([]);
  let selectedRes = $derived(width && height ? `${width}x${height}` : '');
  let promptsOpen = $state(false);
  let translating = $state(false);
  let translateError = $state("");
  let translateToken = $state("");
    let translateTick = $state(0);
  let llmPrompt = $state("");
  let hasTranslated = $state(false);
  let rewriteMode = $state(true);
  let presets = $state<Preset[]>([]);
  let presetsLoaded = $state(false);
  let presetDialogOpen = $state(false);
  let editingPresetId = $state<string | null>(null);
  let isEditing = $derived(editingPresetId !== null);
  let newPresetName = $state('');
  let newPresetContent = $state('');
  let newPresetType = $state<'positive' | 'negative'>('positive');

  $effect(() => {
    loadResolutions();
  });

  $effect(() => {
    if (forumAuth.getToken() && !presetsLoaded) {
      loadPresets();
    }
    if (!forumAuth.getToken()) {
      presets = [];
      presetsLoaded = false;
    }
  });

  async function loadPresets() {
    try {
      presets = await fetchPresets();
      presetsLoaded = true;
    } catch {
      presets = [];
      presetsLoaded = true;
    }
  }

  function openEditPreset(p: Preset) {
    editingPresetId = p.id;
    newPresetName = p.name;
    newPresetContent = p.content;
    newPresetType = p.type;
    presetDialogOpen = true;
  }

  async function handleSavePreset() {
    if (!newPresetName.trim() || !newPresetContent.trim()) return;
    try {
      if (editingPresetId) {
        const p = await updatePreset(editingPresetId, { name: newPresetName.trim(), content: newPresetContent.trim(), type: newPresetType });
        presets = presets.map(pr => pr.id === editingPresetId ? p : pr);
      } else {
        const p = await createPreset({ name: newPresetName.trim(), content: newPresetContent.trim(), type: newPresetType });
        presets = [...presets, p];
      }
      editingPresetId = null;
      newPresetName = '';
      newPresetContent = '';
      newPresetType = 'positive';
      presetDialogOpen = false;
    } catch {}
  }

  async function handleDeletePreset(id: string) {
    try {
      await deletePreset(id);
      presets = presets.filter(p => p.id !== id);
    } catch {}
  }

  function applyPreset(p: Preset) {
    if (p.type === 'positive') directPrompt = directPrompt ? directPrompt + ', ' + p.content : p.content;
    else negativePrompt = negativePrompt ? negativePrompt + ', ' + p.content : p.content;
  }

  // 工作流切换时清除 LLM 结果
  $effect(() => {
    if (workflowPrompt) { llmPrompt = ''; hasTranslated = false; }
  });
  async function loadResolutions() {
    try {
      const res = await fetchResolutions();
      resolutions = res.presets;
      if (resolutions.length && !width && !height) {
        const first = resolutions[0];
        width = first.w;
        height = first.h;
      }
    } catch {
      resolutions = [];
    }
  }
        async function handleTranslate() {
    if (!nlPrompt?.trim()) return;
    translating = true;
    translateError = ''; hasTranslated = false;
    promptsOpen = true;
    llmPrompt = '';
    const token = forumAuth.getToken();
    try {
      const baseUrl = get(drawEnv.baseUrl);
      const resp = await fetch(`${baseUrl}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          prompt: nlPrompt,
          original_prompt: directPrompt || undefined,
          negative_prompt: negativePrompt || undefined,
          turnstile_token: translateToken || undefined,
          mode: llmMode || undefined,
          rewrite: rewriteMode
        })
      });
      const data = await resp.json();
      if (data.ok) {
        llmPrompt = data.positive; hasTranslated = true;
        if (llmMode === 'anima') {
          // Anima: append translated text to existing prompt
          const existing = directPrompt || workflowPrompt || '';
          directPrompt = existing ? existing + ', ' + data.positive : data.positive;
        } else {
          directPrompt = data.positive;
          negativePrompt = data.negative || '';
        }
      } else {
        translateError = data.error || '翻译失败';
      }
    } catch (e) {
      translateError = '请求失败: ' + (e instanceof Error ? e.message : '未知错误');
    } finally {
      translateToken = '';
      translateTick++;
      translating = false;
    }
  }

  function handleSubmit() {
    if (nlPrompt?.trim() && directPrompt === workflowPrompt && !confirm('自然语言还未转换，是否先点"转换"生成标签？\n\n点确定继续提交，点取消返回去转换。')) {
      return;
    }
    onsubmit?.();
  }

  function selectRes(r: DrawResolution) {
    width = r.w;
    height = r.h;
  }
</script>

<div class="space-y-3">
  <!-- Natural language -->
  <div class="space-y-1.5">
    <Label class="text-xs font-medium flex items-center gap-1">
      <Icon icon="mdi:translate" class="size-3.5" />
      自然语言描述
      <Badge variant="secondary" class="text-[10px] px-1 py-0">可选，中文/英文</Badge>
    </Label>
    <textarea
      bind:value={nlPrompt}
      use:autoResize
      placeholder="一个蓝发少女站在花园里..."
      class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y scrollbar-hide"
    ></textarea>
      {#if turnstileEnabled}
        <TurnstileWidget
          siteKey="0x4AAAAAADSVSh5jjelMNlrv"
          onToken={(t) => (translateToken = t)}
          onExpired={() => (translateToken = '')}
          tick={translateTick}
        />
      {/if}

      <div class="flex flex-wrap gap-2 mt-1.5">
      <Button size="sm" variant="outline" onclick={handleTranslate} disabled={translating || !nlPrompt?.trim()}>
        <Icon icon={translating ? "mdi:loading" : "mdi:auto-fix"} class="size-4 mr-1 {translating ? 'animate-spin' : ''}" />
        {translating ? "转换中..." : "转换"}
        {#if llmTokenPerPoint > 0 && nlPrompt?.length}{@const est = Math.max(1, Math.ceil(nlPrompt.length * 2 / (llmTokenPerPoint || 1)))}<Badge variant="secondary" class="ml-1 text-[10px] px-1">≈⚡{est}</Badge>{/if}
      </Button>
      <label class="flex items-center gap-1.5 text-xs cursor-pointer select-none">
        <Checkbox bind:checked={rewriteMode} />
        <span class="text-muted-foreground">改写</span>
      </label>
      {#if workflowPrompt && (directPrompt !== workflowPrompt || negativePrompt !== workflowNegativePrompt)}
        <Button size="sm" variant="outline" onclick={() => { directPrompt = workflowPrompt; negativePrompt = workflowNegativePrompt; llmPrompt = ''; hasTranslated = false; }}>
          <Icon icon="mdi:restore" class="size-3.5 mr-1" />
          重置到工作流默认
        </Button>
      {/if}
    </div>
    {#if translateError}
      <div class="text-xs text-red-500 mt-1">{translateError}</div>
    {/if}
    </div>
    <!-- Collapsible prompts -->
  <div class="space-y-2">
    <button
      type="button"
      class="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
      onclick={() => (promptsOpen = !promptsOpen)}
    >
      <Icon icon={promptsOpen ? "mdi:chevron-down" : "mdi:chevron-right"} class="size-4" />
      <Icon icon="mdi:text-box-outline" class="size-3.5" />
      正向 / 反向提示词
      {#if directPrompt || negativePrompt}
        <Badge variant="secondary" class="text-[10px] px-1 py-0 ml-1">已填写</Badge>
      {/if}
    </button>
    {#if promptsOpen}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <Label class="text-xs font-medium flex items-center gap-1">
            <Icon icon="mdi:text-box-outline" class="size-3.5" />
            正向提示词
          </Label>
          <textarea
            bind:value={directPrompt}
            use:autoResize
            placeholder="1girl, blue_hair, garden, masterpiece, best quality..."
            class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y scrollbar-hide"
          ></textarea>
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs font-medium flex items-center gap-1">
            <Icon icon="mdi:text-box-remove-outline" class="size-3.5" />
            反向提示词
          </Label>
          <textarea
            bind:value={negativePrompt}
            use:autoResize
            placeholder="bad hands, too many fingers, long neck, poorly drawn..."
            class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y scrollbar-hide"
          ></textarea>
        </div>
      </div>
      {#if forumAuth.getToken()}
        <div class="grid grid-cols-2 gap-3 pt-1">
          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <Label class="text-xs font-medium text-primary/80">正面预设</Label>
              <button onclick={() => { editingPresetId = null; newPresetName = ''; newPresetContent = ''; newPresetType = 'positive'; presetDialogOpen = true; }} class="text-xs text-primary hover:underline flex items-center gap-0.5">
                <Icon icon="mdi:plus" class="size-3.5" />新建
              </button>
            </div>
            <div class="flex flex-wrap gap-1.5">
              {#each presets.filter(p => p.type === 'positive') as p}
                <div class="flex items-center gap-0.5 group">
                  <button onclick={() => applyPreset(p)} class="text-left text-[11px] px-2 py-1 rounded border border-border hover:bg-accent hover:border-primary/50 transition-all whitespace-nowrap">{p.name}</button>
                  <button onclick={() => openEditPreset(p)} class="size-5 flex items-center justify-center rounded text-muted-foreground hover:text-primary opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0" title="编辑"><Icon icon="mdi:pencil" class="size-3" /></button>
                  <button onclick={() => handleDeletePreset(p.id)} class="size-5 flex items-center justify-center rounded text-muted-foreground hover:text-red-500 opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0" title="删除"><Icon icon="mdi:close" class="size-3" /></button>
                </div>
              {/each}
              {#if presets.filter(p => p.type === 'positive').length === 0}
                <div class="text-[10px] text-muted-foreground">暂无</div>
              {/if}
            </div>
          </div>
          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <Label class="text-xs font-medium text-red-400/80">反面预设</Label>
              <button onclick={() => { editingPresetId = null; newPresetName = ''; newPresetContent = ''; newPresetType = 'negative'; presetDialogOpen = true; }} class="text-xs text-primary hover:underline flex items-center gap-0.5">
                <Icon icon="mdi:plus" class="size-3.5" />新建
              </button>
            </div>
            <div class="flex flex-wrap gap-1.5">
              {#each presets.filter(p => p.type === 'negative') as p}
                <div class="flex items-center gap-0.5 group">
                  <button onclick={() => applyPreset(p)} class="text-left text-[11px] px-2 py-1 rounded border border-border hover:bg-accent hover:border-red-300/50 transition-all whitespace-nowrap">{p.name}</button>
                  <button onclick={() => openEditPreset(p)} class="size-5 flex items-center justify-center rounded text-muted-foreground hover:text-primary opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0" title="编辑"><Icon icon="mdi:pencil" class="size-3" /></button>
                  <button onclick={() => handleDeletePreset(p.id)} class="size-5 flex items-center justify-center rounded text-muted-foreground hover:text-red-500 opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0" title="删除"><Icon icon="mdi:close" class="size-3" /></button>
                </div>
              {/each}
              {#if presets.filter(p => p.type === 'negative').length === 0}
                <div class="text-[10px] text-muted-foreground">暂无</div>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Options row -->
  <div class="flex flex-wrap items-center gap-4">
    
    {#if forkSeed != null}
      <label class="flex items-center gap-2 text-xs cursor-pointer">
        <Checkbox bind:checked={sameSeed} />
        <span>同种子</span>
        <button
          class="text-muted-foreground hover:text-foreground"
          title="使用与原始图片相同的随机种子，便于控制构图"
        >
          <Icon icon="mdi:help-circle-outline" class="size-3.5" />
        </button>
      </label>
    {/if}
  </div>

  <!-- Safety rating -->

  <!-- Resolution presets -->
      {#if resolutions.length > 0}
    <div class="space-y-1.5">
      <Label class="text-xs font-medium">分辨率</Label>
      <div class="flex flex-wrap gap-1.5">
        {#each resolutions as r}
          {@const key = `${r.w}x${r.h}`}
          <button
            class="px-2 py-1 rounded text-xs border transition-all {selectedRes === key ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-accent'}"
            onclick={() => selectRes(r)}

          >
            {r.label || key}
          </button>
        {/each}
    </div>
    </div>
  {/if}

  {#if turnstileEnabled}
    <TurnstileWidget
        siteKey="0x4AAAAAADSVSh5jjelMNlrv"
        tick={turnstileTick}
        onToken={(t) => (turnstileToken = t)}
        onExpired={() => (turnstileToken = '')}
      />
  {/if}

    <!-- Submit button -->
  <Button
    class="w-full"
    size="lg"
    onclick={handleSubmit}
    {disabled}
  >
    {#if busy}
      <Icon icon="mdi:loading" class="size-4 animate-spin" />
      加入队列中...
    {:else}
      <Icon icon="mdi:playlist-plus" class="size-5 mr-1.5" />
      加入队列
      {#if pointsCostSubmit > 0}<Badge variant="secondary" class="ml-1.5 text-[10px] px-1">⚡{pointsCostSubmit}</Badge>{/if}
    {/if}
  </Button>
</div>

<Dialog.Root open={presetDialogOpen} onOpenChange={(o) => { if (!o) editingPresetId = null; presetDialogOpen = o; }}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>{isEditing ? '编辑预设' : '新建预设'}</Dialog.Title>
      <Dialog.Description class="text-xs text-muted-foreground">预设内容将在点击时追加到对应提示词末尾（最多 2000 字符）</Dialog.Description>
    </Dialog.Header>
    <div class="space-y-3 px-6 pb-4">
      <div class="space-y-1">
        <Label class="text-xs">名称</Label>
        <Input bind:value={newPresetName} placeholder="品质三连" />
      </div>
      <div class="space-y-1">
        <Label class="text-xs">类型</Label>
        <div class="flex gap-2">
          <button onclick={() => newPresetType = 'positive'} class="flex-1 px-3 py-1.5 rounded text-xs border transition-all {newPresetType === 'positive' ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-accent'}">正面</button>
          <button onclick={() => newPresetType = 'negative'} class="flex-1 px-3 py-1.5 rounded text-xs border transition-all {newPresetType === 'negative' ? 'border-red-400 bg-red-500 text-white' : 'border-border hover:bg-accent'}">反面</button>
        </div>
      </div>
      <div class="space-y-1">
        <Label class="text-xs">内容</Label>
        <textarea
          bind:value={newPresetContent}
          use:autoResize
          maxlength="2000"
          placeholder="masterpiece, best quality, highly detailed"
          class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y scrollbar-hide"
        ></textarea>
        <div class="text-right text-[10px] text-muted-foreground">{newPresetContent.length}/2000</div>
      </div>
      <Button class="w-full" size="sm" onclick={handleSavePreset} disabled={!newPresetName.trim() || !newPresetContent.trim()}>保存预设</Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
