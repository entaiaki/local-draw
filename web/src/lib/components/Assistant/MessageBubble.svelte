<script lang="ts">
  import type { AssistantMessage, GeneratedCard } from '$lib/types/assistant';
  import PromptCard from './PromptCard.svelte';
  import { getImageUrl } from '$lib/api';

  let { msg, onsubmit = null }: {
    msg: AssistantMessage;
    onsubmit?: (messageId: string, card: GeneratedCard) => void;
  } = $props();

  let isUser = $derived(msg.role === 'user');
</script>

<div class="flex {isUser ? 'justify-end' : 'justify-start'} animate-slide-up">
  <div class="max-w-[85%] space-y-2">
    <!-- Text bubble -->
    <div
      class="rounded-xl px-4 py-2.5 text-sm leading-relaxed {isUser
        ? 'bg-primary text-primary-foreground rounded-br-sm'
        : 'bg-muted text-foreground rounded-bl-sm'}"
    >
      {msg.content}
    </div>

    <!-- Prompt card (inline for assistant messages) -->
    {#if msg.card && !isUser}
      <PromptCard
        card={msg.card}
        compact
        queueStatus={msg.queueStatus}
        queueError={msg.queueError}
        onsubmit={() => onsubmit?.(msg.id, msg.card!)}
      />
    {/if}

    <!-- Generated image -->
    {#if msg.queueStatus === 'done' && msg.imagePath}
      <div class="rounded-xl overflow-hidden border border-border max-w-md">
        <img src={getImageUrl(msg.imagePath)} alt="生成结果" class="w-full" />
      </div>
    {/if}

    <!-- Queue status indicator -->
    {#if msg.queueStatus === 'queued'}
      <div class="flex items-center gap-2 text-xs text-muted-foreground">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-warning" style="animation: pulse-dot 0.8s ease-in-out infinite"></span>
        排队中...
      </div>
    {:else if msg.queueStatus === 'running'}
      <div class="flex items-center gap-2 text-xs text-muted-foreground">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-success" style="animation: pulse-dot 0.8s ease-in-out infinite"></span>
        生成中...
      </div>
    {:else if msg.queueStatus === 'failed'}
      <div class="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
        ❌ {msg.queueError || '生成失败'}
      </div>
    {/if}
  </div>
</div>
