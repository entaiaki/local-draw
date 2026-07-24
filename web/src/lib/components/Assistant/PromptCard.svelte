<script lang="ts">
  import type { GeneratedCard } from '$lib/types/assistant';
  import ParamsGrid from './ParamsGrid.svelte';

  let {
    card,
    compact = false,
    queueStatus = 'idle',
    queueError = '',
    onsubmit = null,
  }: {
    card: GeneratedCard;
    compact?: boolean;
    queueStatus?: string;
    queueError?: string;
    onsubmit?: () => void;
  } = $props();

  let isQueued = $derived(queueStatus === 'queued' || queueStatus === 'running');
  let isDone = $derived(queueStatus === 'done');
  let isFailed = $derived(queueStatus === 'failed');
</script>

<div class="bg-card border border-border rounded-xl p-3 space-y-2.5 shadow-sm w-full">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      <span class="text-sm">🎨</span>
      <h3 class="font-semibold text-xs">生成参数卡</h3>
    </div>
    {#if isDone}
      <span class="text-xs text-success">✓ 完成</span>
    {:else if isQueued}
      <span class="text-xs text-warning">⏳ 生成中</span>
    {:else if isFailed}
      <span class="text-xs text-destructive">✗ 失败</span>
    {/if}
  </div>

  <!-- Params -->
  <ParamsGrid {card} />

  <!-- Prompts -->
  <div class="space-y-1">
    <div class="text-[10px] text-muted-foreground font-medium">正向提示词</div>
    <div class="text-[11px] bg-muted/50 p-2 rounded break-all max-h-20 overflow-y-auto">
      {card.positivePrompt}
    </div>
  </div>

  <div class="space-y-1">
    <div class="text-[10px] text-muted-foreground font-medium">反向提示词</div>
    <div class="text-[11px] bg-muted/30 p-2 rounded break-all max-h-12 overflow-y-auto text-muted-foreground/70">
      {card.negativePrompt}
    </div>
  </div>

  <!-- Action button -->
  {#if onsubmit && !isQueued && !isDone}
    <button
      class="w-full py-2 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
      onclick={onsubmit}
    >
      🚀 开始生成
    </button>
  {:else if isQueued}
    <div class="w-full py-2 text-xs font-medium rounded-lg bg-muted text-muted-foreground text-center">
      <span class="inline-block w-1.5 h-1.5 rounded-full bg-warning mr-1.5" style="animation: pulse-dot 0.8s ease-in-out infinite"></span>
      生成中...
    </div>
  {:else if isDone}
    <div class="w-full py-2 text-xs font-medium rounded-lg bg-success/20 text-success text-center">
      ✓ 生成完成
    </div>
  {:else if isFailed}
    <button
      class="w-full py-2 text-xs font-medium rounded-lg bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors"
      onclick={onsubmit}
    >
      🔄 重试
    </button>
  {/if}
</div>
