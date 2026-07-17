<script lang="ts">
  import Icon from '@iconify/svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import StyleSelector from './StyleSelector.svelte';

  let {
    value = $bindable(''),
    name = $bindable(''),
    onselect,
    prefix = ''
  }: {
    value?: string;
    name?: string;
    onselect?: (tags: string, name: string) => void;
    prefix?: string;
  } = $props();

  let open = $state(false);

  function handleSelect(tags: string, name: string) {
    open = false;
    onselect?.(tags, name);
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button variant="outline" class="w-full justify-start gap-2" {...props}>
        <Icon icon="mdi:palette-outline" class="size-4" />
        {#if value}
          <span class="truncate">{name || value}</span>
          <button onclick={(e) => { e.stopPropagation(); onselect?.('', ''); }} class="size-5 flex items-center justify-center rounded text-muted-foreground hover:text-red-500 transition-colors shrink-0" title="清除风格"><Icon icon="mdi:close" class="size-3.5" /></button>
        {:else}
          <span class="text-muted-foreground">选择风格</span>
        {/if}
      </Button>
    {/snippet}
  </Dialog.Trigger>
  <Dialog.Content class="sm:max-w-full max-w-full w-dvw h-dvh max-h-dvh m-0 rounded-none p-4 flex flex-col" showCloseButton={false}>
    <Dialog.Header class="shrink-0 flex-row items-center justify-between gap-2">
      <Dialog.Title class="flex items-center gap-2">
        <Icon icon="mdi:palette-outline" class="size-5" />
        选择风格
      </Dialog.Title>
      <Dialog.Close>
        <Button variant="ghost" size="icon-sm"><Icon icon="mdi:close" class="size-4" /></Button>
      </Dialog.Close>
    </Dialog.Header>
    <div class="overflow-y-auto min-h-0 flex-1">
      <StyleSelector bind:value onselect={handleSelect} showTitle={false} constrainHeight={false} {prefix} />
    </div>
  </Dialog.Content>
</Dialog.Root>
