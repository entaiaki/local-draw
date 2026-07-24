<script lang="ts">
  let { onsubmit = (text: string) => {} }: {
    onsubmit?: (text: string) => void;
  } = $props();

  let inputValue: string = $state('');

  function handleSubmit(): void {
    const text = inputValue.trim();
    if (!text) return;
    onsubmit(text);
    inputValue = '';
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }
</script>

<div class="flex items-center gap-2">
  <textarea
    bind:value={inputValue}
    onkeydown={handleKeydown}
    placeholder="告诉我你想画什么..."
    rows={1}
    class="flex-1 bg-input border border-border rounded-xl px-4 py-2.5 text-sm placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:border-primary/50 transition-colors max-h-32"
    style="min-height: 42px;"
  ></textarea>
  <button
    onclick={handleSubmit}
    disabled={!inputValue.trim()}
    aria-label="发送"
    class="shrink-0 size-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 12h14M13 5l7 7-7 7"/>
    </svg>
  </button>
</div>
