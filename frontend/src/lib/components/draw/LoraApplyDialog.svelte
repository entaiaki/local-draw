<script lang="ts">
  import Icon from '@iconify/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import * as Dialog from '$lib/components/ui/dialog';
  import { submitLora, getMyLoraSubmissions, cancelLora } from '$lib/draw/api/lora';
  import type { LoraApplication } from '$lib/draw/types';
  import { forumToast } from '$lib/forum/stores/toast';

  let {
    open = $bindable(false)
  }: {
    open?: boolean;
  } = $props();

  let url = $state('');
  let name = $state('');
  let category = $state('');
  let trigger = $state('');
  let type = $state('Anima');
  let submitting = $state(false);
  let showMySubs = $state(false);
  let mySubs = $state<LoraApplication[]>([]);
  let mySubsLoading = $state(false);
  let showSuccessDialog = $state(false);
  let cancellingId = $state<string | null>(null);

  $effect(() => {
    if (open) {
      showMySubs = false;
      showSuccessDialog = false;
      url = '';
      name = '';
      category = '';
      trigger = '';
    }
  });

  async function handleSubmit() {
    if (!url.trim() || !name.trim() || !category.trim() || !trigger.trim()) {
      forumToast.add({ type: 'error', message: '请填写所有必填字段', duration: 3000 });
      return;
    }
    submitting = true;
    try {
      await submitLora({ url: url.trim(), name: name.trim(), category: category.trim(), trigger: trigger.trim(), type });
      showSuccessDialog = true;
    } catch (e) {
      forumToast.add({ type: 'error', message: e instanceof Error ? e.message : '提交失败', duration: 3000 });
    } finally {
      submitting = false;
    }
  }

  async function loadMySubmissions() {
    mySubsLoading = true;
    try {
      const res = await getMyLoraSubmissions();
      mySubs = res.items;
      showMySubs = true;
    } catch (e) {
      forumToast.add({ type: 'error', message: e instanceof Error ? e.message : '加载失败', duration: 3000 });
    } finally {
      mySubsLoading = false;
    }
  }

  async function handleCancel(id: string) {
    cancellingId = id;
    try {
      await cancelLora(id);
      mySubs = mySubs.filter(s => s.id !== id);
      forumToast.add({ type: 'success', message: '已取消提交', duration: 2000 });
    } catch (e) {
      forumToast.add({ type: 'error', message: e instanceof Error ? e.message : '取消失败', duration: 3000 });
    } finally {
      cancellingId = null;
    }
  }

  function statusBadge(status: string) {
    if (status === 'approved') return { variant: 'default' as const, label: '已通过' };
    if (status === 'rejected') return { variant: 'destructive' as const, label: '已拒绝' };
    return { variant: 'outline' as const, label: '待审核' };
  }

  function formatDate(ts: number) {
    return new Date(ts * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-lg max-w-full w-full p-0 gap-0">
    {#if showSuccessDialog}
      <div class="flex flex-col items-center justify-center py-12 px-6 gap-4">
        <div class="size-14 rounded-full bg-primary/10 flex items-center justify-center">
          <Icon icon="mdi:check-circle-outline" class="size-8 text-primary" />
        </div>
        <Dialog.Title class="text-base font-medium">提交成功</Dialog.Title>
        <p class="text-xs text-muted-foreground text-center">已收到您的 Lora 申请，等待管理员审核</p>
        <Button size="sm" class="mt-2" onclick={() => (open = false)}>知道了</Button>
      </div>
    {:else if showMySubs}
      <Dialog.Header class="p-4 pb-2 shrink-0 flex-row items-center justify-between gap-2">
        <button onclick={() => (showMySubs = false)} class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <Icon icon="mdi:arrow-left" class="size-4" />
          返回
        </button>
        <Dialog.Title class="text-sm font-medium">我的 Lora 提交</Dialog.Title>
        <Dialog.Close>
          <Button variant="ghost" size="icon-sm"><Icon icon="mdi:close" class="size-4" /></Button>
        </Dialog.Close>
      </Dialog.Header>
      <div class="overflow-y-auto max-h-[60vh] p-4 pt-2 space-y-2">
        {#if mySubsLoading}
          <div class="text-xs text-muted-foreground text-center py-8">加载中...</div>
        {:else if mySubs.length === 0}
          <div class="text-xs text-muted-foreground text-center py-8">暂无提交记录</div>
        {:else}
          {#each mySubs as sub}
            <div class="border border-border rounded-lg p-3 space-y-1">
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium">{sub.name}</span>
                <div class="flex items-center gap-2">
                  {#if sub.status === 'pending'}
                    <button
                      onclick={() => handleCancel(sub.id)}
                      disabled={cancellingId === sub.id}
                      class="text-xs text-destructive hover:underline disabled:opacity-50"
                    >
                      {cancellingId === sub.id ? '取消中...' : '取消'}
                    </button>
                  {/if}
                  <Badge variant={statusBadge(sub.status).variant}>{statusBadge(sub.status).label}</Badge>
                </div>
              </div>
              <div class="text-xs text-muted-foreground">
                {sub.type} · {sub.category}
                <span class="ml-2">{formatDate(sub.created_at)}</span>
              </div>
              {#if sub.status === 'rejected' && sub.admin_reason}
                <div class="text-xs text-destructive">原因：{sub.admin_reason}</div>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    {:else}
      <Dialog.Header class="p-4 pb-2 shrink-0 flex-row items-center justify-between gap-2">
        <Dialog.Title class="text-sm font-medium flex items-center gap-2">
          <Icon icon="mdi:plus-circle-outline" class="size-4" />
          提交您的Lora（ByoLora）
        </Dialog.Title>
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" class="text-xs h-7" onclick={loadMySubmissions}>
            <Icon icon="mdi:history" class="size-3.5 mr-1" />
            我的提交
          </Button>
          <Dialog.Close>
            <Button variant="ghost" size="icon-sm"><Icon icon="mdi:close" class="size-4" /></Button>
          </Dialog.Close>
        </div>
      </Dialog.Header>
      <div class="overflow-y-auto p-4 pt-2 space-y-3">
        <div class="space-y-1.5">
          <Label class="text-xs">Lora 链接 <span class="text-destructive">*</span></Label>
          <Input bind:value={url} placeholder="https://civitai.red/models/2677495/neverness-to-everness-lacrimosa-anima" class="h-8 text-xs" />
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">显示名称 <span class="text-destructive">*</span></Label>
          <Input bind:value={name} placeholder="安魂曲" class="h-8 text-xs" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <Label class="text-xs">分类 <span class="text-destructive">*</span></Label>
            <Input bind:value={category} placeholder="异环、鸣潮、通用..." class="h-8 text-xs" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-xs">类型 <span class="text-destructive">*</span></Label>
            <div class="flex gap-2">
              {#each ['Illustrious（WAI）', 'Anima'] as t}
                <button
                  onclick={() => (type = t)}
                  class="flex-1 h-8 text-xs rounded-lg border transition-colors {type === t ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-muted-foreground/50'}"
                >{t}</button>
              {/each}
            </div>
          </div>
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">触发词 <span class="text-destructive">*</span></Label>
          <Input bind:value={trigger} placeholder="anhunqu" class="h-8 text-xs" />
        </div>
      </div>
      <div class="p-4 pt-0 flex flex-col gap-2">
        <Button onclick={handleSubmit} disabled={submitting} class="w-full h-8 text-xs">
          {#if submitting}
            <Icon icon="mdi:loading" class="size-3.5 animate-spin mr-1" />
          {/if}
          提交审核
        </Button>
        <p class="text-[10px] text-muted-foreground text-center">提交后需管理员审核，审核通过后自动创建 Lora 工作流</p>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
