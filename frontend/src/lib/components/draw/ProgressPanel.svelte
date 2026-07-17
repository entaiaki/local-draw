<script lang="ts">
  import Icon from '@iconify/svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { getImageProxyUrl, getImageUrl } from '$lib/draw/api/client';
  import ImageLightbox from '$lib/components/draw/ImageLightbox.svelte';
  import type { WsRunMessage } from '$lib/draw/types';

  let {
    messages = [],
    visible = false,
    busy = false,
    resultImages = [],
    cost = 0,
    onFork
  }: {
    messages?: WsRunMessage[];
    visible?: boolean;
    busy?: boolean;
    resultImages?: { url: string; filename: string }[];
    cost?: number;
    onFork?: (path: string) => void;
  } = $props();

  let llmText = $state('');
  let llmVisible = $state(false);
  let llmFinalPositive = $state('');
  let llmFinalNegative = $state('');
  let llmContainer: HTMLPreElement | undefined = $state();

  $effect(() => {
    if (llmText && llmContainer) {
      llmContainer.scrollTop = llmContainer.scrollHeight;
    }
  });

  let progressNode = $state('');
  let progressValue = $state(0);
  let progressMax = $state(0);
  let progressDone = $state(0);
  let progressTotal = $state(0);
  let progressText = $state('');
  let logLines = $state<string[]>([]);
  let previewSrc = $state('');
  let lastProcessed = $state(0);
  let lbOpen = $state(false);
  let lbIndex = $state(0);
  let lbImages = $derived(resultImages.map((img) => ({ src: getImageUrl(img.filename), creator_id: '', cached: getImageProxyUrl(img.filename) })));

  const progressPercent = $derived(progressMax > 0 ? Math.round((progressValue / progressMax) * 100) : 0);

  function openLightbox(i: number) {
    lbIndex = i;
    lbOpen = true;
  }

  $effect(() => {
    if (messages.length === 0) {
      lastProcessed = 0;
      llmText = '';
      llmVisible = false;
      llmFinalPositive = '';
      llmFinalNegative = '';
      progressNode = '';
      progressValue = 0;
      progressMax = 0;
      progressDone = 0;
      progressTotal = 0;
      progressText = '';
      logLines = [];
      previewSrc = '';
      return;
    }
    if (messages.length <= lastProcessed) return;
    for (let i = lastProcessed; i < messages.length; i++) {
      const msg = messages[i];
      switch (msg.type) {
        case 'log':
          logLines = [...logLines, msg.message];
          break;
        case 'llm_start':
          llmVisible = true;
          llmText = '';
          break;
        case 'llm_chunk':
          llmText += msg.delta;
          break;
        case 'llm_done':
          llmVisible = false;
          llmFinalPositive = msg.text || '';
          llmFinalNegative = msg.negative || '';
          break;
        case 'progress':
          progressNode = msg.node;
          progressValue = msg.value;
          progressMax = msg.max;
          progressDone = msg.done;
          progressTotal = msg.total;
          if (msg.max > 1) {
            progressText = `${msg.node} ${msg.value}/${msg.max} (${Math.round((msg.value / msg.max) * 100)}%) 节点 ${msg.done}/${msg.total}`;
          } else {
            progressText = msg.node;
          }
          break;
        case 'prompt_id':
          progressText = '生成中...';
          break;
        case 'preview':
          previewSrc = msg.image;
          break;
        case 'done':
          progressText = '完成';
          break;
        case 'error':
          progressText = `失败：${msg.message}`;
          break;
      }
    }
    lastProcessed = messages.length;
  });
</script>

{#if visible}
  <div class="space-y-3">
    <!-- Preview image (during generation) or final results -->
    {#if previewSrc || resultImages.length > 0}
      <div class="rounded-lg overflow-hidden border">
        {#if resultImages.length > 0}
          <div class="space-y-2">
            {#each resultImages as img, i}
              <button
                type="button"
                class="w-full cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all"
                onclick={() => openLightbox(i)}
              >
                <img
                  src={getImageProxyUrl(img.filename)}
                  alt="生成结果"
                  class="w-full object-contain max-h-64"
                  loading="lazy"
                />
              </button>
            {/each}
          </div>
        {:else}
          <img src={previewSrc} alt="预览" class="w-full max-h-64 object-contain" loading="lazy" />
        {/if}
      </div>
    {/if}

    <!-- Progress bar -->
    <div class="space-y-1.5">
      <div class="flex items-center justify-between text-xs">
        <span class="font-medium flex items-center gap-1.5">
          {#if busy}
            <Icon icon="mdi:loading" class="size-3.5 animate-spin" />
          {/if}
          {progressText || '连接中...'}
        </span>
        {#if progressMax > 1}
          <Badge variant="secondary" class="text-[10px]">{progressPercent}%</Badge>
        {/if}
      </div>
      <div class="w-full h-2 bg-muted rounded-full overflow-hidden">
        <div
          class="h-full bg-primary rounded-full transition-all duration-300"
          style="width: {progressPercent}%"
        ></div>
      </div>
    </div>

    <!-- Cost -->
    {#if cost > 0}
      <div class="text-[11px] text-yellow-500">
        本次生图用电 ¥{cost.toFixed(6)}
      </div>
    {/if}

    <!-- LLM streaming -->
    {#if llmVisible}
      <div class="space-y-1">
        <div class="text-xs font-medium flex items-center gap-1.5">
          <Icon icon="mdi:brain" class="size-3.5" />
          LLM 处理中...
          <Icon icon="mdi:loading" class="size-3 animate-spin" />
        </div>
        <pre bind:this={llmContainer} class="text-xs bg-yellow-50 dark:bg-yellow-950/30 border rounded-md p-2 max-h-40 overflow-auto whitespace-pre-wrap resize-y">{llmText}</pre>
      </div>
    {/if}

    <!-- Final prompt -->
    {#if llmFinalPositive}
      <div class="space-y-1.5">
        <div class="text-xs font-medium">正面提示词：</div>
        <div class="text-xs bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-md p-2 whitespace-pre-wrap">{llmFinalPositive}</div>
        {#if llmFinalNegative}
          <div class="text-xs font-medium mt-1">负面提示词：</div>
          <div class="text-xs bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800 rounded-md p-2 whitespace-pre-wrap">{llmFinalNegative}</div>
        {/if}
      </div>
    {/if}

    <!-- Log area (collapsed) -->
    {#if logLines.length > 0}
      <details class="text-xs">
        <summary class="cursor-pointer text-muted-foreground hover:text-foreground">
          日志 ({logLines.length})
        </summary>
        <pre class="mt-1 bg-muted rounded-md p-2 max-h-32 overflow-auto whitespace-pre-wrap resize-y">{logLines.join('\n')}</pre>
      </details>
    {/if}
  </div>
{/if}

<ImageLightbox
  open={lbOpen}
  images={lbImages}
  index={lbIndex}
  onclose={() => (lbOpen = false)}
  onfork={onFork}
/>

<style>
  summary::-webkit-details-marker {
    display: none;
  }
</style>
