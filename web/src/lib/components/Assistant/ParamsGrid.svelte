<script lang="ts">
  import type { GeneratedCard } from '$lib/types/assistant';

  let { card }: { card: GeneratedCard } = $props();

  const fields = $derived<Array<{ label: string; value: string }>>([
    { label: '模式', value: card.mode || 'WAI' },
    { label: '尺寸', value: `${card.width} × ${card.height}` },
    { label: '工作流', value: card.workflowPath.split('/').pop() || card.workflowPath },
    ...(card.character ? [{ label: '角色', value: card.character }] : []),
    ...(card.style ? [{ label: '画风', value: card.style }] : []),
    ...(card.styleTags ? [{ label: '画风标签', value: card.styleTags }] : []),
  ]);
</script>

<div class="grid grid-cols-2 gap-2">
  {#each fields as field}
    <div class="space-y-0.5">
      <div class="text-[10px] text-muted-foreground/60 font-medium uppercase">{field.label}</div>
      <div class="text-xs font-medium truncate" title={field.value}>{field.value}</div>
    </div>
  {/each}
</div>
