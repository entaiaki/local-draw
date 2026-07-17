<script lang="ts">
  import { get } from 'svelte/store';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { DRAW_API_BASE_URLS, drawEnv } from '$lib/draw/stores/env';

  const initialEnv = get(drawEnv);
  let currentEnv = $state(initialEnv);
  let customBaseUrl = $state(DRAW_API_BASE_URLS[initialEnv]);

  $effect(() => {
    const u1 = drawEnv.subscribe((v) => (currentEnv = v));
    const u2 = drawEnv.customBaseUrl.subscribe((v) => (customBaseUrl = v));
    return () => { u1(); u2(); };
  });

  function toggle() {
    const goingProd = currentEnv === 'dev';
    drawEnv.toggle();
    if (goingProd) {
      drawEnv.customBaseUrl.set(DRAW_API_BASE_URLS.prod);
    } else {
      const saved = localStorage.getItem('draw-api-custom-base-url');
      drawEnv.customBaseUrl.set(saved || DRAW_API_BASE_URLS.dev);
    }
  }
  function apply() {
    drawEnv.customBaseUrl.set(customBaseUrl);
    location.reload();
  }
  function resetUrl() {
    drawEnv.customBaseUrl.reset(currentEnv);
    customBaseUrl = DRAW_API_BASE_URLS[currentEnv];
  }
</script>

<div class="space-y-3">
  <div class="flex items-center gap-2">
    <span class="font-medium">API设置</span>
    <span class="text-xs">-</span>
    <button
      class="text-xs px-2 py-0.5 rounded {currentEnv === 'prod' ? 'bg-primary text-primary-foreground' : 'border border-input text-muted-foreground'}"
      onclick={() => { if (currentEnv !== 'prod') toggle(); }}
    >
      生产 {currentEnv === 'prod' ? '✅' : '□'}
    </button>
    <button
      class="text-xs px-2 py-0.5 rounded {currentEnv === 'dev' ? 'bg-primary text-primary-foreground' : 'border border-input text-muted-foreground'}"
      onclick={() => { if (currentEnv !== 'dev') toggle(); }}
    >
      开发 {currentEnv === 'dev' ? '✅' : '□'}
    </button>
  </div>

  <div class="flex gap-2">
    <Input
      bind:value={customBaseUrl}
      placeholder="API baseURL"
      class="flex-1"
      disabled={currentEnv === 'prod'}
    />
    <Button size="sm" variant="default" onclick={apply}>应用并刷新</Button>
    <Button size="sm" variant="ghost" onclick={resetUrl}>恢复默认</Button>
  </div>
</div>
