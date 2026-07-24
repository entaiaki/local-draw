<script lang="ts">
  import './app.css';
  import ChatAssistant from './lib/components/Assistant/ChatAssistant.svelte';
  import Img2imgTab from './lib/components/Assistant/Img2imgTab.svelte';
  import GalleryTab from './lib/components/Assistant/GalleryTab.svelte';
  import { ensureAuth, getToken, clearToken } from './lib/api';
  import { onMount } from 'svelte';

  let activeTab = $state<'generate' | 'mine' | 'featured'>('generate');
  let genMode = $state<'txt2img' | 'img2img'>('txt2img');
  let isLoggedIn = $state(false);
  let apiOnline = $state(false);
  let authChecking = $state(true);

  async function checkAuth() {
    authChecking = true;
    // Try existing token first
    if (getToken()) {
      // Verify by hitting health
      try {
        const r = await fetch('/health');
        apiOnline = r.ok;
        isLoggedIn = true;
      } catch {
        // Token might be stale, re-login
        isLoggedIn = await ensureAuth();
        apiOnline = isLoggedIn;
      }
    } else {
      isLoggedIn = await ensureAuth();
      apiOnline = isLoggedIn;
    }
    authChecking = false;
  }

  onMount(() => {
    checkAuth();
    // Periodic health check
    const timer = setInterval(async () => {
      try {
        const r = await fetch('/health');
        apiOnline = r.ok;
      } catch {
        apiOnline = false;
      }
    }, 15000);
    return () => clearInterval(timer);
  });
</script>

<div class="h-screen flex flex-col bg-background dot-grid-bg" style="height: 100vh;">
  <!-- Top Nav Bar -->
  <header class="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/80 backdrop-blur-sm shrink-0 z-10">
    <div class="flex items-center gap-3">
      <div class="flex items-center gap-1.5">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-primary">
          <path d="M12 19l7-7 3 3-7 7-3-3z"/>
          <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
          <path d="M2 2l7.586 7.586"/>
          <circle cx="11" cy="11" r="2"/>
        </svg>
        <span class="font-bold text-sm">AI 生图</span>
      </div>
      <div class="flex items-center gap-1.5 text-xs">
        {#if apiOnline}
          <span class="status-dot online"></span>
          <span class="text-success font-medium">API 在线</span>
        {:else if authChecking}
          <span class="status-dot" style="background: var(--color-warning)"></span>
          <span class="text-warning">连接中...</span>
        {:else}
          <span class="status-dot offline"></span>
          <span class="text-destructive">离线</span>
        {/if}
      </div>
    </div>

    <div class="flex items-center gap-1 bg-muted rounded-lg p-0.5">
      <button
        class="px-3 py-1.5 text-xs font-medium rounded-md transition-all {activeTab === 'generate' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}"
        onclick={() => activeTab = 'generate'}
      >✨ 生成</button>
      <button
        class="px-3 py-1.5 text-xs font-medium rounded-md transition-all {activeTab === 'mine' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}"
        onclick={() => activeTab = 'mine'}
      >👤 我的</button>
      <button
        class="px-3 py-1.5 text-xs font-medium rounded-md transition-all {activeTab === 'featured' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}"
        onclick={() => activeTab = 'featured'}
      >⭐ 精选</button>
    </div>

    <div class="flex items-center gap-2">
      {#if isLoggedIn}
        <span class="text-xs text-muted-foreground">⚡ 99999 点</span>
      {/if}
    </div>
  </header>

  <!-- Main Content -->
  <main class="flex-1 min-h-0 overflow-hidden">
    {#if activeTab === 'generate'}
      <div class="flex flex-col h-full">
        <!-- Sub-mode switcher -->
        <div class="flex items-center gap-1 px-4 pt-2 shrink-0">
          <button
            class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all {genMode === 'txt2img' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}"
            onclick={() => genMode = 'txt2img'}
          >✨ 文生图 - AI 助手</button>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all {genMode === 'img2img' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}"
            onclick={() => genMode = 'img2img'}
          >🖼️ 图生图 - Flux Kontext</button>
        </div>
        <div class="flex-1 min-h-0">
          {#if genMode === 'txt2img'}
            <ChatAssistant />
          {:else}
            <Img2imgTab />
          {/if}
        </div>
      </div>
    {:else if activeTab === 'mine'}
      <GalleryTab mode="mine" />
    {:else if activeTab === 'featured'}
      <GalleryTab mode="featured" />
    {/if}
  </main>
</div>
