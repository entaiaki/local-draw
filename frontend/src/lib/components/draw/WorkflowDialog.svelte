<script lang="ts">
  import Icon from '@iconify/svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import WorkflowSelector from './WorkflowSelector.svelte';
  import LoraApplyDialog from './LoraApplyDialog.svelte';
  import type { DrawWorkflow } from '$lib/draw/types';

  let {
    value = $bindable(''),
    onselect,
    onpromptload,
    subdir = 'WAI'
  }: {
    value?: string;
    onselect?: (wf: DrawWorkflow) => void;
    onpromptload?: (positive: string, negative: string) => void;
    subdir?: string;
  } = $props();

  let open = $state(false);
  let loraApplyOpen = $state(false);

  function handleSelect(wf: DrawWorkflow) {
    open = false;
    onselect?.(wf);
  }

  function handlePromptLoad(positive: string, negative: string) {
    onpromptload?.(positive, negative);
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button variant="outline" class="w-full justify-start gap-2" {...props}>
        <Icon icon="mdi:cog-outline" class="size-4" />
        {#if value}
          <span class="truncate">{value.split('/').pop()?.replace(/\.(json|txt)$/, '')}</span>
        {:else}
          <span class="text-muted-foreground">选择工作流</span>
        {/if}
      </Button>
    {/snippet}
  </Dialog.Trigger>
  <Dialog.Content class="sm:max-w-full max-w-full w-dvw h-dvh max-h-dvh m-0 rounded-none p-4 flex flex-col" showCloseButton={false}>
    <Dialog.Header class="shrink-0 flex-row items-center justify-between gap-2">
      <Dialog.Title class="flex items-center gap-2">
        <Icon icon="mdi:cog-outline" class="size-5" />
        选择工作流
      </Dialog.Title>
      <Dialog.Close>
        <Button variant="ghost" size="icon-sm"><Icon icon="mdi:close" class="size-4" /></Button>
      </Dialog.Close>
    </Dialog.Header>
    <div class="overflow-y-auto min-h-0 flex-1">
      <WorkflowSelector {subdir} bind:value onselect={handleSelect} onpromptload={handlePromptLoad} showTitle={false} constrainHeight={false} />
      <div class="sticky bottom-0 flex justify-center py-3 bg-popover border-t border-border/50">
        <button
          onclick={() => (loraApplyOpen = true)}
          class="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Icon icon="mdi:plus-circle-outline" class="size-3.5" />
          没找到你想要的 Lora？告诉我们
        </button>
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>

<LoraApplyDialog bind:open={loraApplyOpen} />
