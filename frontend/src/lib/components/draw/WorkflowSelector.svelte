<script lang="ts">
  import Icon from '@iconify/svelte';
  import { Input } from '$lib/components/ui/input';
  import { Badge } from '$lib/components/ui/badge';
  import { fetchWorkflows, fetchWorkflowDetail, getThumbnailUrl } from '$lib/draw/api/client';
  import type { DrawWorkflow } from '$lib/draw/types';

  let {
    value = $bindable(''),
    onselect,
    onpromptload,
    showTitle = true,
    constrainHeight = true,
    subdir = ''
  }: {
    value?: string;
    onselect?: (wf: DrawWorkflow) => void;
    onpromptload?: (positive: string, negative: string) => void;
    showTitle?: boolean;
    constrainHeight?: boolean;
    subdir?: string;
  } = $props();

  let workflows = $state<DrawWorkflow[]>([]);
  let search = $state('');
  let showSearch = $state(false);
  let loading = $state(true);
  let error = $state('');
  let loadingPath = $state('');
  let abortCtrl: AbortController | null = null;
  let expandedCategories = $state(new Set<string>());

  function toggleCategory(cat: string) {
    if (expandedCategories.has(cat)) expandedCategories.delete(cat);
    else expandedCategories.add(cat);
    expandedCategories = new Set(expandedCategories);
  }

  const filtered = $derived(() => {
    if (!search.trim()) return workflows;
    const q = search.toLowerCase();
    return workflows.filter(
      (w) => w.name.toLowerCase().includes(q) || w.category.toLowerCase().includes(q)
    );
  });

  const grouped = $derived(() => {
    const list = filtered();
    const cats = [...new Set(list.map((w) => w.category))];
    cats.sort((a, b) => (a === '' ? 0 : 1) - (b === '' ? 0 : 1));
    return cats.map(cat => ({ category: cat, items: list.filter(w => w.category === cat) }));
  });

  $effect(() => {
    loadWorkflows();
    });



  async function loadWorkflows() {
    loading = true;
    error = '';
    try {
      const res = await fetchWorkflows(subdir);
      workflows = res.workflows;
    } catch (e) {
      error = e instanceof Error ? e.message : '加载工作流失败';
    } finally {
      loading = false;
    }
  }

  function select(wf: DrawWorkflow) {
    value = wf.path;
    onselect?.(wf);

    abortCtrl?.abort();
    const ctrl = new AbortController();
    abortCtrl = ctrl;
    loadingPath = wf.path;

    fetchWorkflowDetail(wf.path, ctrl.signal, subdir)
      .then((detail: any) => {
        if (!ctrl.signal.aborted) {
          onpromptload?.(detail.builtin_prompt, detail.builtin_negative_prompt);
          loadingPath = '';
        }
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        if (!ctrl.signal.aborted) {
          loadingPath = '';
        }
      });
  }
</script>

<div class="space-y-2">
  {#if showTitle}
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium flex items-center gap-1.5">
        <Icon icon="mdi:cog-outline" class="size-4" />
        工作流
      </h3>
      <div class="flex items-center gap-1">
        <button
          class="p-1 rounded hover:bg-muted transition-colors"
          onclick={() => (showSearch = !showSearch)}
          title="搜索"
        >
          <Icon icon="mdi:magnify" class="size-4" />
        </button>
        <button
          class="p-1 rounded hover:bg-muted transition-colors"
          onclick={loadWorkflows}
          title="刷新"
        >
          <Icon icon="mdi:refresh" class="size-4" />
        </button>
      </div>
    </div>
  {/if}

  {#if showSearch}
    <Input
      bind:value={search}
      placeholder="搜索工作流..."
      class="h-8 text-xs"
    />
  {/if}

  {#if loading}
    <div class="text-xs text-muted-foreground py-4 text-center">加载中...</div>
  {:else if error}
    <div class="text-xs text-destructive py-4 text-center">{error}</div>
  {:else}
    <div class="{constrainHeight ? 'max-h-64' : ''} overflow-y-auto space-y-2 pr-1">
      {#each grouped() as group}
        <div>
          <button onclick={() => toggleCategory(group.category)} class="flex items-center gap-1 text-xs text-muted-foreground font-medium mb-1 px-0.5 hover:text-foreground transition-colors w-full text-left">
            <Icon icon={expandedCategories.has(group.category) ? 'mdi:chevron-down' : 'mdi:chevron-right'} class="size-3.5 shrink-0" />
            {group.category || '未分类'}
            <span class="text-[10px] text-muted-foreground/60">({group.items.length})</span>
          </button>
          {#if expandedCategories.has(group.category)}
            <div class="flex flex-wrap gap-1.5">
              {#each group.items as wf}
                <button
                  class="inline-flex items-center gap-1.5 p-1.5 rounded-md border text-left text-xs transition-all hover:bg-accent {value === wf.path ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border'}"
                  onclick={() => select(wf)}
                  disabled={loadingPath === wf.path}
                >
                  {#if wf.thumbnail}
                    <img
                      src={getThumbnailUrl(wf.path)}
                      alt=""
                      class="h-8 rounded object-contain shrink-0"
                      loading="lazy"
                    />
                  {:else}
                    <div class="size-8 rounded bg-muted flex items-center justify-center shrink-0">
                      <Icon icon="mdi:image-off-outline" class="size-4 text-muted-foreground" />
                    </div>
                  {/if}
                  {#if loadingPath === wf.path}
                    <Icon icon="mdi:loading" class="size-4 shrink-0 animate-spin" />
                  {/if}
                  <span class="truncate">{wf.path.split('/').pop()?.replace(/\.(json|txt)$/, '')}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
      {#if grouped().length === 0}
        <div class="text-xs text-muted-foreground py-4 text-center">无匹配工作流</div>
      {/if}
    </div>
  {/if}
</div>
