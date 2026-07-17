<script lang="ts">
  import Icon from '@iconify/svelte';
  import { siteConfig } from '$lib/config/site';
  import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
  import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '$lib/components/ui/card';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import { Switch } from '$lib/components/ui/switch';
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
  import * as Table from '$lib/components/ui/table';
  import { forumAuth } from '$lib/forum/stores/auth';
  import { drawEnv, resolveApiRedirect } from '$lib/draw/stores/env';
  import { get } from 'svelte/store';
  import * as admin from '$lib/draw/api/admin';
  import * as loraApi from '$lib/draw/api/lora';
  import PieChart from '$lib/components/draw/PieChart.svelte';
  import { getImageProxyUrl, getImageUrl, getThumbnailUrl, forkOutputImage, clearQueue, fetchDebugInfo } from '$lib/draw/api/client';
  import { pendingFork } from '$lib/draw/stores/fork';
import { forumToast } from '$lib/forum/stores/toast';
import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
import ImageLightbox from '$lib/components/draw/ImageLightbox.svelte';
import StatsTab from '$lib/components/draw/StatsTab.svelte';
  import type {
    AdminRecentImage,
    AdminLimits,
    AdminAnnouncement,
    AdminLlmConfig,
    DrawRecommendation
  } from '$lib/draw/types';

  let authToken = $state<string | null>(null);
  let currentBaseUrl = $state('');
  let activeTab = $state(location.hash?.slice(1) || 'announcement');

  $effect(() => {
    const handler = () => {
      const h = location.hash?.slice(1);
      if (h) activeTab = h;
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  });

  let prevTab = $state('');
  $effect(() => {
    if (activeTab && activeTab !== prevTab) {
      prevTab = activeTab;
      history.replaceState(null, '', '#' + activeTab);
    }
  });
  let loading = $state(false);
  let clearing = $state(false);
  let message = $state<{ type: 'success' | 'error'; text: string } | null>(null);


  // Announcement
  let announcement = $state<AdminAnnouncement>({ enabled: false, title: '', content: '' });

  // Recent images
  let recentImages = $state<AdminRecentImage[]>([]);
  let recentTotal = $state(0);
  let recentOffset = $state(0);
  let recentLimit = $state(50);
  let selectedPaths = $state<Set<string>>(new Set());
    let selectMode = $state(false);
  let searchUserId = $state('');
// Masonry layout
let columnCount = $state(4);
let imgColumns = $state<string[][]>([[], [], [], []]);
let columnHeights: number[] = [0, 0, 0, 0];
let sentinelEl = $state<HTMLDivElement | undefined>(undefined);
let io: IntersectionObserver | null = null;
let hasMore = $state(true);
let loadingMore = $state(false);

  // Recommendations
  let recommendations = $state<DrawRecommendation[]>([]);
  let recSelectMode = $state(false);
  let recSelected = $state(new Set<string>());

  function toggleRecSelect(id: string) {
    const s = new Set(recSelected);
    if (s.has(id)) s.delete(id); else s.add(id);
    recSelected = s;
  }

  async function batchResolveRecs(action: 'approve' | 'reject') {
    if (recSelected.size === 0) return;
    loading = true;
    try {
      const ids = [...recSelected];
      await admin.resolveRecommendations(ids, action);
      recommendations = recommendations.filter(r => !recSelected.has(r.id));
      recSelected = new Set();
      showMsg('success', `已${action === 'approve' ? '通过' : '拒绝'} ${ids.length} 个`);
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '操作失败');
    } finally {
      loading = false;
    }
  }

  // Featured
  let featuredPaths = $state<string[]>([]);
  let newFeaturedPath = $state('');
  let featColumns = $state<string[][]>([]);
  let featHeights: number[] = [];
  let featSelectMode = $state(false);
  let featSelectedPaths = $state<Set<string>>(new Set());

  // Banned
  let bannedUsers = $state<admin.BanEntry[]>([]);
  let newBanUserId = $state('');
  let newBanDays = $state(7);
  let newBanReason = $state('');

  // Collaborators
  let collaborators = $state<{ user_id: number; added_by: number; added_at: number }[]>([]);
  let newCollaboratorId = $state('');
  let pendingNominations = $state<Nomination[]>([]);
  let nomMasonryItems = $derived(pendingNominations.flatMap((n: Nomination) => n.image_paths.map((p: string) => ({ path: p, nomination: n }))));
  let nomImgColumns = $state<string[][]>([]);
  let nomImgHeights: number[] = [];
  let nomRejectReasons = $state<Record<string, string>>({});

  function fmtBanDate(ts: number): string {
    const d = new Date((ts || 0) * 1000);
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // Credits / Wallet
  let wallets = $state<Array<{ user_id: number; balance: number; total_purchased: number; _edit?: number }>>([]);
  let adminPlans = $state<Array<{ id: string; name: string; points: number; url: string }>>([]);
  let storageItems = $state<Array<{ user_id: number; img_files: number; img_size: number; vid_files: number; vid_size: number; aud_files: number; aud_size: number }>>([]);
  let storageTotal = $state(0);
  let storageLoading = $state(false);

  async function loadStorage() {
    storageLoading = true;
    try { const r = await admin.fetchStorage(); storageItems = r.items; storageTotal = r.total_size; } catch { storageItems = []; storageTotal = 0; }
    finally { storageLoading = false; }
  }

  function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }
  let searchUid = $state('');
  let searchedWallet = $state<{ user_id: number; balance: number; total_purchased: number; _edit?: number } | null>(null);
  let ttsRecords = $state<Array<{ id: number; user_id: number; text: string; refText: string | null; xVectorMode: boolean; language: string; audioDuration: number; cost: number; outputPath: string | null; created_at: number; finished_at: number }>>([]);
  let ttsRecordsLoading = $state(false);

  async function loadTtsRecords() {
    ttsRecordsLoading = true;
    try { ttsRecords = (await admin.fetchTtsRecords()).items; } catch { ttsRecords = []; }
    finally { ttsRecordsLoading = false; }
  }

  function searchUidByWallet() {
    const uid = Number(searchUid);
    if (!uid) { searchedWallet = null; return; }
    const found = wallets.find(w => w.user_id === uid);
    if (found) searchedWallet = { ...found, _edit: found.balance };
    else searchedWallet = null;
  }
  let pointsCfg = $state<{ text_to_image: number; image_to_image: number; text_to_video: number; llm_translate: number; llm_token_per_point: number; signup_bonus: number; text_to_image_anima: number; text_to_image_real: number; text_to_image_ernie: number; image_to_image_qwen: number; tts_generate: number; tts_per_char: number; tts_per_sec: number }>({ text_to_image: 10, image_to_image: 100, text_to_video: 600, llm_translate: 1, llm_token_per_point: 1000, signup_bonus: 0, text_to_image_anima: 20, text_to_image_real: 15, text_to_image_ernie: 15, image_to_image_qwen: 20, tts_generate: 5, tts_per_char: 0.01, tts_per_sec: 0.033 });
  const MODEL_CFG = [
    { key: 'text_to_image', label: 'WAI' },
    { key: 'text_to_image_anima', label: 'Anima' },
    { key: 'text_to_image_ernie', label: 'Ernie' },
    { key: 'text_to_image_real', label: 'RedZI' },
    { key: 'image_to_image', label: 'Flux2' },
    { key: 'image_to_image_qwen', label: 'Qwen' },
    { key: 'text_to_video', label: '视频' },
  ];
  let givePointsValue = $state(0);
  let givePointsTarget = $state('');
  let givePointsUid = $state(0);

  async function handleGivePoints() {
    if (!givePointsValue || givePointsValue <= 0) return;
    const userId = givePointsTarget === 'uid' ? givePointsUid : null;
    const r = await admin.givePoints(userId, givePointsValue);
    alert(`已赠送 ${r.count} 个用户`);
    givePointsValue = 0;
    loadCredits();
  }

  async function loadCredits() {
    try {
      const [wr, pr] = await Promise.all([admin.getWallets(), admin.getPlans()]);
      wallets = wr.items.map(w => ({ ...w, _edit: w.balance }));
      adminPlans = pr.items;
    } catch {}
    try {
      const baseUrl = get(drawEnv.baseUrl);
      const r = await fetch(baseUrl + '/api/wallet/points-config').then(res => res.json());
      if (r.text_to_image != null) pointsCfg = r;
    } catch {}
  }

  // Limits
  let limits = $state<AdminLimits | null>(null);
  let defaults = $state<AdminLimits | null>(null);

  // LLM Config
  let llmConfig = $state<AdminLlmConfig | null>(null);
    let llmProviders = $state<string[]>([]);
    let llmTestResult = $state<{ ok: boolean; provider: string; profile_index?: number; reply?: string; error?: string; raw?: string } | null>(null);
  let llmTesting = $state(false);
    let llmModels = $state<string[] | null>(null);
    let llmModelsLoading = $state(false);
    let llmActiveTab = $state(0);

  const thinkingLabels: Record<string, string> = {
    off: '关闭',
    level_minimal: 'minimal',
    level_low: 'low',
    level_medium: 'medium',
    level_high: 'high',
  };

  const thinkingGroups: Array<{ label: string; options: string[] }> = [
    { label: '关闭', options: ['off'] },
    { label: 'Level (Gemini 3 系列)', options: ['level_minimal', 'level_low', 'level_medium', 'level_high'] },
  ];

  // Lora approval
  let loraPending = $state<import('$lib/draw/types').LoraApplication[]>([]);
  let loraLoading = $state(false);
  let loraApprovingId = $state<string | null>(null);
  let loraRejectingId = $state<string | null>(null);

  async function loadLoraPending() {
    loraLoading = true;
    try {
      const res = await loraApi.getPendingLoraSubmissions();
      loraPending = res.items;
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    } finally {
      loraLoading = false;
    }
  }

  async function handleApproveLora(id: string) {
    loraApprovingId = id;
    try {
      await loraApi.approveLora(id);
      showMsg('success', '已通过并创建 Lora 工作流');
      loadLoraPending();
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '操作失败');
    } finally {
      loraApprovingId = null;
    }
  }

  async function handleRejectLora(id: string) {
    if (!confirm('确定拒绝该 Lora 申请？')) return;
    loraRejectingId = id;
    try {
      await loraApi.rejectLora(id);
      showMsg('success', '已拒绝');
      loadLoraPending();
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '操作失败');
    } finally {
      loraRejectingId = null;
    }
  }

  // GC
  let gcResult = $state<Record<string, number> | null>(null);
  let debugData = $state<any>(null);
  let debugLoading = $state(false);
  let debugError = $state('');



  // Image Lightbox
  let lbOpen = $state(false);
  let lbImages = $state<{ src: string; creator_id?: string; cached?: string }[]>([]);
  let recMasonryEl = $state<HTMLDivElement | undefined>(undefined);
  let recDialogItem = $state<any>(null);
  let recDialogId = $derived(recDialogItem?.id ?? '');

  // Image detail popup
  let detailImg = $state<AdminRecentImage | null>(null);
  let detailImgSrc = $derived(detailImg ? getImageProxyUrl(detailImg.path) : '');

  function openRecDialog(rec: any, i: number) {
    recDialogItem = rec;
  }
  function closeRecDialog() {
    recDialogItem = null;
  }

  function openLb(path: string) {
    lbImages = [{ src: getImageUrl(path), creator_id: '', cached: getImageProxyUrl(path) }];
    lbOpen = true;
  }

  async function handleAdminFork(path: string) {
    try {
      const res = await forkOutputImage(path);
      pendingFork.set({
        workflow: res.workflow,
        builtin_prompt: res.builtin_prompt,
        builtin_negative_prompt: res.builtin_negative_prompt,
        default_width: res.default_width,
        default_height: res.default_height,
        seed: res.seed,
        style_tags: res.style_tags,
        workflow_api: res.workflow_api || null,
        workflow_path: res.workflow_path || '',
        workflow_name: res.workflow_name || '',
        matched_workflow: res.matched_workflow
      });
      showMsg('success', 'Fork 成功，请切换至生图页面');
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : 'Fork 失败');
    }
  }

let recMasonry: any = null;
$effect(() => {
    if (recMasonryEl && recommendations.length > 0) {
      const el = recMasonryEl;
      setTimeout(() => {
        import('masonry-layout').then(m => {
          if (recMasonry) recMasonry.destroy();
          recMasonry = new m.default(el, {
            itemSelector: '.rec-item',
            columnWidth: '.rec-sizer',
            percentPosition: true,
          });
          const imgs = el.querySelectorAll('img');
          let loaded = 0, total = imgs.length;
          if (total === 0) return;
          for (const img of imgs) {
            if (img.complete) { loaded++; if (loaded === total) recMasonry.layout(); }
            else img.addEventListener('load', () => { loaded++; if (loaded === total) recMasonry.layout(); });
          }
        });
      }, 50);
    }
  });

  $effect(() => {
    authToken = forumAuth.getToken();
    const u = drawEnv.baseUrl.subscribe((v) => (currentBaseUrl = v));
    return u;
  });

  $effect(() => {
    resolveApiRedirect();
  });

  function showMsg(type: 'success' | 'error', text: string) {
    message = { type, text };
    setTimeout(() => (message = null), 3000);
  }

  async function loadAnnouncement() {
    try {
      const res = await admin.getAnnouncement();
      announcement = res.announcement;
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    }
  }

  async function saveAnnouncement() {
    loading = true;
    try {
      const res = await admin.updateAnnouncement(announcement);
      announcement = res.announcement;
      showMsg('success', '公告已更新');
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '保存失败');
    } finally {
      loading = false;
    }
  }

  async function loadRecent() {
    if (loadingMore) return;
    loading = true;
    try {
      loadingMore = true;
      const res = await admin.getRecentImages(recentLimit, 0);
      const deduped = res.items.filter((v, i, a) => a.findIndex(t => t.path === v.path) === i);
      recentImages = deduped;
      recentTotal = res.total;
      recentOffset = res.items.length;
      loadingMore = false;
      selectedPaths = new Set();
      columnCount = getColumnCount();
      imgColumns = Array.from({ length: columnCount }, () => []);
      columnHeights = new Array(columnCount).fill(0);
      for (const item of deduped) pushToShortest(item.path);
      imgColumns = [...imgColumns];
      hasMore = recentOffset < recentTotal;
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    } finally {
      loading = false;
    }
  }

  async function loadMoreRecent() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    try {
      const res = await admin.getRecentImages(recentLimit, recentOffset);
      const moreDeduped = res.items.filter((v, i, a) => a.findIndex(t => t.path === v.path) === i && !recentImages.some(ex => ex.path === v.path));
      recentImages = [...recentImages, ...moreDeduped];
      recentOffset += res.items.length;
      for (const item of moreDeduped) pushToShortest(item.path);
      imgColumns = [...imgColumns];
      hasMore = recentOffset < recentTotal;
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    } finally {
      loadingMore = false;
    }
  }

  async function searchByUser() {
    if (!String(searchUserId).trim()) return;
    loading = true;
    try {
      const res = await admin.getImagesByUser(Number(searchUserId));
      const deduped = res.items.filter((v, i, a) => a.findIndex(t => t.path === v.path) === i);
      recentImages = deduped;
      recentTotal = res.total;
      recentOffset = deduped.length;
      hasMore = false;
      selectedPaths = new Set();
      columnCount = getColumnCount();
      imgColumns = Array.from({ length: columnCount }, () => []);
      columnHeights = new Array(columnCount).fill(0);
      for (const item of deduped) pushToShortest(item.path);
      imgColumns = [...imgColumns];
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '查询失败');
    } finally {
      loading = false;
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

  function pushToShortest(path: string) {
    let minIdx = 0;
    for (let i = 1; i < columnHeights.length; i++) {
      if (columnHeights[i] < columnHeights[minIdx]) minIdx = i;
    }
    imgColumns[minIdx] = [...imgColumns[minIdx], path];
    columnHeights[minIdx] += 1;
  }

  function rebuildColumns() {
    const flat: string[] = [];
    while (true) {
      let added = false;
      for (let c = 0; c < imgColumns.length; c++) {
        if (flat.length < recentImages.length) {
          for (let j = c; j < recentImages.length; j += imgColumns.length) {
            flat.push(recentImages[j].path); break;
          }
          added = true;
          break;
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

  function rebuildFeatColumns() {
    const cc = getColumnCount();
    featColumns = Array.from({ length: cc }, () => []);
    featHeights = new Array(cc).fill(0);
    for (const p of featuredPaths) {
      let minIdx = 0;
      for (let i = 1; i < featHeights.length; i++) {
        if (featHeights[i] < featHeights[minIdx]) minIdx = i;
      }
      featColumns[minIdx] = [...featColumns[minIdx], p];
      featHeights[minIdx] += 1;
    }
  }

  function rebuildNomImgColumns() {
    const cc = getColumnCount();
    nomImgColumns = Array.from({ length: cc }, () => []);
    nomImgHeights = new Array(cc).fill(0);
    for (const item of nomMasonryItems) {
      let minIdx = 0;
      for (let i = 1; i < nomImgHeights.length; i++) {
        if (nomImgHeights[i] < nomImgHeights[minIdx]) minIdx = i;
      }
      nomImgColumns[minIdx] = [...nomImgColumns[minIdx], item.path];
      nomImgHeights[minIdx] += 1;
    }
  }

  function handleImgLoad(e: Event) {
    const img = e.currentTarget as HTMLImageElement;
    if (img.naturalWidth && img.naturalHeight) {
      img.style.aspectRatio = `${img.naturalWidth / img.naturalHeight}`;
    }
  }

  async function handleDeleteSelected() {
    const paths = [...selectedPaths];
    if (!paths.length) return;
    if (!confirm(`确认删除 ${paths.length} 张图片？`)) return;
    loading = true;
    try {
      const res = await admin.deleteImages(paths);
      showMsg('success', `已删除 ${res.deleted} 张，失败 ${res.failed} 张`);
      await loadRecent();
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '删除失败');
    } finally {
      loading = false;
    }
  }

  async function handleDeleteOne(path: string) {
    if (!confirm(`确认删除 ${path}？`)) return;
    loading = true;
    try {
      await admin.deleteImage(path);
      showMsg('success', '已删除');
      recentImages = recentImages.filter((i) => i.path !== path);
      selectedPaths.delete(path);
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '删除失败');
    } finally {
      loading = false;
    }
  }

  async function handleAddSelectedToFeatured() {
    const paths = [...selectedPaths];
    if (!paths.length) return;
    if (loading) return;
    loading = true;
    try {
      await Promise.all(paths.map((p) => admin.addFeatured(p)));
      showMsg('success', `已将 ${paths.length} 张图片加入精选`);
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '操作失败');
    } finally {
      loading = false;
    }
  }

  function toggleSelect(path: string) {
    const next = new Set(selectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    selectedPaths = next;
  }

  function toggleSelectAll() {
    if (selectedPaths.size === recentImages.length) {
      selectedPaths = new Set();
    } else {
      selectedPaths = new Set(recentImages.map((i) => i.path));
    }
  }

  async function loadRecommendations() {
    loading = true;
    try {
      const res = await admin.fetchRecommendations();
      recommendations = res.items;
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    } finally {
      loading = false;
    }
  }

  async function resolveRec(recId: string, action: 'approve' | 'reject', imagePath?: string) {
    loading = true;
    try {
      await admin.resolveRecommendation(recId, action, undefined, imagePath);
      showMsg('success', action === 'approve' ? '已通过' : '已拒绝');
      recommendations = recommendations.filter((r) => r.id !== recId);
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '处理失败');
    } finally {
      loading = false;
    }
  }

  async function loadFeatured() {
    try {
      const res = await admin.getFeatured();
      featuredPaths = res.items;
      rebuildFeatColumns();
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    }
  }

  async function handleAddFeatured() {
    if (!newFeaturedPath.trim()) return;
    loading = true;
    try {
      const res = await admin.addFeatured(newFeaturedPath.trim());
      featuredPaths = res.items;
      newFeaturedPath = '';
      showMsg('success', '已添加到精选');
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '添加失败');
    } finally {
      loading = false;
    }
  }

  async function handleRemoveFeatured(path: string) {
    if (!confirm(`确定要移除精选图片？\n${path}`)) return;
    loading = true;
    try {
      const res = await admin.removeFeatured(path);
      featuredPaths = res.items;
      showMsg('success', '已移除');
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '移除失败');
    } finally {
      loading = false;
    }
  }

  function featToggleSelect(path: string) {
    const next = new Set(featSelectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    featSelectedPaths = next;
  }

  async function handleBatchRemoveFeatured() {
    const paths = [...featSelectedPaths];
    if (!paths.length) return;
    if (loading) return;
    if (!confirm(`确定移除选中的 ${paths.length} 张精选图片？`)) return;
    loading = true;
    try {
      for (const p of paths) {
        await admin.removeFeatured(p);
      }
      const res = await admin.getFeatured();
      featuredPaths = res.items;
      rebuildFeatColumns();
      featSelectedPaths = new Set();
      featSelectMode = false;
      showMsg('success', `已移除 ${paths.length} 张精选图片`);
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '操作失败');
    } finally {
      loading = false;
    }
  }

  async function loadBanned() {
    try {
      const res = await admin.getBannedUsers();
      bannedUsers = Array.isArray(res.banned) ? res.banned.filter((b: any) => typeof b === 'object') : [];
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    }
  }

  async function handleBan() {
    if (!newBanUserId) return;
    loading = true;
    try {
      const res = await admin.banUser(Number(newBanUserId), newBanDays || 7, newBanReason || '违规行为');
      bannedUsers = Array.isArray(res.banned) ? res.banned.filter((b: any) => typeof b === 'object') : [];
      newBanUserId = '';
      showMsg('success', '已封禁');
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '封禁失败');
    } finally {
      loading = false;
    }
  }

  async function handleUnban(userId: number) {
    loading = true;
    try {
      const res = await admin.unbanUser(userId);
      bannedUsers = Array.isArray(res.banned) ? res.banned.filter((b: any) => typeof b === 'object') : [];
      showMsg('success', '已解封');
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '解封失败');
    } finally {
      loading = false;
    }
  }

  async function loadCollaboratorsTab() {
    try {
      const [c, n] = await Promise.all([
        admin.getCollaborators(),
        admin.getPendingNominations()
      ]);
      collaborators = c.collaborators;
      pendingNominations = n.items;
      rebuildNomImgColumns();
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    }
  }

  async function handleAddCollaborator() {
    if (!newCollaboratorId) return;
    loading = true;
    try {
      const res = await admin.addCollaborator(Number(newCollaboratorId));
      collaborators = res.collaborators;
      newCollaboratorId = '';
      showMsg('success', '已添加');
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '添加失败');
    } finally {
      loading = false;
    }
  }

  async function handleRemoveCollaborator(userId: number) {
    if (!confirm(`确定移除协作者 ${userId}？`)) return;
    loading = true;
    try {
      const res = await admin.removeCollaborator(userId);
      collaborators = res.collaborators;
      showMsg('success', '已移除');
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '移除失败');
    } finally {
      loading = false;
    }
  }

  async function handleNominationResolve(id: string, action: 'approve' | 'reject') {
    loading = true;
    try {
      const reason = nomRejectReasons[id] || '';
      await admin.resolveNomination(id, action, reason);
      delete nomRejectReasons[id];
      pendingNominations = pendingNominations.filter(n => n.id !== id);
      rebuildNomImgColumns();
      showMsg('success', action === 'approve' ? '已批准，图片已加入精选' : '已拒绝');
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '操作失败');
    } finally {
      loading = false;
    }
  }

  async function loadLimits() {
    try {
      const res = await admin.getLimits();
      limits = res.limits;
      defaults = res.defaults;
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    }
  }

  async function saveLimits() {
    if (!limits) return;
    loading = true;
    try {
      const res = await admin.updateLimits(limits);
      limits = res.limits;
      showMsg('success', '配置已保存');
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '保存失败');
    } finally {
      loading = false;
    }
  }

  async function handleClearQueue() {
    clearing = true;
    try {
      await clearQueue();
      showMsg('success', '已清空队列');
      if (typeof loadDebug === 'function') loadDebug();
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '清空队列失败');
    } finally {
      clearing = false;
    }
  }

  async function loadLlmConfig() {
    try {
      const res = await admin.getLlmConfig();
      llmConfig = res.config;
      llmProviders = res.providers;
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '加载失败');
    }
  }

  async function saveLlmConfig() {
    if (!llmConfig) return;
    loading = true;
    try {
      const res = await admin.updateLlmConfig({ profiles: llmConfig.profiles, active: llmConfig.active });
      if (res.config) llmConfig = res.config;
      showMsg('success', 'LLM 配置已保存');
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '保存失败');
    } finally {
      loading = false;
    }
  }

  async function testLlmConfig() {
    llmTesting = true;
    llmTestResult = null;
    try {
      llmTestResult = await admin.testLlmConfig(llmActiveTab);
    } catch (e) {
      llmTestResult = { ok: false, provider: '', error: e instanceof Error ? e.message : '测试失败' };
    } finally {
      llmTesting = false;
    }
  }

  async function loadLlmModels() {
    llmModelsLoading = true;
    llmModels = null;
    try {
      const res = await admin.getLlmModels(llmActiveTab);
      llmModels = res.models || null;
    } catch (e) {
      llmModels = [];
      showMsg('error', e instanceof Error ? e.message : '探测失败');
    } finally {
      llmModelsLoading = false;
    }
  }

  async function handleGc() {
    loading = true;
    try {
      const res = await admin.runGc();
      gcResult = res.cleaned;
      showMsg('success', 'GC 完成');
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : 'GC 失败');
    } finally {
      loading = false;
    }
  }

  async function loadDebug() {
    debugLoading = true;
    debugError = '';
    try {
      debugData = await fetchDebugInfo();
    } catch (e) {
      debugError = e instanceof Error ? e.message : '加载失败';
    } finally {
      debugLoading = false;
    }
  }

  // Tab change triggers data loading
  $effect(() => {
    const tab = activeTab;
    if (!authToken) return;
    switch (tab) {
      case 'announcement':
        loadAnnouncement();
        break;
      case 'images':
        if (recentImages.length === 0) loadRecent();
        break;
      case 'recommendations':
        loadRecommendations();
        break;
      case 'featured':
        loadFeatured();
        break;
      case 'banned':
        loadBanned();
        break;
      case 'collaborators':
        loadCollaboratorsTab();
        break;
      case 'credits':
        loadCredits();
        break;
      case 'limits':
        loadLimits();
        break;
    }
  });

  // IntersectionObserver sentinelEl 可用时才创建（切到图片 tab 后）
  $effect(() => {
    const el = sentinelEl;
    if (!el) return;
    io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting && !loadingMore && hasMore)) loadMoreRecent();
      },
      { rootMargin: '400px 0px' }
    );
    io.observe(el);
    return () => io?.disconnect();
  });

  onMount(() => {
  columnCount = getColumnCount();
  imgColumns = Array.from({ length: columnCount }, () => []);
  columnHeights = new Array(columnCount).fill(0);
  window.addEventListener('resize', handleResize, { passive: true });
  return () => {
    io?.disconnect();
    window.removeEventListener('resize', handleResize);
  };
  });

function formatTime(ts: number) {
    return new Date(ts * 1000).toLocaleString('zh-CN');
  }

  let debugInterval: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    if (activeTab !== 'llm') {
      llmModels = null;
    }
    if (activeTab === 'storage') {
      loadStorage();
    }
    if (activeTab === 'debug') {
      loadDebug();
      debugInterval = setInterval(loadDebug, 2000);
    } else {
      if (debugInterval) {
        clearInterval(debugInterval);
        debugInterval = null;
      }
    }
    return () => {
      if (debugInterval) {
        clearInterval(debugInterval);
        debugInterval = null;
      }
    };
  });
</script>

<svelte:head>
  <title>生图管理 - {siteConfig.title}</title>
</svelte:head>

<div class="w-full max-w-5xl mx-auto px-4 py-6 space-y-4">
  <div class="flex items-center gap-2">
    <a href="/draw" class="text-muted-foreground hover:text-foreground">
      <Icon icon="mdi:arrow-left" class="size-5" />
    </a>
    <Icon icon="mdi:shield-crown-outline" class="size-6 text-primary" />
    <h1 class="text-xl font-bold">生图管理</h1>
  </div>

  {#if !authToken}
    <Alert>
      <Icon icon="mdi:account-alert-outline" class="size-4" />
      <AlertDescription class="text-xs">
        请先<a href="/forum/auth/login" class="underline font-medium">登录论坛</a>（需要管理员账号）。
      </AlertDescription>
    </Alert>
      {/if}
    {#if authToken}
      {#if message}
      <Alert variant={message.type === 'error' ? 'destructive' : 'default'}>
        <AlertDescription class="text-xs">{message.text}</AlertDescription>
      </Alert>
    {/if}

    <Tabs bind:value={activeTab} class="w-full">
      <TabsList class="w-full flex flex-wrap gap-1 overflow-visible min-h-9 !h-auto">
        <TabsTrigger value="announcement" class="text-xs">
          <Icon icon="mdi:bullhorn-outline" class="size-3.5 mr-1" />公告
        </TabsTrigger>
        <TabsTrigger value="images" class="text-xs">
          <Icon icon="mdi:image-multiple-outline" class="size-3.5 mr-1" />图片
        </TabsTrigger>
        <TabsTrigger value="recommendations" class="text-xs">
          <Icon icon="mdi:star-plus-outline" class="size-3.5 mr-1" />自荐
        </TabsTrigger>
        <TabsTrigger value="featured" class="text-xs">
          <Icon icon="mdi:star-outline" class="size-3.5 mr-1" />精选
        </TabsTrigger>
        <TabsTrigger value="banned" class="text-xs">
          <Icon icon="mdi:account-cancel-outline" class="size-3.5 mr-1" />封禁
          </TabsTrigger>
          <TabsTrigger value="collaborators" class="text-xs">
            <Icon icon="mdi:account-group-outline" class="size-3.5 mr-1" />协作者
        </TabsTrigger>
        <TabsTrigger value="credits" class="text-xs">
          <Icon icon="mdi:wallet-outline" class="size-3.5 mr-1" />额度
        </TabsTrigger>
        <TabsTrigger value="tts-records" class="text-xs">
          <Icon icon="mdi:voice" class="size-3.5 mr-1" />TTS
        </TabsTrigger>
        <TabsTrigger value="limits" class="text-xs">
          <Icon icon="mdi:tune-vertical" class="size-3.5 mr-1" />配置
        </TabsTrigger>
        <TabsTrigger value="llm" class="text-xs">
          <Icon icon="mdi:brain" class="size-3.5 mr-1" />LLM
        </TabsTrigger>
        <TabsTrigger value="gc" class="text-xs">
          <Icon icon="mdi:broom" class="size-3.5 mr-1" />GC
        </TabsTrigger>
        <TabsTrigger value="debug" class="text-xs">
          <Icon icon="mdi:bug-outline" class="size-3.5 mr-1" />调试
        </TabsTrigger>
        <TabsTrigger value="stats" class="text-xs">
          <Icon icon="mdi:chart-box-outline" class="size-3.5 mr-1" />统计
        </TabsTrigger>
        <TabsTrigger value="storage" class="text-xs">
          <Icon icon="mdi:harddisk" class="size-3.5 mr-1" />存储
        </TabsTrigger>
        <TabsTrigger value="lora-approval" class="text-xs">
          <Icon icon="mdi:shape-plus-outline" class="size-3.5 mr-1" />Lora审批
        </TabsTrigger>

      </TabsList>


      <!-- Announcement -->
      <TabsContent value="announcement" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base flex items-center gap-2">
              公告管理
              {#if announcement.enabled}
                <Badge>已开启</Badge>
                              <Badge variant="secondary">已关闭</Badge>
              {/if}
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="flex items-center gap-3">
              <Switch bind:checked={announcement.enabled} />
              <Label>{announcement.enabled ? '开启' : '关闭'}</Label>
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">标题</Label>
              <Input bind:value={announcement.title} placeholder="公告标题" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">内容</Label>
              <textarea
                bind:value={announcement.content}
                rows={4}
                placeholder="公告内容..."
                class="w-full rounded-md border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
              ></textarea>
            </div>
            <Button onclick={saveAnnouncement} disabled={loading}>
              <Icon icon="mdi:content-save" class="size-4 mr-1" />
              保存
            </Button>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- Images -->
      <TabsContent value="images" class="mt-4 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">图片管理</CardTitle>
            <CardDescription>共 {recentTotal} 张图片</CardDescription>
          </CardHeader>
          <CardContent class="space-y-2 sm:space-y-3 p-3 sm:p-6">
            <div class="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onclick={loadRecent} disabled={loading}>
                <Icon icon="mdi:refresh" class="size-4 mr-1" />刷新
              </Button>
            </div>
            <div class="flex gap-2">
              <Input
                bind:value={searchUserId}
                placeholder="按用户 ID 查询"
                class="max-w-48"
                type="number"
              />
              <Button variant="outline" size="sm" onclick={searchByUser} disabled={loading}>查询</Button>
            </div>
          </CardContent>
        </Card>
        <div class="sticky top-10 z-10 bg-background py-2 flex flex-wrap gap-2 items-center border-b">
              <Button variant={selectMode ? 'default' : 'outline'} size="sm" onclick={() => { selectMode = !selectMode; if (!selectMode) selectedPaths = new Set(); }}>
                <Icon icon="mdi:select" class="size-4 mr-1" />
                {selectMode ? '取消选择' : '选择'}
              </Button>
              {#if selectedPaths.size > 0}
                <Button variant="default" size="sm" onclick={handleAddSelectedToFeatured} disabled={loading}>
                  <Icon icon="mdi:star" class="size-4 mr-1" />
                  加入精选 ({selectedPaths.size})
                </Button>
                <Button variant="destructive" size="sm" onclick={handleDeleteSelected} disabled={loading}>
                  <Icon icon="mdi:delete" class="size-4 mr-1" />
                  删除选中 ({selectedPaths.size})
                </Button>
              {/if}
            </div>
          {#if recentImages.length > 0}
          <div class="flex gap-1 sm:gap-2 items-start">
            {#each imgColumns as col, ci (ci)}
              <div class="flex flex-1 flex-col gap-2 min-w-0">
                {#each col as path, i (ci + '-' + i + '-' + path)}
                  {@const img = recentImages.find(i => i.path === path)}
                  {#if img}
                    <div class="relative group">
                      <button
                        class="w-full rounded-md overflow-hidden border {selectedPaths.has(img.path) ? 'ring-2 ring-primary' : ''}"
                        onclick={() => { if (selectMode) toggleSelect(img.path); else openLb(img.path); }}
                      >
                        <div class="relative">
                          <img
                            src={getImageProxyUrl(img.path)}
                            alt={img.path}
                            loading="lazy"
                            decoding="async"
                            style="aspect-ratio: 1;"
                            onload={handleImgLoad}
                            class="block w-full h-auto bg-muted {img.deleted ? 'opacity-50' : ''}"
                          />
                          {#if img.deleted}
                            <div class="absolute inset-0 pointer-events-none">
                              <svg viewBox="0 0 100 100" class="w-full h-full">
                                <line x1="5" y1="95" x2="95" y2="5" stroke="rgba(220,38,38,0.7)" stroke-width="6" stroke-linecap="round" />
                              </svg>
                            </div>
                          {/if}
                        </div>
                      </button>
                      {#if selectMode}
                    <div class="absolute top-1 left-1 flex gap-1 items-start">
                      <input
                        type="checkbox"
                        checked={selectedPaths.has(img.path)}
                        onchange={() => toggleSelect(img.path)}
                        onclick={(e) => e.stopPropagation()}
                        class="size-4 accent-primary opacity-60 group-hover:opacity-100 transition-opacity"
                      />
                    </div>
                  {/if}

                      <div class="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          class="p-0.5 rounded bg-destructive/80 text-white hover:bg-destructive"
                          onclick={(e) => { e.stopPropagation(); handleDeleteOne(img.path); }}
                          title="删除"
                        >
                          <Icon icon="mdi:delete" class="size-3.5" />
                        </button>
                      </div>
                      <div class="absolute bottom-0 inset-x-0 flex">
                        <div class="flex-1 bg-black/60 text-white text-[10px] px-1 py-0.5 truncate pointer-events-none">
                          UID {img.user_id || '?'} | {formatTime(img.mtime)}{#if img.deleted} - <span class="text-red-400 font-bold">已删</span>{/if}
                        </div>
                        <button
                          class="bg-black/70 text-white text-[10px] px-1.5 py-0.5 hover:bg-black/90"
                          onclick={(e) => { e.stopPropagation(); detailImg = img; }}
                        >
                          详情
                        </button>
                      </div>
                    </div>
                  {/if}
                {/each}
              </div>
            {/each}
          </div>
          {#if !hasMore && recentImages.length > 0}
            <div class="text-center text-xs text-muted-foreground py-2">已加载全部</div>
          {/if}
          <div bind:this={sentinelEl} class="h-4"></div>
        {/if}
      </TabsContent>

      {#if detailImg}
        <div class="fixed inset-0 z-40 bg-black/40 flex items-center justify-center" onclick={() => detailImg = null} role="dialog">
          <div class="bg-card rounded-lg border shadow-xl max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto" onclick={(e) => e.stopPropagation()}>
            <div class="flex items-center justify-between p-3 border-b">
              <h3 class="text-sm font-medium truncate">{detailImg.path}</h3>
              <button class="text-muted-foreground hover:text-foreground" onclick={() => detailImg = null}>
                <Icon icon="mdi:close" class="size-5" />
              </button>
            </div>
            <div class="p-3 space-y-3 text-xs">
              <div class="grid grid-cols-3 gap-2">
                <div>
                  <p class="text-[10px] text-muted-foreground mb-1">原图 1</p>
                  {#if detailImg.image1}
                    <img src="{currentBaseUrl}/api/uploads/{detailImg.image1}" alt="原图1" class="rounded border max-h-48 w-auto h-auto" loading="lazy" />
                  {/if}
                </div>
                <div>
                  <p class="text-[10px] text-muted-foreground mb-1">原图 2</p>
                  {#if detailImg.image2}
                    <img src="{currentBaseUrl}/api/uploads/{detailImg.image2}" alt="原图2" class="rounded border max-h-48 w-auto h-auto" loading="lazy" />
                  {/if}
                </div>
                <div>
                  <p class="text-[10px] text-muted-foreground mb-1">结果图</p>
                  <img src={getImageProxyUrl(detailImg.path)} alt="结果" class="rounded border max-h-48 w-auto h-auto" loading="lazy" />
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <div><span class="text-muted-foreground">生图者：</span>{detailImg.user_id || '?'}</div>
                <div><span class="text-muted-foreground">时间：</span>{detailImg.mtime ? new Date(detailImg.mtime * 1000).toLocaleString() : '-'}</div>
              </div>
              {#if detailImg.prompt}
                <div>
                  <span class="text-muted-foreground">正向 Prompt：</span>
                  <div class="mt-0.5 p-2 bg-muted rounded text-[11px] break-all">{detailImg.prompt}</div>
                </div>
              {/if}
              {#if detailImg.negative_prompt}
                <div>
                  <span class="text-muted-foreground">反向 Prompt：</span>
                  <div class="mt-0.5 p-2 bg-muted rounded text-[11px] break-all">{detailImg.negative_prompt}</div>
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/if}

      <!-- Recommendations -->
            <TabsContent value="recommendations" class="mt-4">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-medium flex items-center gap-1.5">
            <Icon icon="mdi:star-plus-outline" class="size-4" />
            自荐审核
            {#if recommendations.length > 0}
              <Badge variant="secondary">{recommendations.length}</Badge>
            {/if}
          </h3>
          <div class="flex items-center gap-1">
            <Button variant={recSelectMode ? 'default' : 'outline'} size="sm" onclick={() => { recSelectMode = !recSelectMode; if (!recSelectMode) recSelected = new Set(); }}>
              <Icon icon="mdi:checkbox-multiple-marked-outline" class="size-3.5 mr-1" />{recSelectMode ? '取消' : '选择'}
            </Button>
            <Button variant="ghost" size="sm" onclick={loadRecommendations} disabled={loading}>
              <Icon icon="mdi:refresh" class="size-4" />
            </Button>
          </div>
        </div>
        {#if recSelectMode}
          <div class="flex flex-wrap items-center gap-2 mb-3 p-2 rounded-lg border bg-muted/30">
            <span class="text-xs text-muted-foreground">已选 {recSelected.size} 个</span>
            <Button size="sm" variant="outline" onclick={() => {
              if (recSelected.size === recommendations.length) recSelected = new Set();
              else recSelected = new Set(recommendations.map(r => r.id));
            }}>{recSelected.size === recommendations.length ? '取消全选' : '全选'}</Button>
            <Button size="sm" variant="default" onclick={() => batchResolveRecs('approve')} disabled={loading || recSelected.size === 0}>通过选中</Button>
            <Button size="sm" variant="destructive" onclick={() => batchResolveRecs('reject')} disabled={loading || recSelected.size === 0}>拒绝选中</Button>
          </div>
        {/if}
        {#if recommendations.length === 0}
          <div class="text-sm text-muted-foreground py-8 text-center">无待审核自荐</div>
          {:else}
            <div bind:this={recMasonryEl} class="relative w-full overflow-hidden">
            <div class="rec-sizer w-1/2 md:w-1/3 lg:w-1/4 xl:w-1/5"></div>
            {#each recommendations as rec, i (rec.id || i)}
              <div class="rec-item w-1/2 md:w-1/3 lg:w-1/4 xl:w-1/5 p-1">
                <div class="relative group rounded-lg overflow-hidden border hover:ring-2 hover:ring-primary/50 transition-all cursor-pointer {recSelected.has(rec.id) ? 'ring-2 ring-primary' : ''}"
                  role="button" tabindex="0"
                  onclick={() => { if (recSelectMode) toggleRecSelect(rec.id); else openRecDialog(rec, i); }}
                >
                  <img src={getImageProxyUrl(rec.image_path)} alt="" loading="lazy" decoding="async" class="block w-full h-auto bg-muted" />
                  {#if recSelectMode}
                    <div class="absolute top-1 left-1 flex items-center justify-center" onclick={(e) => { e.stopPropagation(); toggleRecSelect(rec.id); }}>
                      <input type="checkbox" checked={recSelected.has(rec.id)} onchange={() => toggleRecSelect(rec.id)} class="size-4 accent-primary" />
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Approve/reject dialog -->
        {#if recDialogItem}
          <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/90" onclick={closeRecDialog} role="dialog">
            <div class="relative flex flex-col items-center w-[95vw] sm:max-w-[90vw] max-h-[90vh]" onclick={(e) => e.stopPropagation()}>
              <button class="absolute top-2 right-2 z-10 text-white/80 hover:text-white" onclick={closeRecDialog}>
                <Icon icon="mdi:close" class="size-8" />
              </button>
              <img src={getImageProxyUrl(recDialogItem.image_path)} alt="" class="max-w-full max-h-[60vh] sm:max-h-[75vh] object-contain rounded-lg" />
              <div class="flex flex-wrap items-center gap-2 mt-3 bg-background/80 backdrop-blur rounded-lg px-3 py-2 w-full sm:w-auto">
                <div class="text-xs text-muted-foreground truncate max-w-[120px] sm:max-w-[200px] shrink-0">
                  UID: {recDialogItem.user_id ?? '?'}
                </div>
                <Button size="sm" variant="default" onclick={() => { resolveRec(recDialogItem.id, 'approve', recDialogItem.image_path); closeRecDialog(); }} disabled={loading} class="shrink-0">
                  通过
                </Button>
                <Button size="sm" variant="destructive" onclick={() => { resolveRec(recDialogItem.id, 'reject', recDialogItem.image_path); closeRecDialog(); }} disabled={loading} class="shrink-0">
                  拒绝
                </Button>
              </div>
            </div>
          </div>
        {/if}
      </TabsContent><TabsContent value="featured" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">精选管理</CardTitle>
          </CardHeader>
          <CardContent class="space-y-2 sm:space-y-3 p-3 sm:p-6">
            <div class="flex gap-2">
              <Input
                bind:value={newFeaturedPath}
                placeholder="输入图片相对路径"
                class="flex-1"
              />
              <Button size="sm" onclick={handleAddFeatured} disabled={loading}>
                <Icon icon="mdi:plus" class="size-4 mr-1" />添加
              </Button>
            </div>
            <div class="flex gap-2">
              <Button variant="outline" size="sm" onclick={loadFeatured} disabled={loading}>
                <Icon icon="mdi:refresh" class="size-4 mr-1" />刷新
              </Button>
              <Button variant={featSelectMode ? 'default' : 'outline'} size="sm" onclick={() => { featSelectMode = !featSelectMode; if (!featSelectMode) featSelectedPaths = new Set(); }}>
                <Icon icon="mdi:select" class="size-4 mr-1" />
                {featSelectMode ? '取消选择' : '选择'}
              </Button>
              {#if featSelectedPaths.size > 0}
                <Button variant="destructive" size="sm" onclick={handleBatchRemoveFeatured} disabled={loading}>
                  <Icon icon="mdi:close" class="size-4 mr-1" />
                  取消精选 ({featSelectedPaths.size})
                </Button>
              {/if}
            </div>
            {#if featuredPaths.length === 0}
              <div class="text-sm text-muted-foreground py-4 text-center">无精选图片</div>
            {:else}
              <div class="flex gap-1 sm:gap-2 items-start">
                {#each featColumns as col, ci (ci)}
                  <div class="flex flex-1 flex-col gap-2 min-w-0">
                    {#each col as path, i (ci + '-' + i + '-' + path)}
                      <div class="relative group rounded-md overflow-hidden border cursor-pointer {featSelectMode && featSelectedPaths.has(path) ? 'ring-2 ring-primary' : ''}" role="button" tabindex="0" onclick={() => { if (featSelectMode) featToggleSelect(path); else openLb(path); }}>
                        <img src={getImageProxyUrl(path)} alt={path} loading="lazy" decoding="async" style="aspect-ratio: 1;" onload={handleImgLoad} class="block w-full h-auto bg-muted" />
                        {#if featSelectMode}
                          <div class="absolute top-1 left-1 flex items-center justify-center" onclick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={featSelectedPaths.has(path)} onchange={() => featToggleSelect(path)} class="size-4 accent-primary" />
                          </div>
                        {/if}
                        <button
                          class="absolute top-1 right-1 p-0.5 rounded bg-destructive/80 text-white hover:bg-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                          onclick={() => handleRemoveFeatured(path)}
                          title="移除"
                        >
                          <Icon icon="mdi:close" class="size-3.5" />
                        </button>
                      </div>
                    {/each}
                  </div>
                {/each}
              </div>
            {/if}
          </CardContent>
        </Card>
      </TabsContent>

      <!-- Banned -->
      <TabsContent value="banned" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">封禁管理</CardTitle>
          </CardHeader>
          <CardContent class="space-y-2 sm:space-y-3 p-3 sm:p-6">
            <div class="flex gap-2">
              <Input
                bind:value={newBanUserId}
                placeholder="用户 ID"
                type="number"
                  class="max-w-20"
                />
                <Input bind:value={newBanDays} type="number" class="max-w-16" min="1" />
                <span class="text-xs text-muted-foreground">天</span>
                <Input bind:value={newBanReason} placeholder="原因" class="max-w-36" />
                <Button size="sm" variant="destructive" onclick={handleBan} disabled={loading}>
                  <Icon icon="mdi:account-cancel" class="size-4 mr-1" />封禁
                </Button>
            </div>
            <Button variant="outline" size="sm" onclick={loadBanned} disabled={loading}>
              <Icon icon="mdi:refresh" class="size-4 mr-1" />刷新
            </Button>
            {#if bannedUsers.length === 0}
              <div class="text-sm text-muted-foreground py-4 text-center">无封禁用户</div>
            {:else}
              <div class="space-y-1.5">
                {#each bannedUsers as ban}
                  <div class="flex items-center justify-between border rounded-md px-3 py-2">
                    <span class="text-sm font-mono">{ban.user_id} - ({fmtBanDate(ban.banned_at)} - {fmtBanDate(ban.banned_until)})</span>
                    <Button size="sm" variant="ghost" onclick={() => handleUnban(ban.user_id)} disabled={loading}>
                      <Icon icon="mdi:account-check" class="size-4 mr-1" />解封
                    </Button>
                  </div>
                {/each}
              </div>
            {/if}
          </CardContent>
        </Card>
            </TabsContent>

      <!-- Collaborators -->
      <TabsContent value="collaborators" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">协作者管理</CardTitle>
          </CardHeader>
          <CardContent class="space-y-2 sm:space-y-3 p-3 sm:p-6">
            <div class="flex gap-2">
              <Input bind:value={newCollaboratorId} placeholder="用户 ID" type="number" class="max-w-20" />
              <Button size="sm" onclick={handleAddCollaborator} disabled={loading}>
                <Icon icon="mdi:account-plus" class="size-4 mr-1" />添加
              </Button>
              <Button variant="outline" size="sm" onclick={loadCollaboratorsTab} disabled={loading}>
                <Icon icon="mdi:refresh" class="size-4 mr-1" />刷新
              </Button>
            </div>
            {#if collaborators.length === 0}
              <div class="text-sm text-muted-foreground py-2">无协作者</div>
            {:else}
              <div class="space-y-1.5">
                {#each collaborators as c}
                  <div class="flex items-center justify-between border rounded-md px-3 py-2">
                    <span class="text-sm font-mono">{c.user_id}</span>
                    <Button size="sm" variant="ghost" onclick={() => handleRemoveCollaborator(c.user_id)} disabled={loading}>
                      <Icon icon="mdi:account-remove" class="size-4 mr-1" />移除
                    </Button>
                  </div>
                {/each}
              </div>
            {/if}
          </CardContent>
        </Card>

        <Card class="mt-4">
          <CardHeader>
            <CardTitle class="text-base">提名审核</CardTitle>
            <CardDescription>协作者提交的精选提名，需要你审核</CardDescription>
          </CardHeader>
          <CardContent>
            {#if pendingNominations.length === 0}
              <div class="text-sm text-muted-foreground py-4 text-center">无待审核提名</div>
            {:else}
              <div class="flex gap-1 sm:gap-2 items-start">
                {#each nomImgColumns as col, ci (ci)}
                  <div class="flex flex-1 flex-col gap-2 min-w-0">
                    {#each col as path, i (ci + '-' + i + '-' + path)}
                      {@const item = nomMasonryItems.find((i: any) => i.path === path)}
                      {#if item}
                        <div class="border rounded-lg overflow-hidden">
                          <img src={getImageProxyUrl(item.path)} alt={item.path} loading="lazy" decoding="async" style="aspect-ratio: 1;" onload={handleImgLoad} class="block w-full h-auto bg-muted" />
                          <div class="p-2 space-y-1 text-xs">
                            <div class="text-muted-foreground">UID {item.nomination.collaborator_id} | {new Date(item.nomination.submitted_at * 1000).toLocaleString()}</div>
                            {#if item.nomination.note}
                              <div class="text-muted-foreground">备注: {item.nomination.note}</div>
                            {/if}
                            <div class="flex gap-2 items-center">
                              <input type="text" bind:value={nomRejectReasons[item.nomination.id]} placeholder="拒绝理由" class="flex-1 min-w-0 rounded border border-input bg-background px-2 py-1 text-[10px] ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />

                              <Button size="sm" variant="default" onclick={() => handleNominationResolve(item.nomination.id, 'approve')} disabled={loading}>
                                <Icon icon="mdi:check" class="size-3 mr-0.5" />批准
                              </Button>
                              <Button size="sm" variant="destructive" onclick={() => handleNominationResolve(item.nomination.id, 'reject')} disabled={loading}>
                                <Icon icon="mdi:close" class="size-3 mr-0.5" />拒绝
                              </Button>
                            </div>
                          </div>
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/each}
              </div>
            {/if}
          </CardContent>
        </Card>
      </TabsContent>

      <!-- Limits -->
      <TabsContent value="credits" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">额度管理</CardTitle>
            <CardDescription>查看和修改用户生图点数余额</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <Button size="sm" onclick={loadCredits} disabled={loading}>刷新</Button>
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="font-medium">消耗配置</span>
              {#each MODEL_CFG as m}
                <label class="flex items-center gap-1">{m.label} <input type="number" bind:value={pointsCfg[m.key]} class="w-16 h-7 px-2 rounded border bg-transparent text-xs" /></label>
              {/each}
              <label class="flex items-center gap-1">LLM token/点 <input type="number" bind:value={pointsCfg.llm_token_per_point} class="w-20 h-7 px-2 rounded border bg-transparent text-xs" title="每N个token扣1点" /></label>
              <label class="flex items-center gap-1">TTS 保底 <input type="number" bind:value={pointsCfg.tts_generate} class="w-16 h-7 px-2 rounded border bg-transparent text-xs" /></label>
              <label class="flex items-center gap-1">TTS 每字 <input type="number" step="0.001" bind:value={pointsCfg.tts_per_char} class="w-20 h-7 px-2 rounded border bg-transparent text-xs" /></label>
              <label class="flex items-center gap-1">TTS 每秒 <input type="number" step="0.001" bind:value={pointsCfg.tts_per_sec} class="w-20 h-7 px-2 rounded border bg-transparent text-xs" /></label>
              <label class="flex items-center gap-1">注册赠送 <input type="number" bind:value={pointsCfg.signup_bonus} class="w-16 h-7 px-2 rounded border bg-transparent text-xs" /></label>
              <Button size="sm" variant="outline" class="h-7 text-xs" onclick={() => admin.savePointsConfig(pointsCfg).then(loadCredits)}>保存点数</Button>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs border-t pt-3">
              <span class="font-medium">赠送点数</span>
              <input type="number" bind:value={givePointsValue} class="w-20 h-7 px-2 rounded border bg-transparent text-xs" placeholder="数量" />
              <select bind:value={givePointsTarget} class="h-7 px-2 rounded border bg-transparent text-xs">
                <option value="">全部用户</option>
                <option value="uid">指定 UID</option>
              </select>
              {#if givePointsTarget === 'uid'}
                <input type="number" bind:value={givePointsUid} class="w-20 h-7 px-2 rounded border bg-transparent text-xs" placeholder="UID" />
              {/if}
              <Button size="sm" variant="outline" class="h-7 text-xs" onclick={handleGivePoints} disabled={!givePointsValue || givePointsValue <= 0}>赠送</Button>
            </div>
            <div class="border-t pt-3 space-y-2">
              <p class="text-xs font-medium">生图点排行（前 10）</p>
              {#each [...wallets].sort((a, b) => b.balance - a.balance).slice(0, 10) as w, i}
                <div class="flex items-center gap-2 text-xs border rounded-lg px-3 py-2">
                  <span class="text-muted-foreground w-5 shrink-0 text-center">{i + 1}</span>
                  <span class="font-medium w-16">UID {w.user_id}</span>
                  <span class="flex-1">⚡{w.balance}</span>
                  <input type="number" bind:value={w._edit} class="w-20 h-7 px-2 rounded border bg-transparent text-xs" />
                  <Button size="sm" variant="outline" class="h-7 text-xs" onclick={() => admin.setWalletBalance(w.user_id, Number(w._edit)).then(() => loadCredits())}>保存</Button>
                </div>
              {/each}
            </div>
            <div class="flex items-center gap-2 text-xs pt-2">
              <span class="font-medium">搜索 UID</span>
              <input type="number" bind:value={searchUid} class="w-24 h-7 px-2 rounded border bg-transparent text-xs" placeholder="输入 UID" onkeydown={(e) => { if (e.key === 'Enter') searchUidByWallet(); }} />
              <Button size="sm" variant="outline" class="h-7 text-xs" onclick={searchUidByWallet}>搜索</Button>
            </div>
            {#if searchedWallet !== null}
              <div class="flex items-center gap-2 text-xs border rounded-lg px-3 py-2">
                <span class="font-medium w-16">UID {searchedWallet.user_id}</span>
                <input type="number" bind:value={searchedWallet._edit} class="w-24 h-7 px-2 rounded border bg-transparent text-xs" />
                <Button size="sm" variant="outline" class="h-7 text-xs" onclick={() => admin.setWalletBalance(searchedWallet.user_id, Number(searchedWallet._edit)).then(() => searchUidByWallet())}>保存</Button>
              </div>
            {:else if searchUid}
              <p class="text-xs text-muted-foreground py-2 text-center">未找到该 UID</p>
            {/if}
            <div class="border-t pt-3">
              <p class="text-xs font-medium mb-2">充值计划</p>
              {#each adminPlans as plan}
                <div class="flex items-center gap-2 text-xs border rounded-lg px-3 py-2 mb-1">
                  <input bind:value={plan.name} class="w-20 h-7 px-2 rounded border bg-transparent text-xs" placeholder="名称" />
                  <input bind:value={plan.points} type="number" class="w-16 h-7 px-2 rounded border bg-transparent text-xs" placeholder="点数" />
                  <input bind:value={plan.url} class="flex-1 h-7 px-2 rounded border bg-transparent text-xs truncate" placeholder="支付链接(remark=1)" />
                  <Button size="sm" variant="outline" class="h-7 text-xs" onclick={() => admin.savePlan({ id: plan.id, name: plan.name, url: plan.url, points: Number(plan.points) }).then(loadCredits)}>保存</Button>
                  <Button size="sm" variant="destructive" class="h-7 text-xs" onclick={() => admin.deletePlan(plan.id).then(loadCredits)}>删除</Button>
                </div>
              {/each}
              <Button size="sm" variant="ghost" class="text-xs mt-1" onclick={() => { adminPlans = [...adminPlans, { id: 'new_' + Date.now(), name: '', points: 0, url: '' }]; }}>+ 新增计划</Button>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="tts-records" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">TTS 记录</CardTitle>
            <CardDescription>语音生成历史（最近 500 条）</CardDescription>
          </CardHeader>
          <CardContent>
            <Button size="sm" onclick={loadTtsRecords} disabled={ttsRecordsLoading}>刷新</Button>
            <div class="mt-3 space-y-2 max-h-[600px] overflow-y-auto">
              {#each ttsRecords as rec}
                <div class="text-xs border rounded-lg px-3 py-2 space-y-1">
                  <div class="flex items-center gap-2 text-muted-foreground">
                    <span>UID {rec.user_id}</span>
                    <span class="ml-auto">⚡{rec.cost} | {rec.language} | {rec.audioDuration.toFixed(1)}s</span>
                  </div>
                  <div class="truncate font-medium">{rec.text}</div>
                  {#if rec.refText}
                    <div class="truncate text-muted-foreground">参考: {rec.refText}</div>
                  {/if}
                  <div class="flex items-center gap-2 text-muted-foreground">
                    <span>{new Date(rec.finished_at * 1000).toLocaleString()}</span>
                    <audio src={currentBaseUrl + '/api/draw/admin/tts-download/' + rec.id + '?token=' + (forumAuth.getToken() || '')} controls class="h-8" preload="none"></audio>
                    <button onclick={async () => { if (confirm('确定删除这条记录？')) { await admin.deleteTtsRecord(rec.id); await loadTtsRecords(); } }} class="underline text-red-500 shrink-0">删除</button>
                  </div>
                </div>
              {/each}
              {#if !ttsRecordsLoading && ttsRecords.length === 0}
                <p class="text-xs text-muted-foreground text-center py-4">暂无记录</p>
              {/if}
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="limits" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">配置</CardTitle>
            <CardDescription>生图限制</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <Button variant="outline" size="sm" onclick={loadLimits} disabled={loading}>
              <Icon icon="mdi:refresh" class="size-4 mr-1" />加载
            </Button>
            {#if limits}
              {@render limitField('生成冷却（秒）', 'gen_cooldown_sec', 'number')}
                {@render limitField('生成后冷却（秒）', 'gen_cooldown_after_sec', 'number')}
                {@render limitField('每用户队列上限', 'max_queue_per_user', 'number')}
              {@render limitField('速率窗口（秒）', 'image_rate_window_sec', 'number')}
              {@render limitField('速率上限', 'image_rate_max', 'number')}
              {@render limitField('LLM 冷却（秒）', 'llm_cooldown_sec', 'number')}
              {@render limitField('GC 间隔（小时）', 'gc_interval_hours', 'number')}
              {@render limitField('Turnstile 验证', 'turnstile_enabled', 'boolean')}
              <Button onclick={saveLimits} disabled={loading}>
                <Icon icon="mdi:content-save" class="size-4 mr-1" />
                保存配置
              </Button>
                <div class="flex items-center gap-2 pt-2">
                  <Button variant="destructive" size="sm" onclick={handleClearQueue} disabled={clearing}>
                    {#if clearing}
                      <Icon icon="mdi:loading" class="size-4 mr-1 animate-spin" />
                                          <Icon icon="mdi:delete-sweep" class="size-4 mr-1" />
                    {/if}
                    清空队列
                  </Button>
                </div>

            {/if}
          </CardContent>
        </Card>
      </TabsContent>

      <!-- LLM Config -->
      <TabsContent value="llm" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base flex items-center gap-2">
              <Icon icon="mdi:brain" class="size-5" />
              LLM 配置
            </CardTitle>
            <CardDescription>配置 AI 改写/翻译所用的大语言模型</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <Button variant="outline" size="sm" onclick={loadLlmConfig} disabled={loading}>
              <Icon icon="mdi:refresh" class="size-4 mr-1" />加载
            </Button>
            {#if llmConfig}
              <div class="flex flex-wrap items-center gap-1">
                {#each llmConfig.profiles as profile, i}
                  <div class="flex items-center gap-0">
                    <button
                      class="px-2.5 py-1.5 text-xs rounded-l-md border transition-colors {llmActiveTab === i ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
                      onclick={() => llmActiveTab = i}>
                      {profile.name || ('配置' + (i + 1))}
                      {#if llmConfig.active === i}
                        <span class="ml-1 text-green-600">✓</span>
                      {/if}
                    </button>
                    {#if llmConfig.profiles.length > 1}
                      <button
                        class="px-1.5 py-1.5 text-xs rounded-r-md border border-l-0 text-muted-foreground hover:text-destructive transition-colors"
                        onclick={() => {
                          llmConfig.profiles.splice(i, 1);
                          if (llmActiveTab >= llmConfig.profiles.length) llmActiveTab = llmConfig.profiles.length - 1;
                          if (llmConfig.active === i) llmConfig.active = 0;
                          else if (llmConfig.active > i) llmConfig.active--;
                        }}>✕</button>
                    {/if}
                  </div>
                {/each}
                <Button variant="ghost" size="sm" class="text-xs" onclick={() => {
                  llmConfig.profiles.push({
                    name: 'Custom',
                    provider: 'custom',
                    custom_endpoint: '',
                    custom_api_key: '',
                    custom_model: '',
                    llm_stream: true
                  });
                  llmActiveTab = llmConfig.profiles.length - 1;
                }}>
                  <Icon icon="mdi:plus" class="size-3.5 mr-0.5" />新增配置
                </Button>
              </div>

              {@const p = llmConfig.profiles[llmActiveTab]}
              {#if p}
                <div class="space-y-1.5">
                  <Label class="text-xs">名称</Label>
                  <Input class="text-xs" bind:value={p.name} placeholder="配置{(llmActiveTab + 1)}" />
                </div>
                <div class="space-y-1.5">
                  <Label class="text-xs">类型</Label>
                  <div class="flex gap-2">
                    {#each ['google', 'custom'] as prov}
                      <button
                        class="px-3 py-1.5 text-xs rounded-md border transition-colors {p.provider === prov ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
                        onclick={() => {
                          p.provider = prov;
                          if (prov === 'google') { p.google_api_key = p.google_api_key || ''; p.google_model = p.google_model || ''; p.google_thinking = p.google_thinking || 'off'; }
                          else { p.custom_endpoint = p.custom_endpoint || ''; p.custom_api_key = p.custom_api_key || ''; p.custom_model = p.custom_model || ''; }
                        }}
                      >{prov === 'google' ? 'Google Gemini' : 'Custom'}</button>
                    {/each}
                  </div>
                </div>

                {#if p.provider === 'google'}
                  <div class="space-y-1.5">
                    <Label class="text-xs">API Key</Label>
                    <Input class="text-xs" type="password" bind:value={p.google_api_key} placeholder="AIza..." />
                  </div>
                  <div class="space-y-1.5">
                    <Label class="text-xs">模型名称</Label>
                    <div class="flex gap-1">
                      <Input class="text-xs flex-1" bind:value={p.google_model} placeholder="gemma-4-31b-it" />
                      <Button variant="outline" size="sm" onclick={loadLlmModels} disabled={llmModelsLoading}>
                        <Icon icon={llmModelsLoading ? 'mdi:loading' : 'mdi:magnify'} class="size-3.5 mr-0.5 {llmModelsLoading ? 'animate-spin' : ''}" />
                        探测模型
                      </Button>
                    </div>
                  </div>
                  <div class="space-y-1.5">
                    <Label class="text-xs">思维链</Label>
                    <div class="flex flex-wrap gap-1">
                      {#each ['off', 'level_minimal', 'level_low', 'level_medium', 'level_high'] as opt}
                        <button
                          class="px-2 py-1 text-xs rounded border transition-colors {p.google_thinking === opt ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'}"
                          onclick={() => { p.google_thinking = opt; }}
                        >{thinkingLabels[opt] || opt}</button>
                      {/each}
                    </div>
                  </div>
                {:else if p.provider === 'custom'}
                  <div class="space-y-1.5">
                    <Label class="text-xs">API 端点 <span class="text-[9px] text-muted-foreground">（完整路径，含 /v1）</span></Label>
                    <Input class="text-xs" bind:value={p.custom_endpoint} placeholder="https://api.openai.com/v1" />
                  </div>
                  <div class="space-y-1.5">
                    <Label class="text-xs">API Key</Label>
                    <Input class="text-xs" type="password" bind:value={p.custom_api_key} placeholder="sk-..." />
                  </div>
                  <div class="space-y-1.5">
                    <Label class="text-xs">模型名称</Label>
                    <div class="flex gap-1">
                      <Input class="text-xs flex-1" bind:value={p.custom_model} placeholder="gpt-4o" />
                      <Button variant="outline" size="sm" onclick={loadLlmModels} disabled={llmModelsLoading}>
                        <Icon icon={llmModelsLoading ? 'mdi:loading' : 'mdi:magnify'} class="size-3.5 mr-0.5 {llmModelsLoading ? 'animate-spin' : ''}" />
                        探测模型
                      </Button>
                    </div>
                  </div>
                {/if}

                {#if llmModels !== null}
                  <div class="border rounded p-2 max-h-40 overflow-y-auto">
                    <p class="text-[10px] text-muted-foreground mb-1">可用模型（{llmModels.length} 个）：</p>
                    {#if llmModels.length === 0}
                      <p class="text-xs text-muted-foreground">无可用模型或探测失败</p>
                    {:else}
                      {#each llmModels as model}
                        <div class="text-xs py-0.5 hover:bg-accent rounded px-1 cursor-pointer"
                          onclick={() => {
                            if (p.provider === 'google') p.google_model = model;
                            else p.custom_model = model;
                          }}>{model}</div>
                      {/each}
                    {/if}
                  </div>
                {/if}

                <div class="flex items-center gap-2">
                  <Switch checked={p.llm_stream ?? true} onCheckedChange={(e) => { p.llm_stream = e; }} />
                  <Label class="text-xs">流式输出</Label>
                </div>

                <div class="flex flex-wrap gap-2 pt-2">
                  <Button variant="outline" size="sm" onclick={testLlmConfig} disabled={llmTesting || loading}>
                    <Icon icon={llmTesting ? 'mdi:loading' : 'mdi:flask-outline'} class="size-3.5 mr-1 {llmTesting ? 'animate-spin' : ''}" />
                    测试连通性
                  </Button>
                  <Button size="sm" onclick={saveLlmConfig} disabled={loading}>
                    <Icon icon="mdi:content-save" class="size-3.5 mr-1" />
                    保存
                  </Button>
                  {#if llmConfig.active !== llmActiveTab}
                    <Button variant="secondary" size="sm" onclick={() => { llmConfig.active = llmActiveTab; }}>
                      <Icon icon="mdi:check-circle-outline" class="size-3.5 mr-1" />
                      设为当前配置
                    </Button>
                  {:else}
                    <Badge variant="outline" class="text-xs text-green-600 border-green-300">当前配置</Badge>
                  {/if}
                </div>

                {#if llmTestResult}
                  <Alert variant={llmTestResult.ok ? 'default' : 'destructive'}>
                    <AlertDescription class="text-xs">
                      {#if llmTestResult.ok}
                        <span class="font-medium text-green-600">✓ {llmTestResult.provider}</span> — {llmTestResult.reply}
                        {#if llmTestResult.raw}
                          <br /><span class="text-[9px] text-muted-foreground">原始回复: {llmTestResult.raw}</span>
                        {/if}
                      {:else}
                        <span class="font-medium">✗ 失败</span> — {llmTestResult.error}
                        {#if llmTestResult.raw}
                          <br /><span class="text-[9px] text-muted-foreground">原始回复: {llmTestResult.raw}</span>
                        {/if}
                      {/if}
                    </AlertDescription>
                  </Alert>
                {/if}
              {/if}
            {/if}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="stats" class="mt-4">
        <StatsTab />
      </TabsContent>

      <TabsContent value="storage" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">存储用量</CardTitle>
            <CardDescription>按用户统计图片和音频文件占用空间</CardDescription>
          </CardHeader>
          <CardContent>
            {#if storageLoading}
              <div class="text-xs text-muted-foreground py-4 text-center">加载中...</div>
            {:else if storageItems.length === 0}
              <div class="text-xs text-muted-foreground py-4 text-center">暂无数据</div>
            {:else}
              <div class="flex items-center gap-2 mb-3 text-xs text-muted-foreground">
                <span>总计：{formatSize(storageTotal)}</span>
                <span class="text-muted-foreground/50">|</span>
                <span>用户数：{storageItems.length}</span>
              </div>
              <div class="flex flex-wrap gap-6 mb-4">
                <div class="border rounded-lg p-3">
                  <div class="text-xs font-medium mb-2">按用户</div>
                  <PieChart
                    items={storageItems.map(i => ({ label: '#' + i.user_id, size: i.img_size + i.aud_size }))}
                    size={160} maxSlices={6}
                  />
                </div>
                <div class="border rounded-lg p-3">
                  <div class="text-xs font-medium mb-2">按类型</div>
                  {#if storageItems.length > 0}
                    {@const imgTotal = storageItems.reduce((s, i) => s + i.img_size, 0)}
                    {@const vidTotal = storageItems.reduce((s, i) => s + i.vid_size, 0)}
                    {@const audTotal = storageItems.reduce((s, i) => s + i.aud_size, 0)}
                    <PieChart
                      items={[{ label: '图片', size: imgTotal }, { label: '视频', size: vidTotal }, { label: '音频', size: audTotal }]}
                      colorScheme={['#3b82f6', '#10b981', '#f59e0b']}
                      size={160} maxSlices={3}
                    />
                  {/if}
                </div>
              </div>
              <div class="space-y-1 max-h-[600px] overflow-y-auto">
                {#each storageItems as item, i}
                  {@const maxSize = Math.max(...storageItems.map(s => s.img_size + s.vid_size + s.aud_size))}
                  {@const totSize = item.img_size + item.vid_size + item.aud_size}
                  {@const imgPct = maxSize > 0 ? item.img_size / maxSize * 100 : 0}
                  {@const vidPct = maxSize > 0 ? item.vid_size / maxSize * 100 : 0}
                  {@const audPct = maxSize > 0 ? item.aud_size / maxSize * 100 : 0}
                  <div class="flex items-center gap-2 text-xs border rounded px-3 py-1.5 {i < 3 ? 'bg-primary/5 border-primary/20' : ''}">
                    <span class="w-6 text-center font-mono text-muted-foreground {i < 3 ? 'text-primary' : ''}">#{i + 1}</span>
                    <span class="font-medium w-8 text-right">#{item.user_id}</span>
                    <div class="flex-1 space-y-0.5">
                      <div class="h-2 bg-muted rounded-full overflow-hidden flex">
                        <div class="h-full bg-blue-500/70 rounded-l-full transition-all" style="width: {imgPct}%" title="图片 {formatSize(item.img_size)}"></div>
                        <div class="h-full bg-emerald-500/70 transition-all" style="width: {vidPct}%" title="视频 {formatSize(item.vid_size)}"></div>
                        <div class="h-full bg-amber-500/70 rounded-r-full transition-all" style="width: {audPct}%" title="音频 {formatSize(item.aud_size)}"></div>
                      </div>
                      <div class="flex gap-3 text-[10px] text-muted-foreground flex-wrap">
                        <span class="flex items-center gap-1"><span class="size-2 rounded-sm bg-blue-500/70 inline-block"></span>图片 {formatSize(item.img_size)} ({item.img_files})</span>
                        <span class="flex items-center gap-1"><span class="size-2 rounded-sm bg-emerald-500/70 inline-block"></span>视频 {formatSize(item.vid_size)} ({item.vid_files})</span>
                        <span class="flex items-center gap-1"><span class="size-2 rounded-sm bg-amber-500/70 inline-block"></span>音频 {formatSize(item.aud_size)} ({item.aud_files})</span>
                      </div>
                    </div>
                    <span class="w-20 text-right font-mono shrink-0">{formatSize(totSize)}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </CardContent>
        </Card>
      </TabsContent>

      <!-- GC -->
      <TabsContent value="gc" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">垃圾回收</CardTitle>
            <CardDescription>清理孤立文件、裁剪队列、删除过期上传</CardDescription>
          </CardHeader>
          <CardContent class="space-y-2 sm:space-y-3 p-3 sm:p-6">
            <Button onclick={handleGc} disabled={loading}>
              <Icon icon="mdi:broom" class="size-4 mr-1" />
              执行 GC
            </Button>
            {#if gcResult}
              <div class="border rounded-md p-3 text-xs space-y-1">
                {#each Object.entries(gcResult) as [key, val]}
                  <div class="flex justify-between">
                    <span class="text-muted-foreground">{key}</span>
                    <span class="font-mono">{val}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="debug" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base flex items-center gap-2">
              <Icon icon="mdi:bug-outline" class="size-5" />
              队列管理
            </CardTitle>
            <CardDescription>活跃队列 — 仅用于断电恢复，任务完结自动消失</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="flex items-center gap-2">
              <Button variant="outline" size="sm" onclick={loadDebug} disabled={debugLoading}>
                <Icon icon="mdi:refresh" class="size-4 mr-1" />
                {debugLoading ? '加载中...' : '刷新'}
              </Button>
              <Button variant="destructive" size="sm" onclick={handleClearQueue} disabled={clearing}>
                {#if clearing}
                  <Icon icon="mdi:loading" class="size-4 animate-spin" />
                {/if}
                清空队列
              </Button>
            </div>



            {#if debugData}
              {#if debugData.stuck.length > 0}
                <div>
                  <h4 class="text-sm font-medium mb-2 text-red-500">卡住任务 ({debugData.stuck.length})</h4>
                  <div class="space-y-1">
                    {#each debugData.stuck as item}
                      <div class="flex items-center gap-2 text-xs border rounded px-3 py-2">
                        <Icon icon="mdi:alert" class="size-4 text-red-500" />
                        <span>UID {item.user_id}</span>
                        <Badge variant="destructive" class="text-[10px]">{item.status}</Badge>
                        <span class="text-muted-foreground">ID:{item.id}</span>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}

              <div>
                <h4 class="text-sm font-medium mb-2">活跃队列（{debugData.queue_items.length}）</h4>
                <div class="overflow-x-auto">
                  <table class="w-full text-xs">
                    <thead>
                      <tr class="border-b text-left text-muted-foreground">
                        <th class="py-1 pr-2">ID</th>
                        <th class="py-1 pr-2">UID</th>
                        <th class="py-1 pr-2">状态</th>
                        <th class="py-1 pr-2">等待</th>
                        <th class="py-1 pr-2">工作流</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each debugData.queue_items as item}
                        <tr class="border-b">
                          <td class="py-1 pr-2 font-mono">{item.id}</td>
                          <td class="py-1 pr-2">{item.user_id}</td>
                          <td class="py-1 pr-2">
                            {#if item.status === '运行'}
                              <Badge variant="default" class="text-[10px] animate-pulse">运行</Badge>
                            {:else}
                              <Badge variant="secondary" class="text-[10px]">排队</Badge>
                            {/if}
                          </td>
                          <td class="py-1 pr-2 text-muted-foreground">{item.created_ago}s前</td>
                          <td class="py-1 pr-2 break-all max-w-[120px] text-muted-foreground text-[10px]">{item.workflow_path || '-'}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </div>
            {/if}
          </CardContent>
        </Card>
      </TabsContent>

      <!-- Lora Approval -->
      <TabsContent value="lora-approval" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base flex items-center gap-2">
              <Icon icon="mdi:shape-plus-outline" class="size-5" />
              Lora 申请
            </CardTitle>
            <CardDescription>
              共 {loraPending.length} 条待审核
              <button onclick={loadLoraPending} class="text-xs text-primary hover:underline ml-2">刷新</button>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {#if loraLoading}
              <div class="text-xs text-muted-foreground py-8 text-center">加载中...</div>
            {:else if loraPending.length === 0}
              <div class="text-xs text-muted-foreground py-8 text-center">暂无待审核的 Lora 申请</div>
            {:else}
              <div class="space-y-3">
                {#each loraPending as item}
                  <div class="border border-border rounded-lg p-4 space-y-2">
                    <div class="flex items-start justify-between gap-2">
                      <div class="space-y-1">
                        <div class="text-sm font-medium">{item.name}</div>
                        <div class="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                          <span>提交者: #{item.user_id}</span>
                          <span>类型: {item.type}</span>
                          <span>分类: {item.category}</span>
                          <span>触发词: <code class="bg-muted px-1 rounded">{item.trigger}</code></span>
                        </div>
                        <div class="text-xs text-muted-foreground">
                          链接: <a href={item.url} target="_blank" rel="noopener noreferrer" class="text-primary hover:underline break-all">{item.url}</a>
                        </div>
                        <div class="text-[10px] text-muted-foreground">
                          {new Date(item.created_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                        </div>
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      <Button size="sm" class="text-xs h-7" onclick={() => handleApproveLora(item.id)} disabled={loraApprovingId === item.id}>
                        {#if loraApprovingId === item.id}
                          <Icon icon="mdi:loading" class="size-3.5 mr-1 animate-spin" />
                          下载中...
                        {:else}
                          <Icon icon="mdi:check" class="size-3.5 mr-1" />
                          通过
                        {/if}
                      </Button>
                      <Button size="sm" variant="destructive" class="text-xs h-7" onclick={() => handleRejectLora(item.id)} disabled={loraRejectingId === item.id || loraApprovingId !== null}>
                        {#if loraRejectingId === item.id}
                          <Icon icon="mdi:loading" class="size-3.5 mr-1 animate-spin" />
                          拒绝中...
                        {:else}
                          <Icon icon="mdi:close" class="size-3.5 mr-1" />
                          拒绝
                        {/if}
                      </Button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </CardContent>
        </Card>
      </TabsContent>

    </Tabs>
  {/if}
</div>

<ImageLightbox
  open={lbOpen}
  images={lbImages}
  index={0}
  onclose={() => (lbOpen = false)}
  onfork={handleAdminFork}
/>

{#snippet limitField(label: string, key: keyof AdminLimits, type: 'number' | 'text' | 'boolean')}
  {#if limits}
    <div class="flex items-center gap-3">
      <Label class="text-xs w-40 shrink-0">{label}</Label>
      {#if type === 'boolean'}
        <button
          class="px-3 py-1 text-xs rounded border transition-colors {limits[key] ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}"
          onclick={() => { if (limits) limits = { ...limits, [key]: !limits[key] }; }}
        >{limits[key] ? '开启' : '关闭'}</button>
      {:else if type === 'number'}
        <Input
          type="number"
          value={limits[key]}
          oninput={(e) => {
            if (limits) limits = { ...limits, [key]: Number(e.currentTarget.value) };
          }}
          class="max-w-32"
        />
      {:else}
        <Input
          type="text"
          value={String(limits[key])}
          oninput={(e) => {
            if (limits) limits = { ...limits, [key]: e.currentTarget.value };
          }}
          class="flex-1"
        />
      {/if}
      {#if defaults}
        <span class="text-[10px] text-muted-foreground">默认: {defaults[key]}</span>
      {/if}
    </div>
  {/if}
{/snippet}

