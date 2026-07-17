<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
  import { drawRequest } from '$lib/draw/api/client';
  import { onMount } from 'svelte';
  import LineChart from '$lib/components/draw/LineChart.svelte';

  let data = $state<{ stats: Record<string, { calls: number; cost: number; failed: number; byModel: Record<string, { calls: number; failed: number; cost: number }>; series: Array<{ time: number; calls: number }> }>; income: Record<string, number> } | null>(null);
  let loading = $state(false);

  onMount(() => load());

  async function load() {
    loading = true;
    try {
      data = await drawRequest<{ stats: any; income: any }>('/api/draw/admin/stats');
    } catch {}
    loading = false;
  }
</script>

<Card>
  <CardHeader>
    <CardTitle class="text-base">使用统计</CardTitle>
  </CardHeader>
  <CardContent>
    <Button size="sm" onclick={load} disabled={loading}>刷新</Button>
    {#if data}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-2">
        {#each Object.entries(data.stats) as [period, s]}
          {@const st = s as { calls: number; cost: number; failed: number; byModel: Record<string, { calls: number; failed: number; cost: number }>; series: Array<{ time: number; calls: number }> }}
          <div class="border rounded-lg p-3 space-y-1 text-xs">
            <div class="font-medium text-sm">
              {period === 'today' ? '今日' : period === '7d' ? '近7天' : '近1个月'}
            </div>
            <div class="text-muted-foreground">调用: {st.calls} | 消耗: ⚡{st.cost}</div>
            <div class="text-muted-foreground">失败: {st.failed}</div>
            <LineChart data={st.series} width={260} height={80} />
            <div class="flex flex-wrap gap-1 pt-1">
              {#each Object.entries(st.byModel) as [model, info]}
                {@const inf = info as { calls: number; failed: number; cost: number }}
                <span class="px-1.5 py-0.5 rounded bg-muted" title="⚡{inf.cost}">{model}: {inf.calls}{#if inf.failed > 0}<span class="text-red-500">({inf.failed})</span>{/if} <span class="text-muted-foreground">⚡{inf.cost}</span></span>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {:else if loading}
      <div class="text-xs text-muted-foreground py-4 text-center">加载中...</div>
    {:else}
      <div class="text-xs text-muted-foreground py-4 text-center">点击刷新加载数据</div>
    {/if}
  </CardContent>
</Card>
