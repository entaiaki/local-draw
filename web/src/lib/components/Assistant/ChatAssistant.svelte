<script lang="ts">
  import type { AssistantMessage, GeneratedCard, DrawMode } from '$lib/types/assistant';
  import MessageList from './MessageList.svelte';
  import PromptCard from './PromptCard.svelte';
  import QuickPromptBox from './QuickPromptBox.svelte';
  import AssistantInput from './AssistantInput.svelte';
  import CharacterStyleDialog from './CharacterStyleDialog.svelte';
  import { assistantChat, submitToQueue, fetchMyQueue, fetchCharacters, fetchStyles, connectWs, getImageUrl, type WsStatusEvent } from '$lib/api';
  import { onMount, onDestroy } from 'svelte';

  let messages: AssistantMessage[] = $state([
    {
      id: '1',
      role: 'assistant' as const,
      content: '你好！我是你的 AI 绘图助手。你可以用自然语言告诉我你想画什么，我会帮你挑选最适合的角色 Lora、画风以及分辨率，并为你生成专属的生图卡片。比如你可以说："我想画一个原神的胡桃，赛博朋克风格，横屏尺寸"。',
      timestamp: Date.now(),
      card: null,
    },
  ]);
  let isLoading: boolean = $state(false);
  let generatedCard: GeneratedCard | null = $state(null);
  let messageListRef: MessageList | undefined = $state();
  let errorText: string = $state('');

  // Control bar state
  let autoApprove: boolean = $state(false);
  let alwaysScroll: boolean = $state(true);
  let drawMode: DrawMode = $state('WAI');
  let showCharDialog: boolean = $state(false);
  let characters: any[] = $state([]);
  let styles: string[] = $state([]);
  let selectedCharacter: string | null = $state(null);
  let selectedStyle: string | null = $state(null);

  // WebSocket
  let ws: WebSocket | null = null;
  let onlineCount = $state(0);
  let queuePollTimer: ReturnType<typeof setInterval> | null = null;

  function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  onMount(async () => {
    // Load characters & styles
    characters = await fetchCharacters();
    styles = await fetchStyles();

    // Connect WebSocket
    ws = connectWs(handleWsMessage);
  });

  onDestroy(() => {
    ws?.close();
    if (queuePollTimer) clearInterval(queuePollTimer);
  });

  function handleWsMessage(msg: WsStatusEvent) {
    if (msg.type === 'status') {
      if (msg.online !== undefined) onlineCount = msg.online;
    } else if (msg.type === 'queue_update') {
      // Poll queue when update arrives
      pollQueue();
    }
  }

  async function pollQueue() {
    const { items } = await fetchMyQueue();
    let activeCount = 0;
    for (const qi of items) {
      if (qi.status === 'pending' || qi.status === 'running') activeCount++;
      // Find matching message by queueId
      const msg = messages.find(m => m.queueId === qi.id);
      if (msg) {
        const patch: Partial<AssistantMessage> = {};
        // 状态映射：后端 pending/waiting → 前端 queued
        const mapped = qi.status === 'pending' || qi.status === 'waiting' ? 'queued' : qi.status;
        if (mapped !== msg.queueStatus) {
          patch.queueStatus = mapped as any;
          patch.queueError = qi.error;
        }
        // 完成时回填输出图片
        if (qi.status === 'done' && (qi as any)._output_files?.length) {
          patch.imagePath = (qi as any)._output_files[0];
        }
        if (Object.keys(patch).length) updateMessage(msg.id, patch);
      }
    }
    if (activeCount === 0 && queuePollTimer) {
      clearInterval(queuePollTimer);
      queuePollTimer = null;
    }
  }

  function updateMessage(id: string, patch: Partial<AssistantMessage>) {
    messages = messages.map(m => m.id === id ? { ...m, ...patch } : m);
  }

  function switchMode(mode: DrawMode): void {
    drawMode = mode;
  }

  async function handleSubmit(promptText: string): Promise<void> {
    if (!promptText.trim() || isLoading) return;

    errorText = '';
    const userMsg: AssistantMessage = {
      id: uid(),
      role: 'user' as const,
      content: promptText.trim(),
      timestamp: Date.now(),
      card: null,
    };
    messages = [...messages, userMsg];
    isLoading = true;
    messageListRef?.scrollToBottom();

    try {
      const history = messages
        .filter(m => m.role !== 'system')
        .slice(-6)
        .map(m => ({ role: m.role, content: m.content }));

      const data = await assistantChat(promptText.trim(), history);

      const card: GeneratedCard = {
        positivePrompt: data.card?.positive || promptText,
        negativePrompt: data.card?.negative || 'worst quality, low quality, blurry, bad anatomy, bad hands, watermark, text',
        originalPrompt: promptText.trim(),
        workflowPath: data.card?.workflow_path || `${drawMode}/base/none.json`,
        width: data.card?.width || 1344,
        height: data.card?.height || 768,
        styleTags: data.card?.style || selectedStyle || '',
        mode: drawMode,
        character: data.card?.character || selectedCharacter || '',
        style: data.card?.style || selectedStyle || '',
        reply: data.reply || '参数配置完成',
      };

      generatedCard = card;

      const assistantMsg: AssistantMessage = {
        id: uid(),
        role: 'assistant' as const,
        content: card.reply,
        timestamp: Date.now(),
        card,
        queueStatus: 'idle',
      };
      messages = [...messages, assistantMsg];

      // Auto-approve: submit to queue immediately
      if (autoApprove) {
        await submitGeneration(assistantMsg.id, card);
      }
    } catch (e: unknown) {
      errorText = e instanceof Error ? e.message : '网络错误';
      messages = [...messages, {
        id: uid(), role: 'assistant' as const,
        content: `❌ ${errorText}`, timestamp: Date.now(), card: null,
      }];
    } finally {
      isLoading = false;
      messageListRef?.scrollToBottom();
    }
  }

  async function submitGeneration(messageId: string, card: GeneratedCard): Promise<void> {
    updateMessage(messageId, { queueStatus: 'queued' });

    try {
      const result = await submitToQueue({
        workflow_path: card.workflowPath,
        direct_prompt: card.positivePrompt,
        workflow_prompt: card.positivePrompt,
        workflow_negative_prompt: card.negativePrompt,
        width: card.width,
        height: card.height,
        style_tags: card.styleTags,
      });

      updateMessage(messageId, {
        queueStatus: 'queued',
        queueId: result.item_id,
      });

      // Start polling
      if (!queuePollTimer) {
        queuePollTimer = setInterval(pollQueue, 2000);
      }
    } catch (e: any) {
      updateMessage(messageId, {
        queueStatus: 'failed',
        queueError: e.message || '提交失败',
      });
    }
  }

  function handleCharStyleSelect(char: string | null, style: string | null) {
    selectedCharacter = char;
    selectedStyle = style;
    showCharDialog = false;
  }
</script>

<div class="flex flex-col h-full" style="height: 100%;">
  <!-- Control Toolbar -->
  <div class="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50 shrink-0">
    <div class="flex items-center gap-4">
      <!-- Assistant header -->
      <div class="flex items-center gap-2">
        <span class="text-lg">🤖</span>
        <span class="font-semibold text-sm">AI 绘图助手</span>
        <button class="text-xs text-muted-foreground hover:text-foreground ml-1" title="使用教程">❓</button>
      </div>

      <div class="h-4 w-px bg-border"></div>

      <!-- Auto approve -->
      <label class="flex items-center gap-1.5 text-xs cursor-pointer text-muted-foreground hover:text-foreground">
        <input type="checkbox" bind:checked={autoApprove} class="accent-primary w-3.5 h-3.5" />
        自动批准
        <span class="text-muted-foreground/50">ⓘ</span>
      </label>

      <!-- Always scroll -->
      <label class="flex items-center gap-1.5 text-xs cursor-pointer text-muted-foreground hover:text-foreground">
        <input type="checkbox" bind:checked={alwaysScroll} class="accent-primary w-3.5 h-3.5" />
        始终滚动
      </label>
    </div>

    <div class="flex items-center gap-2">
      <!-- Mode switcher: WAI / Anima -->
      <div class="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
        {#each ['WAI', 'Anima', 'Flux'] as mode}
          <button
            class="px-2.5 py-1 text-xs font-medium rounded-md transition-all {drawMode === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}"
            onclick={() => switchMode(mode as DrawMode)}
          >{mode}</button>
        {/each}
      </div>

      <button
        class="px-3 py-1 text-xs font-medium rounded-lg border border-border hover:bg-muted transition-colors"
        onclick={() => showCharDialog = true}
      >选角色/画风</button>
    </div>
  </div>

  <!-- Body -->
  <div class="flex flex-1 min-h-0">
    <!-- Left: chat -->
    <div class="flex flex-col flex-1 min-w-0">
      <MessageList bind:this={messageListRef} {messages} {isLoading} {alwaysScroll} onsubmit={submitGeneration} />

      {#if errorText}
        <div class="px-4 pb-2">
          <p class="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">{errorText}</p>
        </div>
      {/if}

      <div class="p-3 border-t border-border bg-card/50">
        <AssistantInput onsubmit={handleSubmit} />
      </div>
    </div>

    <!-- Right: prompt card -->
    <div class="hidden md:flex flex-col w-72 border-l border-border p-4 space-y-4 overflow-y-auto shrink-0 bg-card/30">
      {#if generatedCard}
        <PromptCard card={generatedCard} onsubmit={() => {
          const lastMsg = [...messages].reverse().find(m => m.card === generatedCard);
          if (lastMsg) submitGeneration(lastMsg.id, generatedCard);
        }} />
      {/if}
      <QuickPromptBox onselect={handleSubmit} />
    </div>
  </div>

  <!-- Character/Style Dialog -->
  {#if showCharDialog}
    <CharacterStyleDialog
      {characters}
      {styles}
      {selectedCharacter}
      {selectedStyle}
      onSelect={handleCharStyleSelect}
      onClose={() => showCharDialog = false}
    />
  {/if}
</div>
