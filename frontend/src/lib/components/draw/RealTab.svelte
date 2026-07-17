<script lang="ts">
  import Icon from '@iconify/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import { Alert, AlertDescription } from '$lib/components/ui/alert';
  import { forumAuth } from '$lib/forum/stores/auth';
  import { drawEnv, apiError } from '$lib/draw/stores/env';
  import { autoResize } from '$lib/utils/actions';
import TurnstileWidget from '$lib/components/TurnstileWidget.svelte';
  import { addToQueue } from '$lib/draw/api/client';
  import { get } from 'svelte/store';

  let {
    turnstileToken = $bindable(''),
    turnstileTick = $bindable(0),
    pointsCostSubmit = 0,
    llmTokenPerPoint = 0,
    turnstileEnabled = true,
    workflowPath = 'ZImage/RedAIO.json',
  }: {
    turnstileToken?: string;
    turnstileTick?: number;
    pointsCostSubmit?: number;
    llmTokenPerPoint?: number;
    turnstileEnabled?: boolean;
    workflowPath?: string;
  } = $props();

  const STORAGE_KEY = 'draw-real';

  let isLoggedIn = $derived(!!forumAuth.getToken());
  let cnPrompt = $state('');
  let enPrompt = $state('');
  let translating = $state(false);
  let submitting = $state(false);
  let error = $state('');
  let queueSuccess = $state('');
  let apiErrorMessage = $state('');

  // Restore state from localStorage
  $effect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const p = JSON.parse(saved);
        if (p.cnPrompt) cnPrompt = p.cnPrompt;
        if (p.enPrompt) enPrompt = p.enPrompt;
      }
    } catch {}
  });

  // Persist state on every change
  $effect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ cnPrompt, enPrompt }));
    } catch {}
  });

  // Clear stored prompt after successful submission
  $effect(() => {
    if (queueSuccess && typeof localStorage !== 'undefined') {
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
    }
  });

  $effect(() => {
    const unsub = apiError.subscribe((v) => { apiErrorMessage = v || ''; });
    return unsub;
  });

  async function handleTranslate() {
    if (!cnPrompt.trim() || translating) return;
    translating = true;
    error = '';
    try {
      const token = forumAuth.getToken();
      if (!token) { error = '请先登录'; return; }
      const baseUrl = get(drawEnv.baseUrl);
      const resp = await fetch(`${baseUrl}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ prompt: cnPrompt, mode: 'real' }),
      });
      const data = await resp.json();
      if (data.ok) { enPrompt = data.positive; }
      else error = data.error || '翻译失败';
    } catch (e) {
      error = '翻译失败: ' + (e instanceof Error ? e.message : '未知错误');
    } finally {
      translating = false;
    }
  }

  async function handleSubmit() {
    if (submitting || !enPrompt.trim()) return;
    const token = forumAuth.getToken();
    if (!token) { error = '请先在论坛登录'; return; }

    error = '';
    queueSuccess = '';
    submitting = true;
    try {
      await addToQueue({
        direct_prompt: enPrompt.trim(),
        workflow_path: workflowPath,
        turnstile_token: turnstileToken || undefined,
      });
      turnstileTick++;
      queueSuccess = '成功加入队列！等待生图中，前往"我的"页面查看详情。';
    } catch (e) {
      error = e instanceof Error ? e.message : '加入队列失败';
    } finally {
      submitting = false;
    }
  }
</script>

<div class="space-y-4">
  {#if !isLoggedIn}
    <Alert>
      <Icon icon="mdi:account-alert-outline" class="size-4" />
      <AlertDescription class="text-xs">
        请先<a href="/forum/auth/login?redirect=/draw/" class="underline font-medium">登录论坛</a>后使用真人文生图功能。
      </AlertDescription>
    </Alert>
  {/if}

  {#if apiErrorMessage}
    <Alert>
      <Icon icon="mdi:cloud-alert" class="size-4 shrink-0" />
      <AlertDescription class="text-xs">{apiErrorMessage}</AlertDescription>
    </Alert>
  {/if}

  <!-- Prompt -->
  <div class="space-y-2">
    <h3 class="text-sm font-medium flex items-center gap-1.5">
      <Icon icon="mdi:text-box-outline" class="size-4" />
      描述
    </h3>
    <div class="space-y-1">
      <Label class="text-xs text-muted-foreground">中文描述</Label>
      <textarea
        bind:value={cnPrompt}
        use:autoResize
        placeholder="一个穿着西装的东方男性，电影级光影"
        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring scrollbar-hide"
        disabled={submitting}
      ></textarea>
    </div>
    <div class="flex items-center gap-2">
      <Button size="sm" variant="outline" onclick={handleTranslate} disabled={translating || !cnPrompt.trim()}>
        <Icon icon={translating ? "mdi:loading" : "mdi:auto-fix"} class="size-4 mr-1 {translating ? 'animate-spin' : ''}" />
        {translating ? "转换中..." : "翻译为英文"}
        {#if llmTokenPerPoint > 0 && cnPrompt?.length}{@const est = Math.max(1, Math.ceil(cnPrompt.length * 2 / (llmTokenPerPoint || 1)))}<Badge variant="secondary" class="ml-1 text-[10px] px-1">≈⚡{est}</Badge>{/if}
      </Button>
      <span class="text-[11px] text-muted-foreground">支持中文，但英文遵从度更好</span>
    </div>
    <div class="space-y-1">
      <Label class="text-xs text-muted-foreground">英文描述（最终使用的提示词）</Label>
      <textarea
        bind:value={enPrompt}
        use:autoResize
        placeholder="a Chinese man in suit, cinematic lighting"
        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring scrollbar-hide"
        disabled={submitting}
      ></textarea>
    </div>
  </div>

  {#if turnstileEnabled}
    <TurnstileWidget
      siteKey="0x4AAAAAADSVSh5jjelMNlrv"
      tick={turnstileTick}
      onToken={(t) => (turnstileToken = t)}
      onExpired={() => (turnstileToken = '')}
    />
  {/if}

  <!-- Submit -->
  <Button class="w-full" size="lg" onclick={handleSubmit} disabled={!isLoggedIn || submitting || !enPrompt.trim()}>
    {#if submitting}
      <Icon icon="mdi:loading" class="size-4 animate-spin" />
      加入队列中...
    {:else}
      <Icon icon="mdi:playlist-plus" class="size-5 mr-1.5" />
      加入队列
      {#if pointsCostSubmit > 0}<Badge variant="secondary" class="ml-1.5 text-[10px] px-1">⚡{pointsCostSubmit}</Badge>{/if}
    {/if}
  </Button>

  <!-- Error / Success -->
  {#if error}
    <Alert variant="destructive">
      <Icon icon="mdi:alert-circle" class="size-4" />
      <AlertDescription class="text-xs">{error}</AlertDescription>
    </Alert>
  {/if}
  {#if queueSuccess}
    <Alert>
      <Icon icon="mdi:check-circle" class="size-4" />
      <AlertDescription class="text-xs">{queueSuccess}</AlertDescription>
    </Alert>
  {/if}
</div>
