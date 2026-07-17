<script lang="ts">
  let {
    data,
    width = 280,
    height = 100,
  }: {
    data: Array<{ time: number; calls: number }>;
    width?: number;
    height?: number;
  } = $props();

  let maxVal = $derived(Math.max(...data.map(d => d.calls), 1));
  let span = $derived(data.length > 0 ? data[data.length - 1].time - data[0].time : 0);
  let points = $derived(data.map((d, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * (width - 20) + 10;
    const y = height - 10 - (d.calls / maxVal) * (height - 20);
    return `${x},${y}`;
  }));
  let polyline = $derived(points.join(' '));
  let area = $derived(points.join(' ') + ` ${width - 10},${height - 5} 10,${height - 5}`);

  function formatHour(ts: number): string {
    const d = new Date(ts * 1000);
    return String(d.getHours()).padStart(2, '0') + ':00';
  }
  function formatDay(ts: number): string {
    const d = new Date(ts * 1000);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
</script>

<svg {width} {height} class="shrink-0 overflow-visible">
  {#if maxVal > 0}
    <!-- 网格底线 -->
    <line x1="10" y1={height - 10} x2={width - 10} y2={height - 10} stroke="currentColor" class="text-border" stroke-width="1" />
    <line x1="10" y1="10" x2="10" y2={height - 10} stroke="currentColor" class="text-border" stroke-width="1" />
    <!-- 面积填充 -->
    <polygon points={area} fill="currentColor" class="text-primary/10" />
    <!-- 折线 -->
    <polyline points={polyline} fill="none" stroke="currentColor" class="text-primary" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
    <!-- 数据点 -->
    {#each data as d, i}
      {@const x = (i / Math.max(data.length - 1, 1)) * (width - 20) + 10}
      {@const y = height - 10 - (d.calls / maxVal) * (height - 20)}
      <circle cx={x} cy={y} r="2.5" fill="currentColor" class="text-primary">
        <title>{d.calls} 次</title>
      </circle>
    {/each}
  {/if}
  {#if data.length > 0}
    <text x="10" y={height - 2} text-anchor="start" class="fill-muted-foreground text-[9px]">{span < 86400 ? formatHour(data[0].time) : formatDay(data[0].time)}</text>
    <text x={width - 10} y={height - 2} text-anchor="end" class="fill-muted-foreground text-[9px]">{span < 86400 ? formatHour(data[data.length - 1].time) : formatDay(data[data.length - 1].time)}</text>
  {/if}
</svg>
