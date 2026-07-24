<script lang="ts">
  import type { AssistantMessage } from '$lib/types/assistant';
  import MessageBubble from './MessageBubble.svelte';
  import type { GeneratedCard } from '$lib/types/assistant';

  let { messages = [] as AssistantMessage[], isLoading = false, alwaysScroll = true, onsubmit = null }: {
    messages?: AssistantMessage[];
    isLoading?: boolean;
    alwaysScroll?: boolean;
    onsubmit?: (messageId: string, card: GeneratedCard) => void;
  } = $props();

  let chatContainer: HTMLElement | undefined = $state();

  export function scrollToBottom(): void {
    if (chatContainer) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
  }

  // Auto-scroll on new messages
  $effect(() => {
    messages;
    if (alwaysScroll && chatContainer) {
      requestAnimationFrame(() => {
        if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
      });
    }
  });
</script>

<div bind:this={chatContainer} class="flex-1 overflow-y-auto p-4 space-y-3">
  {#each messages as msg (msg.id)}
    <MessageBubble {msg} {onsubmit} />
  {/each}

  {#if isLoading}
    <div class="flex items-center gap-2 text-sm text-muted-foreground py-2">
      <span class="inline-block w-2 h-2 rounded-full bg-primary" style="animation: pulse-dot 0.8s ease-in-out 0s infinite"></span>
      <span class="inline-block w-2 h-2 rounded-full bg-primary" style="animation: pulse-dot 0.8s ease-in-out 0.2s infinite"></span>
      <span class="inline-block w-2 h-2 rounded-full bg-primary" style="animation: pulse-dot 0.8s ease-in-out 0.4s infinite"></span>
      <span class="ml-1">AI 正在思考...</span>
    </div>
  {/if}
</div>
