<script lang="ts">
import Icon from '@iconify/svelte';
import { Button } from '$lib/components/ui/button';
import { Alert, AlertDescription } from '$lib/components/ui/alert';
import { Badge } from '$lib/components/ui/badge';
import { chatRequest, addToQueue, fetchMyQueue, getImageProxyUrl, getImageUrl, fetchChatPresets, saveChatPreset, deleteChatPreset, fetchChatHistory, appendChatHistory, clearChatHistory, drawRequest } from '$lib/draw/api/client';
import { drawEnv } from '$lib/draw/stores/env';
import { forumAuth } from '$lib/forum/stores/auth';
import { get } from 'svelte/store';
import { onMount, onDestroy } from 'svelte';
import { autoResize } from '$lib/utils/actions';

let {
  workflowPath = '',
  styleTags = '',
  negativePrompt = '',
  directPrompt = '',
  width = 0,
  height = 0,
  turnstileToken = '',
  pointsCostSubmit = 0,
  mode = 'wai',
  ttsMode = 'preset' as 'preset' | 'custom' | 'clone',
  ttsSpeaker = 'mimo_default',
  ttsInstruct = '',
  ttsTags = '',
}: {
  workflowPath?: string;
  styleTags?: string;
  negativePrompt?: string;
  directPrompt?: string;
  width?: number;
  height?: number;
  turnstileToken?: string;
  pointsCostSubmit?: number;
  mode?: string;
  ttsMode?: 'preset' | 'custom' | 'clone';
  ttsSpeaker?: string;
  ttsInstruct?: string;
  ttsTags?: string;
} = $props();

interface ChatPreset { id: string; name: string; systemPrompt: string; }

interface PendingImage { tags: string; itemId: number; status: string; imageUrl: string; }

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  imageUrls?: string[];
  pendingImages?: PendingImage[];
  ttsUrl?: string;
}

let presets = $state<ChatPreset[]>([]);
let selectedPresetIdx = $state<number>(-1);
let presetName = $state('');
let systemPrompt = $state('');
let chatMessages = $state<ChatMessage[]>([]);
let ttsEnabled = $state(typeof localStorage !== 'undefined' ? localStorage.getItem('saloon-tts') === 'true' : false);
let ttsLoading = $state(false);
$effect(() => { try { localStorage.setItem('saloon-tts', String(ttsEnabled)); } catch {} });

async function speakMessage(text: string, msgIdx?: number) {
  if (ttsLoading || !text) return;
  ttsLoading = true;
  try {
    const res = await drawRequest<{ ok: boolean; filename: string }>('/api/draw/tts/synthesize', {
      method: 'POST',
      json: {
        text,
        mode: ttsMode,
        speaker: ttsMode === 'preset' ? ttsSpeaker : undefined,
        instruct: ttsInstruct || undefined,
        tags: ttsTags || undefined,
        source: 'saloon',
      },
      requiresAuth: true,
    });
    if (res.ok && res.filename) {
      const url = getImageUrl(res.filename);
      if (msgIdx !== undefined) {
        chatMessages = chatMessages.map((m, i) => i === msgIdx ? { ...m, ttsUrl: url } : m);
      }
    }
  } catch {}
  ttsLoading = false;
}
let chatHistory = $state<Array<{ role: string; content: string; imageUrls?: string[]; systemPrompt?: string }>>([]);
let inputText = $state('');
let sending = $state(false);
let settingsOpen = $state(true);
let errorText = $state('');
let genEnabled = $state(typeof localStorage !== 'undefined' ? localStorage.getItem('saloon-gen') !== 'false' : true);
$effect(() => { try { localStorage.setItem('saloon-gen', String(genEnabled)); } catch {} });

let totalLlmCost = $state(0);
let totalLlmTokens = $state(0);
let totalGenCount = $state(0);
let totalGenCost = $state(0);

// 主动沉浸
let immersionEnabled = $state(false);
let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
const NUDGE_DELAY_MS = 35000;

// 队列轮询：itemId → messageIndex
let pendingItemIds = $state<Map<number, number>>(new Map());

async function loadPresets() {
  try { const res = await fetchChatPresets(); presets = res.items || []; } catch { presets = []; }
}

onMount(async () => {
  await loadPresets();
  try {
    const res = await fetchChatHistory();
    chatHistory = (res.items || []).slice(-40);
    chatMessages = chatHistory.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, imageUrls: m.imageUrls || [] }));
    if (chatMessages.length > 0) {
      // 恢复最后一条消息携带的 systemPrompt
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].systemPrompt) {
          systemPrompt = chatHistory[i].systemPrompt!;
          break;
        }
      }
    }
  } catch {}
});

onDestroy(() => { stopQueuePolling(); });

function selectPreset(idx: number) {
  selectedPresetIdx = idx;
  if (idx >= 0 && presets[idx]) { presetName = presets[idx].name; systemPrompt = presets[idx].systemPrompt; }
  else { presetName = ''; systemPrompt = ''; }
}

async function savePreset() {
  if (!presetName.trim() || !systemPrompt.trim()) return;
  try {
    await saveChatPreset(presetName.trim(), systemPrompt.trim());
    await loadPresets();
    selectedPresetIdx = presets.findIndex(p => p.name === presetName.trim());
  } catch (e: any) { errorText = '保存失败: ' + (e.message || '未知错误'); }
}

async function deletePreset() {
  if (selectedPresetIdx < 0 || !presets[selectedPresetIdx]) return;
  try {
    await deleteChatPreset(presets[selectedPresetIdx].id);
    await loadPresets();
    selectedPresetIdx = -1; presetName = ''; systemPrompt = '';
  } catch (e: any) { errorText = '删除失败: ' + (e.message || '未知错误'); }
}

function newPreset() { selectedPresetIdx = -1; presetName = ''; systemPrompt = ''; }

function clearChat() {
  chatMessages = []; chatHistory = [];
  pendingItemIds = new Map();
  totalLlmCost = 0; totalLlmTokens = 0; totalGenCount = 0; totalGenCost = 0;
  clearChatHistory().catch(() => {});
}

async function submitGenJob(tags: string, msgIdx: number) {
  let finalWfPath = workflowPath;
  if (finalWfPath.endsWith('.txt')) finalWfPath = 'WAI/通用/无Lora.json';
  // 工作流自带的角色 prompt 拼到 tags 前面，保证始终出同一个角色
  const finalPrompt = directPrompt?.trim() ? `${directPrompt.trim()}, ${tags}` : tags;
  try {
    const res = await addToQueue({
      direct_prompt: finalPrompt, width: width || undefined, height: height || undefined,
      style_tags: styleTags || undefined, negative_prompt: negativePrompt || undefined,
      workflow_path: finalWfPath, turnstile_token: turnstileToken || undefined,
      source: 'saloon',
    });
    // 添加到消息的 pendingImages
    chatMessages = chatMessages.map((m, i) => {
      if (i !== msgIdx) return m;
      const pending = [...(m.pendingImages || []), { tags, itemId: res.item_id, status: 'pending', imageUrl: '' }];
      return { ...m, pendingImages: pending };
    });
    pendingItemIds = new Map(pendingItemIds).set(res.item_id, msgIdx);
    totalGenCount++; totalGenCost += pointsCostSubmit;
    startQueuePolling();
  } catch {}
}

async function sendMessage() {
  const msg = inputText.trim();
  if (!msg || sending) return;
  if (!systemPrompt.trim()) { errorText = '请先填写角色设定'; return; }
  if (genEnabled && !workflowPath) { errorText = '请先在文生图页选择工作流'; return; }
  errorText = ''; sending = true;
  cancelNudge();

  chatMessages = [...chatMessages, { role: 'user', content: msg }];
  inputText = '';

  const assistantIdx = chatMessages.length;
  chatMessages = [...chatMessages, { role: 'assistant', content: '', streaming: true, imageUrls: [], pendingImages: [] }];

  try {
    const response = await chatRequest({
      message: msg, workflow_path: workflowPath || undefined, style_tags: styleTags || undefined,
      system_prompt: systemPrompt, negative_prompt: negativePrompt || 'worst quality, low quality, blurry',
      workflow_prompt: directPrompt || undefined,
      history: chatHistory, gen_enabled: genEnabled, mode,
    });

    const reader = response.body?.getReader();
    if (!reader) throw new Error('无法读取响应流');
    const decoder = new TextDecoder();
    let buffer = ''; let textContent = ''; let fullText = '';

    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx === -1) break;
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.startsWith('event: ')) {
          const eventType = line.slice(7).trim();
          const nextNewline = buffer.indexOf('\n');
          if (nextNewline === -1) { buffer = line + '\n' + buffer; break; }
          const dataLine = buffer.slice(0, nextNewline).trim();
          buffer = buffer.slice(nextNewline + 1);
          if (dataLine.startsWith('data: ')) {
            try {
              const data = JSON.parse(dataLine.slice(6));
              if (eventType === 'text' && data.content) {
                textContent += data.content;
                chatMessages = chatMessages.map((m, i) =>
                  i === assistantIdx ? { ...m, content: textContent, streaming: true } : m
                );
              } else if (eventType === 'gen_tags' && genEnabled && data.tags?.length) {
                // 直接提交生图，不写文字
                for (const tags of data.tags) {
                  await submitGenJob(tags, assistantIdx);
                }
              } else if (eventType === 'error') {
                textContent += `\n❌ ${data.message}`;
                chatMessages = chatMessages.map((m, i) =>
                  i === assistantIdx ? { ...m, content: textContent } : m
                );
              } else if (eventType === 'done') {
                if (data.llm_cost) totalLlmCost += data.llm_cost;
                if (data.llm_tokens) totalLlmTokens += data.llm_tokens;
                if (data.raw_text) fullText = data.raw_text;
              }
            } catch {}
          }
        }
      }
    }

    chatMessages = chatMessages.map((m, i) => i === assistantIdx ? { ...m, streaming: false } : m);

    // 朗读模式：自动 TTS
    if (ttsEnabled && textContent.trim()) { speakMessage(textContent, assistantIdx); }

    // 历史保存原始 fullText（含 [GEN:] 标签），让 LLM 能看到之前的生图 tags
    // 显示用 textContent（干净文本），UI 已过滤
    chatHistory = [...chatHistory, { role: 'user', content: msg, systemPrompt }, { role: 'assistant', content: fullText }];
    if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);

    // 立即保存用户消息
    try { await appendChatHistory([{ role: 'user', content: msg, systemPrompt }]); } catch {}

    // 如果没有生图任务，立即保存助手消息；否则等图片完成后再保存
    const assistantMsg = chatMessages[assistantIdx];
    if (!assistantMsg?.pendingImages?.length) {
      try { await appendChatHistory([{ role: 'assistant', content: fullText }]); } catch {}
    }
    startNudgeTimer();
  } catch (e: any) {
    chatMessages = chatMessages.map((m, i) =>
      i === assistantIdx ? { ...m, content: `❌ ${e.message || '请求失败'}`, streaming: false } : m
    );
  }
  sending = false;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

function startQueuePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (pendingItemIds.size === 0) { stopQueuePolling(); return; }
    try {
      const res = await fetchMyQueue();
      for (const item of res.items) {
        if (!pendingItemIds.has(item.id)) continue;
        const msgIdx = pendingItemIds.get(item.id)!;
        if (item.status === 'done') {
          const files = (item as any)._output_files as string[] | undefined;
          let imageUrl = '';
          if (files?.length) {
            const f = files[0]; const parts = f.split('/');
            const filename = parts.pop()!; const subfolder = parts.join('/');
            imageUrl = getImageProxyUrl(filename, subfolder);
          }
          // 直接修改元素，不替换数组
          if (chatMessages[msgIdx]) {
            chatMessages[msgIdx].imageUrls = [...(chatMessages[msgIdx].imageUrls || []), imageUrl];
            chatMessages[msgIdx].pendingImages = (chatMessages[msgIdx].pendingImages || []).filter(p => p.itemId !== item.id);
          }
          // 更新 chatHistory，所有图片完成后保存一次
          const updatedMsg = chatMessages[msgIdx];
          if (updatedMsg) {
            if (chatHistory[msgIdx]) chatHistory[msgIdx].imageUrls = updatedMsg.imageUrls;
            if (!updatedMsg.pendingImages?.length) {
              try { await appendChatHistory([{ role: 'assistant', content: updatedMsg.content, imageUrls: updatedMsg.imageUrls }]); } catch {}
            }
          }
          pendingItemIds = new Map([...pendingItemIds].filter(([k]) => k !== item.id));
        } else if (item.status === 'failed') {
          if (chatMessages[msgIdx]) {
            chatMessages[msgIdx].pendingImages = (chatMessages[msgIdx].pendingImages || []).map(p =>
              p.itemId === item.id ? { ...p, status: 'failed' } : p
            );
          }
          pendingItemIds = new Map([...pendingItemIds].filter(([k]) => k !== item.id));
        } else {
          if (chatMessages[msgIdx]) {
            chatMessages[msgIdx].pendingImages = (chatMessages[msgIdx].pendingImages || []).map(p =>
              p.itemId === item.id ? { ...p, status: item.status } : p
            );
          }
        }
      }
    } catch {}
    if (pendingItemIds.size === 0) stopQueuePolling();
  }, 3000);
}

function stopQueuePolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// --- 主动沉浸 ---

function cancelNudge() { if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; } }

function startNudgeTimer() {
  cancelNudge();
  if (!immersionEnabled) return;
  nudgeTimer = setTimeout(() => sendNudge(), NUDGE_DELAY_MS);
}

async function sendNudge() {
  if (!systemPrompt.trim() || chatMessages.length === 0) return;
  const baseUrl = get(drawEnv.baseUrl);
  const token = forumAuth.getToken();
  if (!token) return;
  const body = JSON.stringify({
    system_prompt: systemPrompt,
    workflow_prompt: directPrompt || '',
    negative_prompt: negativePrompt || '',
    history: chatHistory.slice(-20),
    mode,
  });

  try {
    const resp = await fetch(baseUrl + '/api/draw/chat/nudge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    });
    if (!resp.ok) return;
    const nudgeIdx = chatMessages.length;
    chatMessages = [...chatMessages, { role: 'assistant', content: '', streaming: true, imageUrls: [], pendingImages: [] }];
    const reader = resp.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buf = '', textContent = '', fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      while (true) {
        const nl = buf.indexOf('\n');
        if (nl === -1) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('event: ')) {
          const evt = line.slice(7).trim();
          const dn = buf.indexOf('\n');
          if (dn === -1) { buf = line + '\n' + buf; break; }
          const dl = buf.slice(0, dn).trim();
          buf = buf.slice(dn + 1);
          if (dl.startsWith('data: ')) {
            try {
              const d = JSON.parse(dl.slice(6));
              if (evt === 'text' && d.content) {
                textContent += d.content;
                chatMessages = chatMessages.map((m, i) => i === nudgeIdx ? { ...m, content: textContent, streaming: true } : m);
              } else if (evt === 'gen_tags' && genEnabled && d.tags?.length) {
                for (const tags of d.tags) { await submitGenJob(tags, nudgeIdx); }
              } else if (evt === 'error') {
                textContent += `\n❌ ${d.message}`;
                chatMessages = chatMessages.map((m, i) => i === nudgeIdx ? { ...m, content: textContent } : m);
              } else if (evt === 'done') {
                if (d.raw_text) fullText = d.raw_text;
              }
            } catch {}
          }
        }
      }
    }
    chatMessages = chatMessages.map((m, i) => i === nudgeIdx ? { ...m, streaming: false } : m);
    // 朗读模式：自动 TTS
    if (ttsEnabled && fullText.trim()) { speakMessage(fullText, nudgeIdx); }
    chatHistory = [...chatHistory, { role: 'assistant', content: fullText }];
    if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
    try {
      const { appendChatHistory: ach } = await import('$lib/draw/api/client');
      await ach([{ role: 'assistant', content: fullText }]);
    } catch {}
    if (immersionEnabled) startNudgeTimer();
  } catch {}
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

let chatContainer: HTMLDivElement | undefined;
$effect(() => {
  if (chatMessages.length && chatContainer) {
    requestAnimationFrame(() => { if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight; });
  }
});
</script>

<div class="flex flex-col h-[calc(100vh-260px)] min-h-[400px]">
  <!-- 设定区 -->
  <div class="border rounded-lg bg-card mb-3">
    <button class="w-full flex items-center justify-between px-3 py-2 text-sm font-medium" onclick={() => settingsOpen = !settingsOpen}>
      <span class="flex items-center gap-1.5">
        <Icon icon="mdi:cog-outline" class="size-4" />
        角色扮演设定
        {#if presetName}<Badge variant="secondary" class="text-[10px]">{presetName}</Badge>{/if}
      </span>
      <Icon icon={settingsOpen ? "mdi:chevron-up" : "mdi:chevron-down"} class="size-4 text-muted-foreground" />
    </button>
    {#if settingsOpen}
      <div class="px-3 pb-3 space-y-2 border-t pt-2">
        <div class="flex gap-2">
          <select class="flex-1 h-8 text-xs border rounded px-2 bg-background" value={selectedPresetIdx} onchange={(e) => selectPreset(Number(e.currentTarget.value))}>
            <option value={-1}>-- 选择或新建 --</option>
            {#each presets as p, i}<option value={i}>{p.name}</option>{/each}
          </select>
          {#if selectedPresetIdx >= 0}
            <Button variant="outline" size="sm" class="h-8 px-2 text-xs text-destructive" onclick={deletePreset}><Icon icon="mdi:delete-outline" class="size-3.5" /></Button>
          {/if}
        </div>
        <input type="text" class="w-full h-8 text-xs border rounded px-2 bg-background" placeholder="给这个角色设定起个名字" bind:value={presetName} />
        <textarea use:autoResize class="w-full text-xs border rounded px-2 py-1.5 bg-background scrollbar-hide" placeholder="你正在扮演遐蝶。你是一个..." bind:value={systemPrompt}></textarea>
        <div class="flex gap-2">
          <Button variant="default" size="sm" class="h-7 text-xs" onclick={savePreset}><Icon icon="mdi:content-save-outline" class="size-3.5 mr-1" />保存预设</Button>
          <Button variant="outline" size="sm" class="h-7 text-xs" onclick={newPreset}>新建</Button>
          <Button variant="outline" size="sm" class="h-7 text-xs ml-auto" onclick={clearChat}>
            <Icon icon="mdi:chat-remove-outline" class="size-3.5 mr-1" />清空聊天
          </Button>
        </div>
      </div>
    {/if}
  </div>

  <!-- 聊天消息区 -->
  <div bind:this={chatContainer} class="flex-1 overflow-y-auto space-y-3 px-1 pb-3">
    {#if chatMessages.length === 0}
      <div class="flex items-center justify-center h-full text-muted-foreground text-sm">开始与角色对话吧</div>
    {/if}
    {#each chatMessages as msg, i}
      <div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
        <div class="max-w-[80%] {msg.role === 'user'
          ? 'bg-primary text-primary-foreground rounded-2xl rounded-br-sm'
          : 'bg-muted rounded-2xl rounded-bl-sm'
        } px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {msg.content}
          {#if msg.streaming}<span class="animate-pulse">|</span>{/if}

          <!-- 已完成的图片 -->
          {#if msg.imageUrls?.length}
            <div class="flex flex-wrap gap-1.5 mt-2">
              {#each msg.imageUrls as url}
                {#if url}
                  <a href={url} target="_blank" rel="noopener">
                    <img src={url} alt="" class="max-w-[180px] rounded border" loading="lazy" />
                  </a>
                {/if}
              {/each}
            </div>
          {/if}

          <!-- 生成中的图片占位 -->
          {#if msg.pendingImages?.length}
            <div class="flex flex-wrap gap-1.5 mt-2">
              {#each msg.pendingImages as pending}
                <div class="w-[120px] h-[120px] rounded border bg-background/50 flex flex-col items-center justify-center gap-1">
                  {#if pending.status === 'failed'}
                    <Icon icon="mdi:alert-circle" class="size-6 text-destructive" />
                    <span class="text-[10px] text-destructive">失败</span>
                  {:else}
                    <div class="size-8 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
                    <span class="text-[10px] text-muted-foreground">
                      {pending.status === 'pending' ? '排队中' : pending.status === 'waiting' ? '等待中' : '生图中'}
                    </span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if msg.ttsUrl}
            <div class="mt-1.5">
              <audio src={msg.ttsUrl} controls class="w-full h-8 max-w-full" preload="none"></audio>
            </div>
          {/if}

        </div>
      </div>
    {/each}
  </div>

  <!-- 输入区 -->
  <div class="flex gap-2 pt-2 border-t items-center">
    <div class="flex h-9 border rounded overflow-hidden">
      <button class="flex items-center gap-1 px-2 text-xs transition-colors {genEnabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}" onclick={() => genEnabled = !genEnabled} title={genEnabled ? '生图已开启，点击关闭' : '生图已关闭，点击开启'}>
        <Icon icon="mdi:image-outline" class="size-4" />
        <span class="hidden sm:inline">{genEnabled ? '生图' : '纯聊'}</span>
      </button>
      <button class="flex items-center gap-1 px-2 text-xs transition-colors {immersionEnabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}" onclick={() => { immersionEnabled = !immersionEnabled; if (!immersionEnabled) cancelNudge(); }} title={immersionEnabled ? '主动沉浸已开启，角色会自动推动对话' : '主动沉浸已关闭，角色等待回复'}>
        <Icon icon="mdi:autorenew" class="size-4" />
        <span class="hidden sm:inline">主动</span>
      </button>
      <button class="flex items-center gap-1 px-2 text-xs transition-colors {ttsEnabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}" onclick={() => { ttsEnabled = !ttsEnabled; }} title={ttsEnabled ? '朗读已开启' : '朗读已关闭'}>
        <Icon icon={ttsLoading ? 'mdi:loading' : 'mdi:volume-high'} class="size-4 {ttsLoading ? 'animate-spin' : ''}" />
        <span class="hidden sm:inline">{ttsLoading ? '朗读中' : ttsEnabled ? '朗读' : '静音'}</span>
      </button>
    </div>
    <input type="text" class="flex-1 h-9 text-sm border rounded px-3 bg-background" placeholder={genEnabled ? '输入消息，AI 会边聊边生图...' : '输入消息...'} bind:value={inputText} onkeydown={handleKeydown} disabled={sending} />
    <Button variant="default" size="sm" class="h-9 px-4" onclick={sendMessage} disabled={sending || !inputText.trim()}>
      {#if sending}<Icon icon="mdi:loading" class="size-4 animate-spin" />{:else}<Icon icon="mdi:send" class="size-4" />{/if}
    </Button>
  </div>

  {#if errorText}
    <Alert variant="destructive" class="mt-2">
      <Icon icon="mdi:alert-circle" class="size-4" />
      <AlertDescription class="text-xs">{errorText}</AlertDescription>
    </Alert>
  {/if}

  {#if totalLlmCost > 0 || totalGenCount > 0}
    <div class="flex items-center gap-3 text-[10px] text-muted-foreground pt-1.5 border-t mt-1.5">
      <span>本次消耗：</span>
      {#if totalLlmCost > 0}<span>💬 LLM {totalLlmTokens} tokens / {totalLlmCost} 点</span>{/if}
      {#if totalGenCount > 0}<span>🎨 生图 ×{totalGenCount} / {totalGenCost} 点</span>{/if}
      <span class="font-medium text-foreground">共 {totalLlmCost + totalGenCost} 点</span>
    </div>
  {/if}
</div>
