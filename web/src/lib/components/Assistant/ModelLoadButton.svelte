<script lang="ts">
  import { bridgeLoadModel, bridgeUnloadModel } from '$lib/api';
  import { onDestroy } from 'svelte';

  // model: bridge 模型 alias (如 'zimage-turbo', 'flux2-klein')
  let { model }: { model: string } = $props();

  let loaded = $state(false);
  let busy = $state(false);
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let hint = $state('');

  async function refreshStatus() {
    try {
      const r = await fetch('/api/draw/bridge/models');
      const list = await r.json();
      const m = list.find((x: any) => x.alias === model);
      loaded = !!m?.loaded;
    } catch {}
  }

  async function doLoad() {
    if (busy) return;
    busy = true;
    hint = '加载中(首次~30s,会驱逐其他模型)...';
    const r = await bridgeLoadModel(model);
    busy = false;
    if (r.ok) {
      loaded = true;
      hint = `已加载 (${r.load_sec}s, 空闲显存 ${r.vram_free_gb}GB)`;
    } else {
      hint = `加载失败: ${r.error || '未知错误'}`;
    }
    setTimeout(() => hint = '', 6000);
  }

  async function doUnload() {
    if (busy) return;
    busy = true;
    const r = await bridgeUnloadModel(model);
    busy = false;
    loaded = false;
    hint = r.ok ? `已卸载 (空闲显存 ${r.vram_free_gb}GB)` : `卸载失败`;
    setTimeout(() => hint = '', 5000);
  }

  // 挂载时和 model 变化时刷新状态
  $effect(() => {
    model;
    refreshStatus();
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(refreshStatus, 10000);
  });

  onDestroy(() => { if (statusTimer) clearInterval(statusTimer); });
</script>

<div class="flex items-center gap-1.5">
  {#if loaded}
    <span class="flex items-center gap-1 text-[10px] text-green-400" title="模型已驻留显存,生成秒出">
      <span class="size-1.5 rounded-full bg-green-400 inline-block"></span>已加载
    </span>
    <button
      class="px-2 py-0.5 text-[10px] font-medium rounded-md bg-muted text-muted-foreground hover:text-foreground hover:bg-destructive/20 transition-all disabled:opacity-50"
      onclick={doUnload}
      disabled={busy}
      title="卸载模型,释放显存"
    >{busy ? '...' : '✕ 卸载'}</button>
  {:else}
    <button
      class="px-2 py-0.5 text-[10px] font-medium rounded-md bg-muted text-muted-foreground hover:text-foreground hover:bg-primary/20 transition-all disabled:opacity-50"
      onclick={doLoad}
      disabled={busy}
      title="预加载模型到显存(互斥,会卸载其他模型)"
    >{busy ? '⏳ 加载中' : '⬇ 加载模型'}</button>
  {/if}
  {#if hint}
    <span class="text-[9px] text-muted-foreground/70 max-w-40 truncate" title={hint}>{hint}</span>
  {/if}
</div>
