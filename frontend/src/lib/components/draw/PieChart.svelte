<script lang="ts">
  let {
    items,
    valueKey = 'size',
    labelKey = 'label',
    colorScheme = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16'],
    size = 180,
    maxSlices = 8,
    othersLabel = '其他',
  }: {
    items: Array<Record<string, number | string>>;
    valueKey?: string;
    labelKey?: string;
    colorScheme?: string[];
    size?: number;
    maxSlices?: number;
    othersLabel?: string;
  } = $props();

  let total = $derived(items.reduce((s, i) => s + Number(i[valueKey] || 0), 0));

  // 取前 N 项，其余合并
  let slices = $derived.by(() => {
    const sorted = [...items].sort((a, b) => Number(b[valueKey] || 0) - Number(a[valueKey] || 0));
    const top = sorted.slice(0, maxSlices);
    const rest = sorted.slice(maxSlices);
    const restVal = rest.reduce((s, i) => s + Number(i[valueKey] || 0), 0);
    if (restVal > 0) top.push({ [labelKey]: othersLabel, [valueKey]: restVal } as any);
    return top;
  });

  let cx = $derived(size / 2), cy = $derived(size / 2), r = $derived(size / 2 - 4);

  // 预计算每个扇区的偏移角度
  let slicesWithOffset = $derived.by(() => {
    let off = 0;
    return slices.map(s => {
      const val = Number(s[valueKey] || 0);
      const angle = total > 0 ? (val / total) * Math.PI * 2 : 0;
      const entry = { ...s, _offset: off, _angle: angle };
      off += angle;
      return entry;
    });
  });

  function arcPath(value: number, offset: number): string {
    if (total === 0) return '';
    const angle = (value / total) * Math.PI * 2;
    if (angle >= Math.PI * 2 - 0.001) {
      // 满圆
      const x1 = cx + r, y1 = cy;
      const x2 = cx - r, y2 = cy;
      return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 1 1 ${x2} ${y2} A ${r} ${r} 0 1 1 ${x1} ${y1} Z`;
    }
    const x1 = cx + r * Math.cos(offset);
    const y1 = cy + r * Math.sin(offset);
    const x2 = cx + r * Math.cos(offset + angle);
    const y2 = cy + r * Math.sin(offset + angle);
    const large = angle > Math.PI ? 1 : 0;
    return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
  }

  function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }
</script>

<div class="flex items-center gap-4">
  <svg width={size} height={size} viewBox="0 0 {size} {size}" class="shrink-0">
      {#each slicesWithOffset as s}
        {@const val = Number(s[valueKey] || 0)}
        {@const pct = total > 0 ? (val / total * 100).toFixed(1) : '0'}
        {@const color = colorScheme[slicesWithOffset.indexOf(s) % colorScheme.length]}
        {#if val > 0}
          <path d={arcPath(val, s._offset)} fill={color} opacity="0.85" class="hover:opacity-100 transition-opacity cursor-pointer">
            <title>{String(s[labelKey])} | {pct}% | {formatSize(val)}</title>
          </path>
        {/if}
      {/each}
    <text x={cx} y={cy - 4} text-anchor="middle" class="fill-foreground text-xs font-bold">{formatSize(total)}</text>
    <text x={cx} y={cy + 10} text-anchor="middle" class="fill-muted-foreground text-[9px]">总计</text>
  </svg>

  <div class="space-y-1 text-xs">
    {#each slicesWithOffset as s}
      {@const val = Number(s[valueKey] || 0)}
      {@const pct = total > 0 ? (val / total * 100).toFixed(1) : '0'}
      {@const color = colorScheme[slicesWithOffset.indexOf(s) % colorScheme.length]}
      <div class="flex items-center gap-1.5">
        <span class="size-2.5 rounded-sm shrink-0" style="background: {color}"></span>
        <span class="text-muted-foreground truncate max-w-[80px]">{String(s[labelKey])}</span>
        <span class="font-mono ml-auto">{pct}%</span>
      </div>
    {/each}
  </div>
</div>
