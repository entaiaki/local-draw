<script lang="ts">
  import Icon from '@iconify/svelte';
  import { siteConfig } from '$lib/config/site';
  import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
  import { Badge } from '$lib/components/ui/badge';
  import { Alert, AlertDescription } from '$lib/components/ui/alert';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { forumAuth } from '$lib/forum/stores/auth';
  import { drawEnv, apiError, apiStatus, resolveApiRedirect, redirectLogs } from '$lib/draw/stores/env';
  import { connectStatusWs } from '$lib/draw/api/ws';
  import { fetchMyImages, getImageUrl, getImageProxyUrl, forkOutputImage, recommendImage, deleteMyImage, fetchMyRecommendations, addToQueue, fetchMyQueue, fetchWalletBalance, createWalletOrder, fetchPlans, fetchPointsConfig, fetchWorkflowDetail, fetchAnnouncement, fetchStyles, fetchTtsMyRecords, getTtsRecordDownloadUrl, deleteTtsMyRecord } from '$lib/draw/api/client';
import { clearMyImages } from '$lib/draw/api/client';
  import { consumeFork } from '$lib/draw/stores/fork';
import { fetchOutputMeta } from '$lib/draw/api/client';
  import { forumToast } from '$lib/forum/stores/toast';
  import { get } from 'svelte/store';
  import { onMount, onDestroy } from 'svelte';
  import type { WsStatusEvent, DrawWorkflow, DrawRecommendation } from '$lib/draw/types';
  let announcementText = $state('');
  let announcementTitle = $state('');
  let announcementOpen = $state(false);


  import EnvironmentSwitcher from '$lib/components/draw/EnvironmentSwitcher.svelte';
  import WorkflowDialog from '$lib/components/draw/WorkflowDialog.svelte';
  import StyleDialog from '$lib/components/draw/StyleDialog.svelte';
  import PromptForm from '$lib/components/draw/PromptForm.svelte';

  import FeaturedTab from '$lib/components/draw/FeaturedTab.svelte';
  import Img2imgTab from '$lib/components/draw/Img2imgTab.svelte';
  import SaloonTab from '$lib/components/draw/SaloonTab.svelte';
  import TtsTab from '$lib/components/draw/TtsTab.svelte';
  import RealTab from '$lib/components/draw/RealTab.svelte';
  import VideoTab from '$lib/components/draw/VideoTab.svelte';
  import ImageLightbox from '$lib/components/draw/ImageLightbox.svelte';

  // State
  let currentBaseUrl = $state('');
  let onlineCount = $state(0);
  let walletBalance = $state<number | null>(null);
  let walletLoading = $state(false);
  let rechargeOpen = $state(false);
  let recharging = $state(false);
  let plans = $state<Array<{ id: string; name: string; url: string; points: number }>>([]);
  let pointsConfig = $state<{ text_to_image: number; image_to_image: number; llm_translate: number; llm_token_per_point: number; signup_bonus: number; text_to_image_anima: number; text_to_image_real: number; tts_generate: number; tts_per_char: number; tts_per_sec: number } | null>(null);
  let walletTimer: ReturnType<typeof setInterval> | null = null;
  let waiHelpOpen = $state(false);
  let animaHelpOpen = $state(false);
  let ernieHelpOpen = $state(false);
  let saloonHelpOpen = $state(false);
  let txt2imgHelpOpen = $state(false);
  let img2imgHelpOpen = $state(false);
  let realHelpOpen = $state(false);
  let dsOutage = $state(false);
  let queuing = $state(false);
  let queueTimer: ReturnType<typeof setInterval> | null = null;
  let globalBusy = $state(false);
  let settingsOpen = $state(false);

  let authToken = $state<string | null>(null);
  let isLoggedIn = $derived(!!authToken);

  // Form state
  let workflowPath = $state('');
  let workflowName = $state('');
  let styleTags = $state('');
  let styleName = $state('');
  let directPrompt = $state('');
  let workflowPrompt = $state("");
  let workflowNegativePrompt = $state("");
  let negativePrompt = $state('');
  let nlPrompt = $state('');
  let width = $state(0);
  let height = $state(0);
  let forkSeed = $state<number | undefined>(undefined);
  let sameSeed = $state(false);

  // Restore form state from localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        const saved = localStorage.getItem('draw-form');
        if (saved) {
          const p = JSON.parse(saved);
          if (p.workflowPath) workflowPath = p.workflowPath;
          if (localStorage.getItem('wf_prompt')) workflowPrompt = localStorage.getItem('wf_prompt')!;
          if (localStorage.getItem('wf_neg_prompt')) workflowNegativePrompt = localStorage.getItem('wf_neg_prompt')!;
          if (p.workflowName) workflowName = p.workflowName;
          if (p.styleTags) styleTags = p.styleTags;
          if (p.styleName) styleName = p.styleName;
          if (p.directPrompt) directPrompt = p.directPrompt;
          if (p.negativePrompt) negativePrompt = p.negativePrompt;
          if (p.nlPrompt) nlPrompt = p.nlPrompt;
          if (p.width) width = p.width;
          if (p.height) height = p.height;
          if (p.forkSeed !== undefined) forkSeed = p.forkSeed;
          if (p.sameSeed !== undefined) sameSeed = p.sameSeed;
        }
      } catch {}
      // read fork pending
      try {
        const f = localStorage.getItem("draw-fork-pending");
        if (f) {
          const d = JSON.parse(f);
          if (d.builtin_prompt) directPrompt = d.builtin_prompt;
          if (d.builtin_negative_prompt) negativePrompt = d.builtin_negative_prompt;
          if (d.default_width) width = d.default_width;
          if (d.default_height) height = d.default_height;
          if (d.seed) forkSeed = d.seed;

          if (d.workflow_path) workflowPath = d.workflow_path;
          if (d.workflow_name) workflowName = d.workflow_name;
          if (d.style_tags) { styleTags = d.style_tags; styleName = d.style_tags; }
          else { styleTags = ''; styleName = ''; }
          localStorage.removeItem("draw-fork-pending");
        }
      } catch {}
    }
  // Progress state


  // My images state
  let myImages = $state<{ path: string; mtime: number }[]>([]);
  let myImagesTotal = $state(0);
  let myImagesLoading = $state(false);
  let myImagesLoaded = $state(false);
  let myQueueItems = $state<Array<{ id: number; status: string; created_at: number; started_at?: number; finished_at?: number; error?: string; position?: number | null }>>([]);
  let queueErrors = $state<Record<string, string>>({});
  let dismissedErrors = $state<Set<string>>(new Set());
  let ttsMyRecords = $state<Array<{ id: number; user_id: number; text: string; refText: string | null; xVectorMode: boolean; language: string; audioDuration: number; cost: number; outputPath: string | null; created_at: number; finished_at: number }>>([]);
  let ttsMyRecordsLoading = $state(false);
  let ttsMyRecordsLoaded = $state(false);
  let saloonImages = $state<{ path: string; mtime: number }[]>([]);
  let saloonImagesLoading = $state(false);
  let imageCategory = $state<'all' | 'saloon'>('all');
  let displayImages = $derived(imageCategory === 'all' ? myImages : saloonImages);
  let displayLoading = $derived(imageCategory === 'all' ? myImagesLoading : saloonImagesLoading);
  let displayTotal = $derived(imageCategory === 'all' ? myImagesTotal : saloonImages.length);

  async function loadSaloonImages() {
    saloonImagesLoading = true;
    try {
      const baseUrl = get(drawEnv.baseUrl);
      const token = forumAuth.getToken();
      const resp = await fetch(baseUrl + '/api/draw/my-images?source=saloon&_t=' + Date.now(), {
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
      });
      if (resp.ok) saloonImages = (await resp.json()).items || [];
    } catch {}
    saloonImagesLoading = false;
  }

  async function loadTtsMyRecords() {
    ttsMyRecordsLoading = true;
    try { ttsMyRecords = (await fetchTtsMyRecords()).items; ttsMyRecordsLoaded = true; } catch { ttsMyRecords = []; }
    finally { ttsMyRecordsLoading = false; }
  }

  $effect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      const saved = localStorage.getItem('draw-queue-errors');
      if (saved) queueErrors = JSON.parse(saved);
      const dismissed = localStorage.getItem('draw-dismissed-errors');
      if (dismissed) dismissedErrors = new Set(JSON.parse(dismissed));
    } catch {}
  });

  function saveQueueErrors() {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('draw-queue-errors', JSON.stringify(queueErrors));
    localStorage.setItem('draw-dismissed-errors', JSON.stringify([...dismissedErrors]));
  }

  function dismissQueueError(id: number) {
    const key = String(id);
    dismissedErrors = new Set([...dismissedErrors, key]);
    const updated = { ...queueErrors };
    delete updated[key];
    queueErrors = updated;
    saveQueueErrors();
  }
  let myQueueLoading = $state(false);
  let prevQueueIds = new Set<number>();
  let notifiedIds = new Set<number>();
  // Masonry layout
  let columnCount = $state(4);
  let imgColumns = $state<string[][]>([[], [], [], []]);
  let columnHeights: number[] = [0, 0, 0, 0];
  let sentinelEl: HTMLDivElement | undefined;
  let io: IntersectionObserver | null = null;
  let hasMore = $state(true);
  let loadingMore = $state(false);
  let myImagesDisplayLimit = $state(5);
let expandedAudioId = $state<string | null>(null);
let audioMeta = $state<Record<string, { prompt?: string; speaker?: string; language?: string }>>({});

// TTS settings (shared between TtsTab and SaloonTab)
let ttsMode = $state<'preset' | 'custom' | 'clone'>('preset');
let ttsSpeaker = $state('mimo_default');
let ttsInstruct = $state('');
let ttsTargetText = $state('');
let ttsLanguage = $state('auto');
let ttsTags = $state('');

  // My images lightbox
  let myLbOpen = $state(false);
  let myLbIndex = $state(0);
  let myLbImages = $derived(displayImages.map((it) => ({ src: getImageUrl(it.path), cached: getImageProxyUrl(it.path), creator_id: '' })));

  // Recommendations
  let myRecommendations = $state<DrawRecommendation[]>([]);
  let myRecsLoaded = $state(false);
  let myRecsOpen = $state(false);
  let selectMode = $state(false);
  let selectedPaths = $state(new Set<string>());

  // WebSocket refs
  let statusConn: ReturnType<typeof connectStatusWs> | null = null;


  // API error state
  let apiErrorMessage = $state("");
  let apiStatusValue = $state("checking");
    let turnstileToken = $state("");
    let turnstileTick = $state(0);

  $effect(() => {
    const unsub = apiError.subscribe((v) => {
      if (v) console.log('[API] 错误设置:', v);
      apiErrorMessage = v || '';
    });
    return unsub;
  });

  $effect(() => {
    const unsub = apiStatus.subscribe((v) => {
      console.log('[API] 状态变化:', v);
      apiStatusValue = v;
    });
    return unsub;
  });

  // 页面加载时探测 API 状态
  $effect(() => {
    resolveApiRedirect();
  });

  // Tab state — 从 URL hash 恢复，格式: #tab/subtab/subsubtab
  function parseHash(): { main: string; sub: string; subsub: string } {
    const parts = (location.hash?.slice(1) || '').split('/');
    return { main: parts[0] || 'generate', sub: parts[1] || '', subsub: parts[2] || '' };
  }
  const initialHash = parseHash();
  let activeTab = $state(initialHash.main);
  let genSubTab = $state(['img2img','txt2img','saloon','tts','video'].includes(initialHash.sub) ? initialHash.sub : 'txt2img');
  let genTxtSubTab = $state(['wai','anima','ernie','real'].includes(initialHash.subsub) ? initialHash.subsub : 'wai');
  let imgSubTab = $state(['flux2','qwen'].includes(initialHash.subsub) ? initialHash.subsub : 'flux2');
  let selectedMode = $state(genTxtSubTab);

  function applyHash(hash: string) {
    const parts = (hash?.slice(1) || '').split('/');
    const main = parts[0] || 'generate';
    const sub = parts[1] || '';
    const subsub = parts[2] || '';
    activeTab = main;
    if (main === 'generate') {
      genSubTab = ['img2img','txt2img','saloon','tts','video'].includes(sub) ? sub : 'txt2img';
      if (sub === 'txt2img') genTxtSubTab = ['wai','anima','ernie','real'].includes(subsub) ? subsub : 'wai';
      else if (sub === 'img2img') imgSubTab = ['flux2','qwen'].includes(subsub) ? subsub : 'flux2';
    }
  }

  // 监听浏览器前进/后退
  $effect(() => {
    const handler = () => applyHash(location.hash);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  });

  // tab/子tab 变化时更新 URL hash（跳过 popstate 导致的变更，避免循环）
  let prevHash = $state('');
  $effect(() => {
    if (typeof location === 'undefined') return;
    const parts = [activeTab];
    if (activeTab === 'generate') {
      parts.push(genSubTab);
      if (genSubTab === 'txt2img') parts.push(genTxtSubTab);
      else if (genSubTab === 'img2img') parts.push(imgSubTab);
    }
    const hash = '#' + parts.join('/');
    if (hash !== prevHash) {
      prevHash = hash;
      history.replaceState(null, '', hash);
    }
  });

  const state = $derived({ workflowPath, workflowName, styleTags, styleName, directPrompt, negativePrompt, nlPrompt, width, height, forkSeed, sameSeed });

    // Persist form state to localStorage
  $effect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('draw-form', JSON.stringify(state));
  });

  $effect(() => {
    if (activeTab === 'mine' && isLoggedIn) {
      loadMyImages();
      if (!ttsMyRecordsLoaded) loadTtsMyRecords();
      loadSaloonImages();
      myQueueLoading = true;
      loadMyQueue();
      queueTimer = setInterval(loadMyQueue, 1000);
      if ('Notification' in window && Notification.permission === 'default') { Notification.requestPermission(); }
      if (!myRecsLoaded) loadMyRecommendations();
    } else {
      if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
    }
    return () => { if (queueTimer) { clearInterval(queueTimer); queueTimer = null; } };
  });

  $effect(() => {
    if (isLoggedIn) {
      loadWalletBalance();
      fetchPlans().then(r => plans = r.items).catch(() => {});
      fetchPointsConfig().then(r => pointsConfig = r).catch(() => {});
    } else {
      walletBalance = null;
      plans = [];
      pointsConfig = null;
      if (walletTimer) { clearInterval(walletTimer); walletTimer = null; }
    }
  });
  // Check DeepSeek status
  if (typeof window !== 'undefined') {
    fetch('https://status.deepseek.com/feed.rss')
      .then(r => r.text())
      .then(xml => {
        const items = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)];
        dsOutage = items.some(item => {
          const title = item[0].match(/<title>(.*?)<\/title>/)?.[1] || '';
          return title.toLowerCase().includes('outage') || title.toLowerCase().includes('degraded');
        });
      })
      .catch(() => {});
  }

  $effect(() => {
    console.log('[FORK] $effect (consumeFork) running');
      const u1 = drawEnv.baseUrl.subscribe((v) => {
        if (v !== currentBaseUrl) console.log('[FORK] baseUrl changed:', currentBaseUrl, '->', v);
        currentBaseUrl = v;
      });
    authToken = forumAuth.getToken();

    // 检查是否有待消费的 fork 数据（从其他页面跳转过来）
    const res = consumeFork();
      console.log('[FORK] $effect after consumeFork');
    if (res) {
        if (res.builtin_prompt) { directPrompt = res.builtin_prompt; workflowPrompt = res.builtin_prompt; }
      if (res.builtin_negative_prompt) { negativePrompt = res.builtin_negative_prompt; workflowNegativePrompt = res.builtin_negative_prompt; }
      if (res.default_width) width = res.default_width;
      if (res.default_height) height = res.default_height;
      forkSeed = res.seed;
      if (res.workflow_path && res.workflow_path !== 'fork') workflowPath = res.workflow_path;
      if (res.workflow_name) workflowName = res.workflow_name;
        else workflowName = workflowPath ? workflowPath.split('/').pop()?.replace(/\.(json|txt)$/, '') || '(fork)' : '(fork)';
      if (res.style_tags) {
        styleTags = res.style_tags;
        styleName = res.style_tags;
      } else {
        styleTags = '';
        styleName = '';
      }
      console.log('[FORK] $effect setting activeTab=generate');
        activeTab = 'generate';
    }

    // Connect status WebSocket
    statusConn = connectStatusWs(currentBaseUrl, handleStatusMessage, undefined, () => { globalBusy = false; });

    return () => {
      u1();
      statusConn?.close();
      };
  });

  // Reconnect status WS when base URL changes
  $effect(() => {
    const url = currentBaseUrl;
    if (!url) return;
    statusConn?.close();
    statusConn = connectStatusWs(url, handleStatusMessage, undefined, () => { globalBusy = false; });
  });

  let progressStage = $state('');
  let progressNode = $state('');
  let progressValue = $state(0);
  let progressMax = $state(0);

  function handleStatusMessage(msg: WsStatusEvent) {
    switch (msg.type) {
      case 'status':
        onlineCount = msg.online;
        globalBusy = msg.busy;
        if (msg.stage) progressStage = msg.stage;
        if (msg.node) progressNode = msg.node;
        if (msg.value !== undefined) progressValue = msg.value;
        if (msg.max !== undefined) progressMax = msg.max;
        break;
      case 'online':
        onlineCount = msg.count;
        break;
    }
  }

  function handleWorkflowSelect(wf: DrawWorkflow) {
    workflowPath = wf.path;
    workflowName = wf.path.split('/').pop()?.replace(/\.(json|txt)$/, '') || '';
    forkSeed = undefined;
    sameSeed = false;
    // 记录选工作流时的模式
    selectedMode = genTxtSubTab;
  }

  function handleStyleSelect(tags: string, name: string) {
    styleTags = tags;
    styleName = name;
  }

  function handlePromptLoad(positive: string, negative: string) {
      directPrompt = positive;
      negativePrompt = negative;
      workflowPrompt = positive;
      workflowNegativePrompt = negative;
      localStorage.setItem('wf_prompt', positive);
      localStorage.setItem('wf_neg_prompt', negative);
    }

  async function handleFork(path: string) {
    console.log('[FORK] handleFork called', path);
    try {
      const res = await forkOutputImage(path);
      console.log('[FORK] API done', res);
      if (res.builtin_prompt) directPrompt = res.builtin_prompt;
      if (res.builtin_negative_prompt) negativePrompt = res.builtin_negative_prompt;
      if (res.default_width) width = res.default_width;
      if (res.default_height) height = res.default_height;
      forkSeed = res.seed;
      if (res.workflow_path && res.workflow_path !== 'fork') workflowPath = res.workflow_path;
      if (res.workflow_name) workflowName = res.workflow_name;
      else workflowName = workflowPath ? workflowPath.split('/').pop()?.replace(/\.(json|txt)$/, '') || '(fork)' : '(fork)';
      // Try to detect style from builtin_prompt or style_tags
      styleTags = '';
      styleName = '';
      let detectedStyle = '';
      if (res.style_tags) {
        detectedStyle = res.style_tags;
      } else if (res.builtin_prompt) {
        const firstTag = res.builtin_prompt.split(',')[0].trim();
        const cleaned = firstTag.replace(/^by\s+/i, '').replace(/^@/, '');
        if (cleaned !== firstTag) {
          const allStyles = await fetchStyles();
          const match = allStyles.styles.find(s => s.tags.toLowerCase() === cleaned.toLowerCase());
          if (match) detectedStyle = firstTag;
        }
      }
      if (detectedStyle) {
        styleTags = detectedStyle;
        styleName = detectedStyle;
        // Strip style tag from prompt to avoid duplication on submit
        const commaIdx = (res.builtin_prompt || '').indexOf(',');
        if (commaIdx >= 0) directPrompt = (res.builtin_prompt || '').slice(commaIdx + 1).trim();
      }
      localStorage.setItem('draw-fork-pending', JSON.stringify({ workflow_api: null, builtin_prompt: res.builtin_prompt || '', builtin_negative_prompt: res.builtin_negative_prompt || '', default_width: res.default_width || null, default_height: res.default_height || null, seed: res.seed, style_tags: res.style_tags || '', workflow_path: res.workflow_path || '', workflow_name: res.workflow_name || '' }));
      forumToast.add('success', 'Fork 成功', '');
      console.log('[FORK] success done');
    } catch (e: any) {
      console.log('[FORK] catch error:', e?.message);
      forumToast.add('error', 'Fork 失败', e?.message || '');
    }
  }
async function startGeneration(mode = 'wai') {
      if (queuing) return;
      if (!authToken) {
        forumToast.add('info', '未登录', '请先在论坛登录');
        return;
      }
      if (!workflowPath) {
        forumToast.add('error', '未选择工作流', '请选择工作流');
        }
        if (false) {
          forumToast.add('error', '人机验证', '请完成人机验证');
        return;
      }

      const finalDirectPrompt = directPrompt
        ? `${directPrompt}`
        : directPrompt;

      // Tag preset → fallback to 无Lora base workflow
      let finalWfPath = workflowPath;
      if (finalWfPath.endsWith('.txt')) {
        const subdir = mode === 'anima' ? 'ANIMA' : mode === 'ernie' ? 'Ernie' : 'WAI';
        finalWfPath = `${subdir}/通用/无Lora.json`;
      }

      // Pre-check: verify workflow exists on backend
      if (finalWfPath.endsWith('.json') && !finalWfPath.startsWith('tags/')) {
        try {
          await fetchWorkflowDetail(finalWfPath);
        } catch {
          queueError = '指定的工作流不存在，请重新选择工作流';
          return;
        }
      }

      queuing = true;
      try {
        await addToQueue({
          direct_prompt: finalDirectPrompt,
          width: width || undefined,
          height: height || undefined,
          style_tags: styleTags || undefined,
          negative_prompt: negativePrompt || undefined,
          seed: sameSeed ? forkSeed : undefined,
          workflow_path: finalWfPath,
          mode,
        turnstile_token: turnstileToken || undefined,
        });
        forumToast.add('success', '已加入队列', '等待生图中，前往"我的"页面查看详情。');
        turnstileTick++;
        loadMyQueue();
        if (!queueTimer) queueTimer = setInterval(loadMyQueue, 1000);
      } catch (e) {
        const msg = e instanceof Error ? e.message : '加入队列失败';
        const errMsg = msg.includes('404') || msg.includes('not found') || msg.includes('workflow') ? '指定的工作流不存在，请重新选择工作流' : msg;
        forumToast.add('error', '加入队列失败', errMsg);
      } finally {
        queuing = false;
      }
    }







  async function loadMyImages() {
    myImagesLoading = true;
    try {
      const baseUrl = get(drawEnv.baseUrl);
      const token = forumAuth.getToken();
      const resp = await fetch(baseUrl + '/api/draw/my-images?source=default&_t=' + Date.now(), {
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
      });
      if (resp.ok) {
        const data = await resp.json();
        const deduped = (data.items || []).filter((v: any, i: number, a: any[]) => a.findIndex((t: any) => t.path === v.path) === i);
        myImages = deduped;
        myImagesTotal = data.total || deduped.length;
      }
      myImagesLoaded = true;
      rebuildMyColumns();
    } catch {
      myImages = [];
    } finally {
      myImagesLoading = false;
    }
  }

  function rebuildMyColumns() {
    columnCount = getColumnCount();
    imgColumns = Array.from({ length: columnCount }, () => []);
    columnHeights = new Array(columnCount).fill(0);
    const display = displayImages.slice(0, myImagesDisplayLimit);
    for (const item of display) pushToShortest(item.path);
    imgColumns = [...imgColumns];
    hasMore = myImagesDisplayLimit < displayImages.length;
  }

  function showMoreMyImages() {
    myImagesDisplayLimit = Math.min(myImagesDisplayLimit + 10, displayImages.length);
    rebuildMyColumns();
  }

  async function loadMyQueue() {
    try {
      const res = await fetchMyQueue();
      const now = res.items;
      const showItems = now.filter(it => it.status === 'pending' || it.status === 'waiting' || it.status === 'running');
        const prevActive = new Set(showItems.map(it => it.id));
        const newlyDone = now.filter(it => (it.status === 'done' || it.status === 'failed') && !notifiedIds.has(it.id) && prevQueueIds.has(it.id));
        for (const item of newlyDone) {
          notifiedIds.add(item.id);
          if (item.status === 'done') {
            // 刷新我的图片
            myImagesLoaded = false;
            loadMyImages();
          }
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('生图完成' + (item.status === 'failed' ? '（失败）' : ''), {
              body: item.status === 'done' ? '你的图片已生成完成。' : (item.error || '生图失败'),
              icon: '/favicon.ico'
            });
          }
        }
        // Persist failed errors (skip dismissed), remove resolved ones
        let changed = false;
        for (const item of now) {
          const key = String(item.id);
          if (item.status === 'failed' && item.error && !dismissedErrors.has(key)) {
            if (!queueErrors[key]) {
              queueErrors = { ...queueErrors, [key]: item.error };
              changed = true;
            }
          }
          if (item.status === 'done' && queueErrors[key]) {
            const u = { ...queueErrors };
            delete u[key];
            queueErrors = u;
            changed = true;
          }
        }
        if (changed) saveQueueErrors();
        prevQueueIds = prevActive;
        const same = myQueueItems.length === showItems.length && myQueueItems.every((old, i) => old.id === showItems[i].id && old.status === showItems[i].status);
        if (!same) myQueueItems = showItems;
    } catch {
      myQueueItems = [];
    } finally {
      myQueueLoading = false;
    }
  }

  function getColumnCount(): number {
    if (typeof window === 'undefined') return 4;
    const w = window.innerWidth;
    if (w >= 1400) return 6;
    if (w >= 1024) return 5;
    if (w >= 768) return 4;
    if (w >= 480) return 3;
    return 2;
  }

    function formatTimeAgo(ts: number): string {
      const diff = Math.floor(Date.now() / 1000 - ts);
      if (diff < 60) return `${diff}秒前`;
      if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
      return `${Math.floor(diff / 3600)}小时前`;
    }

  async function loadWalletBalance() {
    if (!isLoggedIn) return;
    try {
      const r = await fetchWalletBalance();
      walletBalance = r.balance;
      if (walletTimer) return;
      walletTimer = setInterval(async () => {
        try {
          const r2 = await fetchWalletBalance();
          walletBalance = r2.balance;
        } catch {}
      }, 8000);
    } catch {}
  }

  async function handleRecharge(plan: { url: string; points: number }) {
    if (recharging || !plan.url) return;
    recharging = true;
    try {
      const r = await createWalletOrder(plan.url, plan.points);
      window.open(r.pay_url, '_blank');
      rechargeOpen = false;
    } catch { } finally { recharging = false; }
  }

  function pushToShortest(path: string) {
    // Skip if already in this column (defensive dedup)
    for (let c = 0; c < imgColumns.length; c++) {
      if (imgColumns[c].includes(path)) return;
    }
    let minIdx = 0;
    for (let i = 1; i < columnHeights.length; i++) {
      if (columnHeights[i] < columnHeights[minIdx]) minIdx = i;
    }
    imgColumns[minIdx] = [...imgColumns[minIdx], path];
    columnHeights[minIdx] += 1;
  }

  function rebuildColumns() {
    const flat: string[] = [];
    const idx = new Array(imgColumns.length).fill(0);
    while (true) {
      let added = false;
      for (let c = 0; c < imgColumns.length; c++) {
        if (idx[c] < imgColumns[c].length) {
          flat.push(imgColumns[c][idx[c]++]);
          added = true;
        }
      }
      if (!added) break;
    }
    columnCount = getColumnCount();
    imgColumns = Array.from({ length: columnCount }, () => []);
    columnHeights = new Array(columnCount).fill(0);
    for (const p of flat) pushToShortest(p);
    imgColumns = [...imgColumns];
  }

  function handleResize() {
    const old = columnCount;
    const nu = getColumnCount();
    if (nu === old) return;
    columnCount = nu;
    rebuildColumns();
  }

  function handleImgLoad(e: Event) {
    const img = e.currentTarget as HTMLImageElement;
    if (img.naturalWidth && img.naturalHeight) {
      img.style.aspectRatio = `${img.naturalWidth / img.naturalHeight}`;
    }
  }

  async function loadMyRecommendations() {
    try {
      const res = await fetchMyRecommendations();
      myRecommendations = res.items;
      myRecsLoaded = true;
    } catch {
      myRecommendations = [];
    }
  }

  function toggleSelect(path: string) {
    const s = new Set(selectedPaths);
    if (s.has(path)) s.delete(path);
    else s.add(path);
    selectedPaths = s;
  }

  onMount(() => {
    columnCount = getColumnCount();
    imgColumns = Array.from({ length: columnCount }, () => []);
    columnHeights = new Array(columnCount).fill(0);
    if (sentinelEl && !myImagesLoaded) {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting && !loadingMore && hasMore)) loadMoreMyImages();
        },
        { rootMargin: '400px 0px' }
      );
      io.observe(sentinelEl);
    }
    window.addEventListener('resize', handleResize, { passive: true });
    fetchAnnouncement().then(r => {
      if (r.announcement?.enabled && r.announcement.content) {
        announcementText = r.announcement.content;
        announcementTitle = r.announcement.title || '公告';
        announcementOpen = true;
      }
    }).catch(() => {});
  });

  onDestroy(() => {
    io?.disconnect();
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', handleResize);
    }
  });

    async function handleBatchDelete() {
    if (selectedPaths.size === 0) return;
    if (!confirm(`确定删除选中的 ${selectedPaths.size} 张图片？`)) return;
    try {
      await Promise.all(Array.from(selectedPaths).map(p => deleteMyImage(p)));
        myImages = myImages.filter(i => !selectedPaths.has(i.path));
      selectMode = false;
      selectedPaths = new Set();
    } catch (e) {
      forumToast.add('error', '批量删除失败', e instanceof Error ? e.message : '');
    }
  }


  let clearingAll = $state(false);

  async function handleClearAll() {
    if (!confirm('确定清空全部图片？此操作不可撤销。')) return;
    clearingAll = true;
    try {
      const res = await clearMyImages();
      forumToast.add('success', '清空成功', `已清空 ${res.deleted} 张图片`);
      myImagesLoaded = false;
      loadMyImages();
    } catch (e) {
      forumToast.add('error', '清空失败', e instanceof Error ? e.message : '');
    } finally {
      clearingAll = false;
    }
  }

  async function handleBatchRecommend() {
    if (selectedPaths.size === 0) return;
    if (!confirm(`确定自荐选中的 ${selectedPaths.size} 张图片？`)) return;
    try {
      await Promise.all(Array.from(selectedPaths).map(p => recommendImage(p)));
      forumToast.add('success', '自荐成功', '等待管理员审核');
      selectMode = false;
      selectedPaths = new Set();
      loadMyRecommendations();
    } catch (e) {
      forumToast.add('error', '批量自荐失败', e instanceof Error ? e.message : '');
    }
  }

  async function handleRecommend(path: string) {
    try {
      await recommendImage(path);
      forumToast.add('success', '自荐成功', '等待管理员审核');
      loadMyRecommendations();
    } catch (e) {
      forumToast.add('error', '自荐失败', e instanceof Error ? e.message : '');
    }
  }

  function recStatusBadge(status: string) {
    switch (status) {
      case 'pending': return '⏳ 待审核';
      case 'approved': return '✅ 已通过';
      case 'rejected': return '❌ 已拒绝';
      default: return status;
    }
  }
</script>

<svelte:head>
  <title>AI 生图 - {siteConfig.title}</title>
</svelte:head>

<div class="w-full max-w-4xl mx-auto px-2 sm:px-4 py-3 sm:py-6 space-y-4">
  <!-- Header -->
  <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
    <div class="flex items-center gap-x-2 gap-y-1 flex-wrap">
      <Icon icon="mdi:palette" class="size-6 text-primary" />
      <button class="text-xl font-bold hover:text-primary transition-colors" onclick={() => settingsOpen = true}>AI 生图</button>
      <a href="https://2x.nz/q" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 px-2.5 h-7 rounded-4xl text-xs font-bold no-underline shrink-0 text-white" style="background: linear-gradient(135deg, #ff0000, #ff7700, #ffff00, #00ff00, #0077ff, #8800ff, #ff00ff); background-size: 400% 400%; animation: rainbow 3s ease infinite;">
        加群
      </a>
      {#if onlineCount > 0}
        <Badge variant="secondary" class="text-xs">
          <Icon icon="mdi:account-multiple" class="size-3 mr-0.5" />
          {onlineCount}
        </Badge>
      {/if}
      {#if globalBusy}
        <Badge variant="default" class="text-xs animate-pulse">
          生成中
          {#if progressStage === '生成中' && progressMax > 0}
            ({progressValue}/{progressMax})
          {:else if progressStage}
            {progressStage}
          {/if}
        </Badge>
      {/if}
      {#if dsOutage}
        <Badge variant="destructive" class="text-xs" title="DeepSeek API 异常，LLM 翻译不可用">LLM 异常</Badge>
      {/if}
      {#if apiStatusValue === "checking"}
        <Badge variant="outline" class="text-xs text-muted-foreground">API 检测中</Badge>
      {:else if apiStatusValue === "offline"}
        <a href="https://2x.nz/q" target="_blank" rel="noopener noreferrer"><Badge variant="destructive" class="text-xs">API离线 - 加群反馈</Badge></a>
      {:else if apiStatusValue === "online"}
        <Badge variant="outline" class="text-xs text-green-500 border-green-500">API 在线</Badge>
      {/if}
      {#if isLoggedIn && walletBalance !== null}
        <button onclick={() => rechargeOpen = true} class="inline-flex items-center gap-0.5 px-2 h-6 rounded-4xl text-xs font-medium border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors shrink-0">
          ⚡{walletBalance}<span class="ml-1 text-[10px] opacity-70">点我充值</span>
        </button>
      {/if}
    </div>
  </div>

  <!-- Environment Switcher -->
  <!-- 设置弹窗 -->
  <Dialog.Root open={settingsOpen} onOpenChange={(o) => settingsOpen = o}>
    <Dialog.Content class="max-w-sm">
      <Dialog.Header>
        <Dialog.Title class="text-base">设置</Dialog.Title>
      </Dialog.Header>
      <EnvironmentSwitcher />
    </Dialog.Content>
  </Dialog.Root>

  <!-- Auth warning -->
  {#if !isLoggedIn}
    <Alert>
      <Icon icon="mdi:account-alert-outline" class="size-4" />
      <AlertDescription class="text-xs">
        请先<a href="/forum/auth/login?redirect=/draw/" class="underline font-medium">登录论坛</a>后使用生图功能。
      </AlertDescription>
    </Alert>
  {/if}

  {#if apiErrorMessage && (apiErrorMessage.includes('封禁') || apiErrorMessage.includes('BANNED'))}
    <div class="fixed inset-0 z-50 bg-red-600 flex items-center justify-center p-8">
      <div class="bg-white rounded-xl max-w-lg w-full p-8 text-center space-y-4 shadow-2xl">
        <Icon icon="mdi:account-cancel" class="size-16 mx-auto text-red-500" />
        <h1 class="text-2xl font-bold text-red-600">账号已被封禁</h1>
        <p class="text-base text-gray-700">{apiErrorMessage}</p>
      </div>
    </div>
  {/if}

  <!-- Tabs -->
  <Tabs bind:value={activeTab} class="w-full">
    <TabsList class="w-full">
      <TabsTrigger value="generate" class="flex-1">
        <Icon icon="mdi:sparkles" class="size-4 mr-1" />
        生成
      </TabsTrigger>
      <TabsTrigger value="mine" class="flex-1">
        <Icon icon="mdi:account-outline" class="size-4 mr-1" />
        我的
      </TabsTrigger>
      <TabsTrigger value="featured" class="flex-1">
        <Icon icon="mdi:star-outline" class="size-4 mr-1" />
        精选
      </TabsTrigger>
    </TabsList>

    <!-- Generate Tab -->
    <TabsContent value="generate" class="mt-4">
      <Tabs bind:value={genSubTab} class="w-full">
        <TabsList class="w-full flex flex-wrap gap-1 overflow-visible min-h-9 !h-auto">
          <TabsTrigger value="txt2img" class="flex-1">
            <Icon icon="mdi:sparkles" class="size-4 mr-1" />
            文生
            <button onclick={(e) => { e.stopPropagation(); txt2imgHelpOpen = true; }} class="inline-flex items-center justify-center size-4 rounded-full border border-muted-foreground/40 text-muted-foreground text-[10px] font-bold ml-1 hover:border-primary hover:text-primary transition-colors" title="文生图帮助">?</button>
          </TabsTrigger>
          <TabsTrigger value="img2img" class="flex-1">
            <Icon icon="mdi:image-edit-outline" class="size-4 mr-1" />
            图生
            <button onclick={(e) => { e.stopPropagation(); img2imgHelpOpen = true; }} class="inline-flex items-center justify-center size-4 rounded-full border border-muted-foreground/40 text-muted-foreground text-[10px] font-bold ml-1 hover:border-primary hover:text-primary transition-colors" title="图生图帮助">?</button>
          </TabsTrigger>
          <TabsTrigger value="video" class="flex-1">
            <Icon icon="mdi:video-vintage" class="size-4 mr-1" />
            动态壁纸
          </TabsTrigger>
          <TabsTrigger value="saloon" class="flex-1">
            <Icon icon="mdi:chat-outline" class="size-4 mr-1" />
            酒馆
            <button onclick={(e) => { e.stopPropagation(); saloonHelpOpen = true; }} class="inline-flex items-center justify-center size-4 rounded-full border border-muted-foreground/40 text-muted-foreground text-[10px] font-bold ml-1 hover:border-primary hover:text-primary transition-colors" title="关于酒馆">?</button>
          </TabsTrigger>
          <TabsTrigger value="tts" class="flex-1">
            <Icon icon="mdi:voice" class="size-4 mr-1" />
            TTS
          </TabsTrigger>
        </TabsList>

        <TabsContent value="txt2img" class="space-y-4 mt-4">
          <Tabs bind:value={genTxtSubTab} class="w-full">
            <TabsList class="w-full flex flex-wrap gap-1 overflow-visible min-h-9 !h-auto">
              <TabsTrigger value="wai" class="text-xs" onclick={() => { genTxtSubTab = 'wai'; workflowPath = ''; }}>WAI
                <button onclick={(e) => { e.stopPropagation(); waiHelpOpen = true; }} class="inline-flex items-center justify-center size-4 rounded-full border border-muted-foreground/40 text-muted-foreground text-[10px] font-bold ml-1 hover:border-primary hover:text-primary transition-colors" title="关于 WAI">?</button>
              </TabsTrigger>
              <TabsTrigger value="anima" class="text-xs" onclick={() => { genTxtSubTab = 'anima'; workflowPath = ''; }}>Anima
                <button onclick={(e) => { e.stopPropagation(); animaHelpOpen = true; }} class="inline-flex items-center justify-center size-4 rounded-full border border-muted-foreground/40 text-muted-foreground text-[10px] font-bold ml-1 hover:border-primary hover:text-primary transition-colors" title="关于 Anima">?</button>
              </TabsTrigger>
              <TabsTrigger value="ernie" class="text-xs" onclick={() => { genTxtSubTab = 'ernie'; workflowPath = ''; }}>Ernie
                <button onclick={(e) => { e.stopPropagation(); ernieHelpOpen = true; }} class="inline-flex items-center justify-center size-4 rounded-full border border-muted-foreground/40 text-muted-foreground text-[10px] font-bold ml-1 hover:border-primary hover:text-primary transition-colors" title="关于 Ernie">?</button>
              </TabsTrigger>
              <TabsTrigger value="real" class="text-xs" onclick={() => { genTxtSubTab = 'real'; workflowPath = 'ZImage/RedAIO.json'; directPrompt = ''; workflowPrompt = ''; negativePrompt = ''; workflowNegativePrompt = ''; nlPrompt = ''; }}>RedZI
                <button onclick={(e) => { e.stopPropagation(); realHelpOpen = true; }} class="inline-flex items-center justify-center size-4 rounded-full border border-muted-foreground/40 text-muted-foreground text-[10px] font-bold ml-1 hover:border-primary hover:text-primary transition-colors" title="关于 RedZI">?</button>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="wai" class="space-y-4 mt-4">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <WorkflowDialog bind:value={workflowPath} onselect={handleWorkflowSelect} onpromptload={handlePromptLoad} />
                <StyleDialog bind:value={styleTags} bind:name={styleName} onselect={handleStyleSelect} prefix="by " />
              </div>
              <PromptForm
                bind:turnstileToken bind:turnstileTick bind:directPrompt bind:negativePrompt bind:nlPrompt
                bind:workflowPrompt bind:workflowNegativePrompt bind:width bind:height
                onsubmit={() => startGeneration('wai')} disabled={queuing || !isLoggedIn} busy={queuing}
                bind:sameSeed bind:forkSeed
            llmTokenPerPoint={pointsConfig?.llm_token_per_point}
            pointsCostSubmit={pointsConfig?.text_to_image}
            turnstileEnabled={pointsConfig?.turnstile_enabled}
          />
        </TabsContent>

        <TabsContent value="anima" class="space-y-4 mt-4">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <WorkflowDialog bind:value={workflowPath} onselect={handleWorkflowSelect} onpromptload={handlePromptLoad} subdir="ANIMA" />
            <StyleDialog bind:value={styleTags} bind:name={styleName} onselect={handleStyleSelect} prefix="@" />
          </div>
          <PromptForm
            bind:turnstileToken bind:turnstileTick bind:directPrompt bind:negativePrompt bind:nlPrompt
            bind:workflowPrompt bind:workflowNegativePrompt bind:width bind:height
            onsubmit={() => startGeneration('anima')} disabled={queuing || !isLoggedIn} busy={queuing}
            bind:sameSeed bind:forkSeed
            llmTokenPerPoint={pointsConfig?.llm_token_per_point}
            pointsCostSubmit={pointsConfig?.text_to_image_anima}
            llmMode="anima"
            turnstileEnabled={pointsConfig?.turnstile_enabled}
          />
            </TabsContent>
            <TabsContent value="ernie" class="space-y-4 mt-4">
              <RealTab
                bind:turnstileToken bind:turnstileTick
                llmTokenPerPoint={pointsConfig?.llm_token_per_point}
                pointsCostSubmit={pointsConfig?.text_to_image_anima}
                turnstileEnabled={pointsConfig?.turnstile_enabled}
                workflowPath="Ernie/Ernie.json"
              />
            </TabsContent>
            <TabsContent value="real" class="space-y-4 mt-4">
              <RealTab
                bind:turnstileToken bind:turnstileTick
                llmTokenPerPoint={pointsConfig?.llm_token_per_point}
                pointsCostSubmit={pointsConfig?.text_to_image_real}
                turnstileEnabled={pointsConfig?.turnstile_enabled}
              />
            </TabsContent>
          </Tabs>


        </TabsContent>

        <TabsContent value="img2img" class="mt-4">
          <Tabs bind:value={imgSubTab} class="w-full">
            <TabsList class="w-full flex flex-wrap gap-1">
              <TabsTrigger value="flux2" class="text-xs">Flux2</TabsTrigger>
              <TabsTrigger value="qwen" class="text-xs">Qwen</TabsTrigger>
            </TabsList>
            <TabsContent value="flux2" class="mt-4">
              <Img2imgTab bind:turnstileToken bind:turnstileTick llmTokenPerPoint={pointsConfig?.llm_token_per_point} pointsCostSubmit={pointsConfig?.image_to_image} turnstileEnabled={pointsConfig?.turnstile_enabled} />
            </TabsContent>
            <TabsContent value="qwen" class="mt-4">
              <Img2imgTab bind:turnstileToken bind:turnstileTick llmTokenPerPoint={pointsConfig?.llm_token_per_point} pointsCostSubmit={pointsConfig?.image_to_image_qwen} turnstileEnabled={pointsConfig?.turnstile_enabled} maxImages={3} workflowPath="Qwen/qwen2511_lowvram.json" showConsistency={true} />
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="saloon" class="mt-4">
          <SaloonTab {workflowPath} {styleTags} {negativePrompt} {directPrompt} {width} {height} {turnstileToken} pointsCostSubmit={selectedMode === 'anima' ? (pointsConfig?.text_to_image_anima ) : (pointsConfig?.text_to_image )} mode={selectedMode} {ttsMode} {ttsSpeaker} {ttsInstruct} {ttsTags} />
        </TabsContent>
        <TabsContent value="tts" class="mt-4">
          <TtsTab bind:ttsMode bind:ttsSpeaker bind:ttsInstruct bind:ttsTargetText bind:ttsLanguage bind:ttsTags ttsPerChar={pointsConfig?.tts_per_char} ttsPerSec={pointsConfig?.tts_per_sec} ttsMin={pointsConfig?.tts_generate} />
        </TabsContent>
        <TabsContent value="video" class="mt-4">
          <VideoTab />
        </TabsContent>

      </Tabs>
    </TabsContent>

    <!-- My Images Tab -->
    <TabsContent value="mine" class="mt-4">
      {#if activeTab === 'mine'}
        <div>
        {#if !isLoggedIn}
          <Alert>
            <Icon icon="mdi:account-alert-outline" class="size-4" />
            <AlertDescription class="text-xs">请先<a href="/forum/auth/login?redirect=/draw/" class="underline font-medium">登录论坛</a>查看自己的图片。</AlertDescription>
          </Alert>
        {/if}
        {#if isLoggedIn}
          <div class="space-y-3">
            <div class="space-y-2">
              {#if myQueueLoading}
                <div class="text-xs text-muted-foreground py-3 text-center">加载中...</div>
              {:else if myQueueItems.length > 0}
                <div class="flex items-center justify-between">
                  <h3 class="text-sm font-medium flex items-center gap-1.5"><Icon icon="mdi:queue-play" class="size-4" />队列状态</h3>
                  <Button variant="ghost" size="sm" onclick={() => { myQueueLoading = true; loadMyQueue(); }}><Icon icon="mdi:refresh" class="size-4" /></Button>
                </div>
                <div class="space-y-1">
                  {#each myQueueItems as item}
                    <div class="flex items-center gap-2 text-xs border rounded-lg px-3 py-2 {item.status === 'failed' ? 'border-red-300 bg-red-50 dark:bg-red-950/30' : ''}">
                    {#if item.status === 'running'}
                      <Icon icon="mdi:loading" class="size-4 animate-spin text-primary" /><span class="flex-1">正在生图中</span>
                    {:else if item.status === 'done'}
                      <Icon icon="mdi:check-circle" class="size-4 text-green-500" /><span class="flex-1">生图完成</span>
                    {:else if item.status === 'failed'}
                      <Icon icon="mdi:alert-circle" class="size-4 text-red-500 shrink-0" />
                      <div class="flex-1 min-w-0 leading-tight">
                        <div class="font-medium text-red-600 dark:text-red-400">生图失败</div>
                        <div class="text-[10px] text-red-500/70 break-words">{item.error || '未知错误'}</div>
                      </div>
                    {:else if item.status === 'cancelled'}
                      <Icon icon="mdi:cancel" class="size-4 text-muted-foreground" /><span class="flex-1">已取消</span>
                    {:else}
                      <Icon icon="mdi:clock-outline" class="size-4 text-muted-foreground" /><span class="flex-1">等待中，前面还有 {item.position != null ? item.position - 1 : 0} 位</span>
                      <button class="text-red-500 hover:text-red-400 shrink-0" onclick={async () => { try { const baseUrl = get(drawEnv.baseUrl); await fetch(baseUrl + '/api/draw/my-queue/' + item.id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + forumAuth.getToken() } }); loadMyQueue(); forumToast.add('success', '已取消', ''); } catch { forumToast.add('error', '取消失败', ''); } }}>取消</button>
                    {/if}
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="text-xs text-muted-foreground py-3 text-center">暂无排队任务</div>
              {/if}
              {#each Object.entries(queueErrors).filter(([id]) => !dismissedErrors.has(id)) as [id, err]}
                <div class="flex items-start gap-2 text-xs border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800 rounded-lg px-3 py-2">
                  <Icon icon="mdi:alert-circle" class="size-4 text-red-500 shrink-0 mt-0.5" />
                  <div class="flex-1 min-w-0 leading-tight">
                    <div class="font-medium text-red-600 dark:text-red-400">#{id} 生图失败</div>
                    <div class="text-[10px] text-red-500/70 break-words">{err}</div>
                  </div>
                  <button onclick={() => dismissQueueError(Number(id))} class="size-5 flex items-center justify-center rounded text-muted-foreground hover:text-red-500 shrink-0" title="忽略"><Icon icon="mdi:close" class="size-3.5" /></button>
                </div>
              {/each}
            </div>
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <h3 class="text-sm font-medium flex items-center gap-1.5 shrink-0">
                <div class="flex items-center gap-0.5 border rounded-lg overflow-hidden text-xs">
                  <button class="px-2 py-1 transition-colors {imageCategory === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}" onclick={() => { imageCategory = 'all'; loadMyImages(); }}>默认</button>
                  <button class="px-2 py-1 transition-colors {imageCategory === 'saloon' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}" onclick={() => { imageCategory = 'saloon'; loadSaloonImages(); }}>酒馆</button>
                </div>
                <span class="text-xs text-muted-foreground whitespace-nowrap">({displayImages.length}/{displayTotal})</span>
              </h3>
              <div class="flex items-center gap-1 flex-wrap">
                <button onclick={() => { myImagesLoaded = false; loadMyImages(); }} class="size-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" title="刷新"><Icon icon="mdi:refresh" class="size-3.5" /></button>
                <Button variant={selectMode ? 'default' : 'outline'} size="sm" onclick={() => { selectMode = !selectMode; if (!selectMode) selectedPaths = new Set(); }}>
                  <Icon icon="mdi:checkbox-multiple-marked-outline" class="size-3.5 mr-1" />{selectMode ? '取消' : '选择'}
                </Button>
              <Button variant="outline" size="sm" onclick={() => { if (!myRecsLoaded) loadMyRecommendations(); myRecsOpen = true; }}>
                <Icon icon="mdi:history" class="size-3.5 mr-1" />自荐记录
              </Button>
              <Button variant="destructive" size="sm" onclick={handleClearAll} disabled={clearingAll}>
                <Icon icon="mdi:delete-sweep-outline" class="size-3.5 mr-1" />{clearingAll ? '清空中...' : '清空全部'}
              </Button>
                {#if selectedPaths.size > 0}
                  <Button variant="outline" size="sm" onclick={handleBatchRecommend} disabled={queuing}>
                    <Icon icon="mdi:star-plus-outline" class="size-3.5 mr-1" />自荐 ({selectedPaths.size})
                  </Button>
                  <Button variant="destructive" size="sm" onclick={handleBatchDelete} disabled={queuing}>
                    <Icon icon="mdi:delete-outline" class="size-3.5 mr-1" />删除 ({selectedPaths.size})
                  </Button>
                {/if}
              </div>
            </div>
            {#if displayLoading}
              <div class="text-xs text-muted-foreground py-8 text-center">加载中...</div>
            {:else if displayImages.length === 0}
              <div class="text-xs text-muted-foreground py-8 text-center">{imageCategory === 'all' ? '你还没有生成过内容' : '暂无酒馆生成的内容'}</div>
            {:else}
              <div class="flex gap-1 sm:gap-2 items-start">
                {#each imgColumns as col, ci (ci)}
                  <div class="flex flex-1 flex-col gap-2 min-w-0">
                    {#each col as path, i (ci + '-' + i + '-' + path)}
                      {@const item = displayImages.find(i => i.path === path)}
                      {#if item}
                        <div role="button" tabindex="0" class="group relative rounded-md overflow-hidden border hover:ring-2 hover:ring-primary/50 transition-all cursor-pointer {selectedPaths.has(item.path) ? 'ring-2 ring-primary' : ''}"
                          onclick={() => { if (selectMode) toggleSelect(item.path); else if (item.path.endsWith('.wav') || item.path.endsWith('.flac')) {} else { myLbIndex = displayImages.indexOf(item); myLbOpen = true; } }}>
                          {#if item.path.endsWith('.mp4') || item.path.endsWith('.webm')}
                            <video src={getImageProxyUrl(item.path)} loop autoplay muted playsinline class="block w-full h-auto bg-muted" style="aspect-ratio: 1;" />
                          {:else if item.path.endsWith('.wav') || item.path.endsWith('.flac')}
                            <div class="bg-muted" style="aspect-ratio: 1;">
                              <div class="flex items-center justify-center h-full p-2" onclick={(e) => { e.stopPropagation(); }}>
                                <audio src={getImageUrl(item.path)} controls class="w-full max-w-full" preload="none"></audio>
                              </div>
                              <button onclick={async (e) => { e.stopPropagation(); if (expandedAudioId === item.path) { expandedAudioId = null; return; } expandedAudioId = item.path; if (!audioMeta[item.path]) { try { const m = await fetchOutputMeta(item.path); audioMeta = { ...audioMeta, [item.path]: m }; } catch {} } }} class="w-full text-[10px] text-muted-foreground hover:text-foreground py-1 text-center border-t border-border/50 transition-colors">
                                {expandedAudioId === item.path ? '收起原文' : '查看原文'}
                              </button>
                              {#if expandedAudioId === item.path}
                                <div class="text-[10px] text-muted-foreground px-2 pb-2 leading-relaxed border-t border-border/50 pt-1.5" onclick={(e) => e.stopPropagation()}>
                                  {#if audioMeta[item.path]?.prompt}
                                    <div class="line-clamp-3">{audioMeta[item.path].prompt}</div>
                                    <div class="flex gap-2 mt-1 flex-wrap">
                                      {#if audioMeta[item.path]?.workflow_path}
                                        {@const ttsTypeLabels = { preset: '预设音色', design: '自定义音色', custom: '自定义音色', clone: '声音克隆' }}
                                        {@const ttsType = (audioMeta[item.path].workflow_path || '').split('/').pop() || ''}
                                        <span class="text-primary/60 font-medium">{ttsTypeLabels[ttsType] || ttsType}</span>
                                      {/if}
                                      {#if audioMeta[item.path]?.speaker}<span class="text-primary/60">音色: {audioMeta[item.path].speaker}</span>{/if}
                                      {#if audioMeta[item.path]?.language}<span class="text-primary/60">语言: {audioMeta[item.path].language}</span>{/if}
                                    </div>
                                  {:else}
                                    <span class="italic">加载中...</span>
                                  {/if}
                                </div>
                              {/if}
                            </div>
                          {:else}
                            <img src={getImageProxyUrl(item.path)} alt={item.path} loading="lazy" decoding="async" style="aspect-ratio: 1;" onload={handleImgLoad} class="block w-full h-auto bg-muted" />
                          {/if}
                          {#if selectMode}
                            <div class="absolute top-1 left-1 flex items-center justify-center" onclick={(e) => e.stopPropagation()}>
                              <input type="checkbox" checked={selectedPaths.has(item.path)} onchange={() => toggleSelect(item.path)} class="size-4 accent-primary" />
                            </div>
                          {/if}
                          <button onclick={(e) => { e.stopPropagation(); if (confirm('确定删除这张图片？')) deleteMyImage(item.path).then(() => { myImagesLoaded = false; loadMyImages(); }); }} class="absolute top-1 right-1 size-6 flex items-center justify-center rounded-full bg-black/50 text-white text-xs opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity hover:bg-red-500/80" title="删除">
                            <Icon icon="mdi:close" class="size-3.5" />
                          </button>
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/each}
              </div>
              {#if hasMore}
                <div class="flex justify-center pt-2">
                  <Button variant="outline" size="sm" onclick={showMoreMyImages}>加载更多（{displayImages.length - myImagesDisplayLimit} 张）</Button>
                </div>
              {/if}
            {/if}

          </div>
        {/if}
        </div>
      {/if}
    </TabsContent>

    <!-- Featured Tab -->
    <TabsContent value="featured" class="mt-4">
      {#if activeTab === 'featured'}
        {#if !isLoggedIn}
          <Alert>
            <Icon icon="mdi:account-alert-outline" class="size-4" />
            <AlertDescription class="text-xs">
              请先<a href="/forum/auth/login?redirect=/draw/" class="underline font-medium">登录论坛</a>查看精选图片。
            </AlertDescription>
          </Alert>
        {:else}
          <FeaturedTab onFork={handleFork} />
        {/if}
      {/if}
    </TabsContent>

    </Tabs>
<ImageLightbox
  open={myLbOpen}
  images={myLbImages}
  index={myLbIndex}
  onclose={() => (myLbOpen = false)}
  onfork={handleFork}
  onrecommend={handleRecommend}
/>
</div>

<Dialog.Root open={rechargeOpen} onOpenChange={(o) => rechargeOpen = o}>
  <Dialog.Content class="max-w-sm w-[calc(100%-2rem)] sm:w-full">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <Icon icon="mdi:wallet-plus-outline" class="size-5" />
        充值
      </Dialog.Title>
    </Dialog.Header>
    <div class="space-y-2 px-6 pb-4">
      {#if plans.length === 0}
        <div class="text-xs text-muted-foreground py-4 text-center">暂无充值方案</div>
      {:else}
        {#each plans as plan}
          <button onclick={() => handleRecharge(plan)} disabled={recharging} class="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10 transition-colors disabled:opacity-50">
            <div class="text-left">
              <div class="text-sm font-medium">{plan.name}</div>
              <div class="text-xs text-muted-foreground">⚡{plan.points} 点数</div>
            </div>
            <span class="text-sm font-medium text-amber-600 dark:text-amber-400">{recharging ? '处理中...' : '立即充值 →'}</span>
          </button>
        {/each}
      {/if}
      <div class="text-[10px] text-muted-foreground text-center pt-1">适度娱乐，理性消费</div>
    </div>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={announcementOpen} onOpenChange={(o) => { if (!o) { announcementOpen = false; try { sessionStorage.setItem('draw-announcement-dismissed', '1'); } catch {} } }}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>📢 {announcementTitle}</Dialog.Title>
      <Dialog.Description class="text-sm leading-relaxed">
        {@html announcementText.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-primary underline">$1</a>')}
      </Dialog.Description>
    </Dialog.Header>
  </Dialog.Content>
</Dialog.Root>

<style>
  @keyframes rainbow {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }

  /* 全局 flex 防溢出 */
  .flex-1 { min-width: 0; }
  .flex-wrap { overflow-wrap: break-word; }


</style>

<Dialog.Root open={myRecsOpen} onOpenChange={(o) => myRecsOpen = o}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <Icon icon="mdi:star-plus-outline" class="size-5" />
        我的自荐
      </Dialog.Title>
    </Dialog.Header>
    <div class="max-h-96 overflow-y-auto space-y-2 px-6 pb-4">
      {#if !myRecsLoaded}
        <div class="text-xs text-muted-foreground py-4 text-center">加载中...</div>
      {:else if myRecommendations.length === 0}
        <div class="text-xs text-muted-foreground py-4 text-center">暂无自荐记录</div>
      {:else}
        {#each myRecommendations as rec}
          <div class="border rounded-lg p-3 space-y-1">
            <div class="flex items-center gap-2 text-xs">
              <img src={getImageProxyUrl(rec.image_path)} alt="" class="size-10 rounded object-cover border shrink-0" />
              <span class="truncate flex-1">{rec.image_path}</span>
              <Badge variant={rec.status === "approved" ? "default" : rec.status === "rejected" ? "destructive" : "secondary"} class="text-[10px] shrink-0">
                {recStatusBadge(rec.status)}
              </Badge>
            </div>
            {#if rec.user_reason}
              <div class="text-[10px] text-muted-foreground">理由: {rec.user_reason}</div>
            {/if}
            {#if rec.admin_reason}
              <div class="text-[10px] text-muted-foreground">管理员: {rec.admin_reason}</div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>


<Dialog.Root open={waiHelpOpen} onOpenChange={(o) => waiHelpOpen = o}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>ℹ️ 关于 WAI</Dialog.Title>
      <Dialog.Description class="text-sm leading-relaxed">
        <div class="space-y-2">
          <div>动漫文生图模型，使用英文 Tag（Danbooru 格式）</div>
          <div>角色库：<a href="https://www.downloadmost.com/NoobAI-XL/danbooru-character/" target="_blank" rel="noopener noreferrer" class="text-primary underline">www.downloadmost.com/NoobAI-XL/danbooru-character/</a></div>
          <div>画风库：<a href="https://www.downloadmost.com/NoobAI-XL/danbooru-artist/" target="_blank" rel="noopener noreferrer" class="text-primary underline">www.downloadmost.com/NoobAI-XL/danbooru-artist/</a></div>
          <div>画风标签以 by 开头，角色标签直接写</div>
          <div>不支持中文自然语言</div>
        </div>
      </Dialog.Description>
    </Dialog.Header>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={animaHelpOpen} onOpenChange={(o) => animaHelpOpen = o}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>ℹ️ 关于 Anima</Dialog.Title>
      <Dialog.Description class="text-sm leading-relaxed">
        <div class="space-y-2">
          <div>动漫文生图模型</div>
          <div>支持英文 Tag 和英文自然语言</div>
          <div>画风标签以 @ 开头</div>
          <div>角色库/画风库与 WAI 通用。链接见WAI的?</div>
          <div>内置 Turbo 加速 LoRA，出图更快</div>
        </div>
      </Dialog.Description>
    </Dialog.Header>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={realHelpOpen} onOpenChange={(o) => realHelpOpen = o}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>ℹ️ 关于 RedZI</Dialog.Title>
      <Dialog.Description class="text-sm leading-relaxed">
        <div class="space-y-2">
          <div>写实/半写实风格，基于 Flux 架构</div>
          <div>支持中文自然语言，但英文遵从度可能更好</div>
          <div>无需选择工作流和画风</div>
        </div>
      </Dialog.Description>
    </Dialog.Header>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={txt2imgHelpOpen} onOpenChange={(o) => txt2imgHelpOpen = o}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>🎨 文生图</Dialog.Title>
      <Dialog.Description class="text-sm leading-relaxed">
        <div class="space-y-2">
          <div><strong>基本用法：</strong></div>
          <ol class="list-decimal pl-4 space-y-1">
            <li>选择工作流（无Lora 通用，或角色Lora专用）</li>
            <li>选择画风（可选，推荐）</li>
            <li>在「自然语言描述」用中文写下你想画什么，点「转换」，LLM 会自动翻译成英文 Tag</li>
            <li>点击「开始生成」</li>
          </ol>
          <div>也可以直接在「正向提示词」手写英文 Tag。</div>
          <div><strong>角色库</strong>：Danbooru 角色库（英文搜索）</div>
          <div><strong>画风库</strong>：Danbooru 画师库（by xxx 格式）</div>
          <div class="text-muted-foreground text-xs">💡 翻译功能基于内置 LLM，也可以用 DeepSeek、豆包、ChatGPT 等外部 AI 来生成 Tag。</div>
        </div>
      </Dialog.Description>
    </Dialog.Header>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={img2imgHelpOpen} onOpenChange={(o) => img2imgHelpOpen = o}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>🖼️ 图生图</Dialog.Title>
      <Dialog.Description class="text-sm leading-relaxed">
        <div class="space-y-2">
          <div>上传图片，描述你想让它变成的样子。</div>
          <div><strong>用法：</strong></div>
          <ol class="list-decimal pl-4 space-y-1">
            <li>上传一张原图</li>
            <li>用中文描述你想修改的内容，点「转换」</li>
            <li>点击「开始生成」</li>
          </ol>
          <div>支持中文描述，但<strong>英文描述的遵从度更高</strong>。</div>
          <div class="text-muted-foreground text-xs">💡 翻译功能基于内置 LLM，也可以用 DeepSeek、豆包、ChatGPT 等外部 AI 来生成 Tag。</div>
        </div>
      </Dialog.Description>
    </Dialog.Header>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={ernieHelpOpen} onOpenChange={(o) => ernieHelpOpen = o}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>ℹ️ 关于 Ernie</Dialog.Title>
      <Dialog.Description class="text-sm leading-relaxed">
        <div class="space-y-2">
          <div>写实/半写实风格，支持在图中生成文字</div>
          <div>不会画手，网红脸，挺不赖的</div>
          <div>支持中文自然语言，但英文遵从度可能更好</div>
        </div>
      </Dialog.Description>
    </Dialog.Header>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={saloonHelpOpen} onOpenChange={(o) => saloonHelpOpen = o}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>🍺 酒馆（Beta）</Dialog.Title>
      <Dialog.Description class="text-sm leading-relaxed">
        <div class="space-y-2">
          <div><strong>酒馆</strong>是一个角色扮演聊天功能，AI 会扮演你设定的角色与你对话。</div>
          <div><strong>生图开关</strong>：开启后，AI 会在对话中自动生图（消耗生图点数）。关闭后为纯文字聊天。</div>
          <div><strong>使用步骤：</strong></div>
          <ol class="list-decimal pl-4 space-y-1">
            <li>在「角色设定」中填写角色名和 System Prompt</li>
            <li>在「文生图」页选择好工作流、画风、分辨率</li>
            <li>开始聊天，AI 会以角色身份回复并自动生图</li>
          </ol>
          <div class="bg-muted p-2 rounded text-xs"><strong>💡 提示：</strong>正面提示词建议只保留角色名称 tag（如 <code>1girl, hu_tao_(genshin_impact)</code>），去掉服饰、动作等具体描绘。因为 AI 生成的生图 tags 会拼接到正面提示词后面，角色外 tag 过多会导致图片遵从度降低。</div>
          <div><strong>计费</strong>：聊天按 LLM token 消耗点数，生图按次扣费。</div>
          <div class="text-muted-foreground text-xs">⚠️ 测试功能，不代表最终质量。如遇 Bug 请 <a href="https://2x.nz/q" target="_blank" rel="noopener noreferrer" class="text-primary underline">加群</a> 讨论。</div>
        </div>
      </Dialog.Description>
    </Dialog.Header>
  </Dialog.Content>
</Dialog.Root>
