<script lang="ts">
  let { onselect = (text: string) => {} }: {
    onselect?: (text: string) => void;
  } = $props();

  const quickPrompts: Array<{ icon: string; text: string }> = [
    { icon: '🎯', text: '我想画一个原神的胡桃，赛博朋克风格，横屏尺寸' },
    { icon: '🌸', text: '画一个樱花树下的JK少女，日系画风，竖屏高清' },
    { icon: '🤖', text: '赛博朋克都市夜景，科幻风格，宽屏' },
  ];
</script>

<div class="p-3 border border-dashed border-border/60 rounded-xl space-y-2">
  <div class="text-xs text-muted-foreground font-semibold flex items-center gap-1.5">
    <span>⚡</span> 快捷测试一键生图
  </div>
  {#each quickPrompts as qp}
    <button
      class="w-full text-left text-xs bg-background hover:bg-primary/5 hover:text-primary transition border border-border/50 rounded-lg p-2 flex items-center gap-2"
      onclick={() => onselect(qp.text)}
    >
      <span>{qp.icon}</span>
      <span class="truncate">{qp.text}</span>
    </button>
  {/each}
</div>
