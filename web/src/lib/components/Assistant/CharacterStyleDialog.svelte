<script lang="ts">
  import type { Character } from '$lib/types/assistant';

  let {
    characters = [] as Character[],
    styles = [] as string[],
    selectedCharacter = null as string | null,
    selectedStyle = null as string | null,
    onSelect = null,
    onClose = null,
  }: {
    characters?: Character[];
    styles?: string[];
    selectedCharacter?: string | null;
    selectedStyle?: string | null;
    onSelect?: (char: string | null, style: string | null) => void;
    onClose?: () => void;
  } = $props();

  let searchQuery = $state('');
  let activeTab = $state<'characters' | 'styles'>('characters');

  let filteredChars = $derived(
    characters.filter(c =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (c.trigger_tags || []).some((t: string) => t.toLowerCase().includes(searchQuery.toLowerCase()))
    )
  );

  let filteredStyles = $derived(
    styles.filter(s => s.toLowerCase().includes(searchQuery.toLowerCase()))
  );
</script>

<!-- Backdrop -->
<div
  class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in"
  onclick={() => onClose?.()}
  onkeydown={(e) => e.key === 'Escape' && onClose?.()}
  role="button"
  tabindex="0"
>
  <!-- Dialog -->
  <div
    class="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col animate-slide-up"
    onclick={(e) => e.stopPropagation()}
    role="dialog"
    tabindex="0"
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-5 py-3 border-b border-border">
      <h2 class="font-semibold text-sm">选角色 / 画风</h2>
      <button class="text-muted-foreground hover:text-foreground" onclick={() => onClose?.()}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <!-- Tabs -->
    <div class="flex items-center gap-1 px-5 pt-3">
      <button
        class="px-3 py-1.5 text-xs font-medium rounded-lg {activeTab === 'characters' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}"
        onclick={() => activeTab = 'characters'}
      >👤 角色 ({characters.length})</button>
      <button
        class="px-3 py-1.5 text-xs font-medium rounded-lg {activeTab === 'styles' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}"
        onclick={() => activeTab = 'styles'}
      >🎨 画风 ({styles.length})</button>
    </div>

    <!-- Search -->
    <div class="px-5 py-3">
      <input
        type="text"
        bind:value={searchQuery}
        placeholder="搜索角色名或触发词..."
        class="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
      />
    </div>

    <!-- List -->
    <div class="flex-1 overflow-y-auto px-5 pb-5 space-y-1">
      {#if activeTab === 'characters'}
        <!-- Clear selection option -->
        <button
          class="w-full text-left px-3 py-2 rounded-lg text-xs {!selectedCharacter ? 'bg-primary/20 text-primary' : 'hover:bg-muted'}"
          onclick={() => onSelect?.(null, selectedStyle)}
        >无角色</button>
        {#each filteredChars as char}
          <button
            class="w-full text-left px-3 py-2 rounded-lg text-xs {selectedCharacter === char.name ? 'bg-primary/20 text-primary' : 'hover:bg-muted'}"
            onclick={() => onSelect?.(char.name, selectedStyle)}
          >
            <div class="font-medium">{char.name}</div>
            {#if char.trigger_tags?.length}
              <div class="text-[10px] text-muted-foreground mt-0.5">{char.trigger_tags.join(', ')}</div>
            {/if}
          </button>
        {/each}
        {#if filteredChars.length === 0}
          <div class="text-center text-xs text-muted-foreground py-8">未找到匹配角色</div>
        {/if}
      {:else}
        <button
          class="w-full text-left px-3 py-2 rounded-lg text-xs {!selectedStyle ? 'bg-primary/20 text-primary' : 'hover:bg-muted'}"
          onclick={() => onSelect?.(selectedCharacter, null)}
        >无画风</button>
        {#each filteredStyles as style}
          <button
            class="w-full text-left px-3 py-2 rounded-lg text-xs {selectedStyle === style ? 'bg-primary/20 text-primary' : 'hover:bg-muted'}"
            onclick={() => onSelect?.(selectedCharacter, style)}
          >{style}</button>
        {/each}
      {/if}
    </div>

    <!-- Footer -->
    <div class="px-5 py-3 border-t border-border flex items-center justify-between">
      <div class="text-xs text-muted-foreground">
        {#if selectedCharacter || selectedStyle}
          已选: {selectedCharacter || '无角色'} / {selectedStyle || '无画风'}
        {/if}
      </div>
      <button
        class="px-4 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
        onclick={() => onClose?.()}
      >确定</button>
    </div>
  </div>
</div>
