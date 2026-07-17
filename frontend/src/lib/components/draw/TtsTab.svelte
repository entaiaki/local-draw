<script lang="ts">
import Icon from '@iconify/svelte';
import { Button } from '$lib/components/ui/button';
import { Label } from '$lib/components/ui/label';
import { Alert, AlertDescription } from '$lib/components/ui/alert';
import { forumAuth } from '$lib/forum/stores/auth';
import { getImageUrl, uploadTtsRefAudio, drawRequest } from '$lib/draw/api/client';
import { Badge } from '$lib/components/ui/badge';
import { onMount } from 'svelte';
import { autoResize } from '$lib/utils/actions';

const TTS_STORAGE_KEY = 'tts-form';
function loadTtsForm(): Record<string, any> {
  try { return JSON.parse(localStorage.getItem(TTS_STORAGE_KEY) || '{}'); } catch { return {}; }
}
function saveTtsForm(v: Record<string, any>) {
  try { localStorage.setItem(TTS_STORAGE_KEY, JSON.stringify(v)); } catch {}
}

type TtsMode = 'preset' | 'custom' | 'clone';

let {
  ttsMode = $bindable<TtsMode>('preset'),
  ttsSpeaker = $bindable('mimo_default'),
  ttsInstruct = $bindable(''),
  ttsTargetText = $bindable(''),
  ttsLanguage = $bindable('auto'),
  ttsTags = $bindable(''),
  ttsPerChar = 0.01, ttsPerSec = 0.033, ttsMin = 1,
}: {
  ttsMode?: TtsMode;
  ttsSpeaker?: string;
  ttsInstruct?: string;
  ttsTargetText?: string;
  ttsLanguage?: string;
  ttsTags?: string;
  ttsPerChar?: number;
  ttsPerSec?: number;
  ttsMin?: number;
} = $props();

// Preset mode
let speakers = $state<Array<{ id: string; description: string }>>([]);

// Audio upload (clone only)
let audioFile = $state<File | null>(null);
let audioUrl = $state('');

// Shared
let submitting = $state(false);
let error = $state('');

let resultUrl = $state('');
let done = $state(false);

let estimatedCost = $derived(Math.max(ttsMin, Math.ceil((ttsTargetText || '').length * ttsPerChar)));
let costLabel = $derived(estimatedCost > 0 ? `⚡${estimatedCost}~` : '');

// localStorage 恢复
const saved = loadTtsForm();
if (saved.mode) ttsMode = saved.mode;
if (saved.speaker) ttsSpeaker = saved.speaker;
if (saved.instruct !== undefined) ttsInstruct = saved.instruct;
if (saved.targetText) ttsTargetText = saved.targetText;
if (saved.language) ttsLanguage = saved.language;
if (saved.tags) ttsTags = saved.tags;

// 状态变化时保存
$effect(() => {
  saveTtsForm({ mode: ttsMode, speaker: ttsSpeaker, instruct: ttsInstruct, targetText: ttsTargetText, language: ttsLanguage, tags: ttsTags });
});

function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  audioFile = file;
  audioUrl = URL.createObjectURL(file);
}

async function handleSubmit() {
  if (submitting || !ttsTargetText) return;
  error = '';
  submitting = true;
  try {
    let refName = undefined;
    if (ttsMode === 'clone' && audioFile) {
      const uploadRes = await uploadTtsRefAudio(audioFile);
      refName = uploadRes.filename;
    }
    const res = await drawRequest<{ ok: boolean; filename: string; cost: number }>('/api/draw/tts/synthesize', {
      method: 'POST',
      json: {
        text: ttsTargetText,
        mode: ttsMode,
        speaker: ttsMode === 'preset' ? ttsSpeaker : undefined,
        instruct: ttsInstruct || undefined,
        tags: ttsTags || undefined,
        ref_audio_name: refName,
      },
      requiresAuth: true,
    });
    if (res.ok && res.filename) {
      resultUrl = getImageUrl(res.filename);
      done = true;
    }
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : '提交失败';
  } finally {
    submitting = false;
  }
}

function handleReset() {
  resultUrl = '';
  done = false;
  error = '';
}

const PRESET_VOICES = [
  { id: 'mimo_default', description: 'MiMo-默认' },
  { id: '冰糖', description: '冰糖（女）' },
  { id: '茉莉', description: '茉莉（女）' },
  { id: '苏打', description: '苏打（男）' },
  { id: '白桦', description: '白桦（男）' },
  { id: 'Mia', description: 'Mia (English Female)' },
  { id: 'Chloe', description: 'Chloe (English Female)' },
  { id: 'Milo', description: 'Milo (English Male)' },
  { id: 'Dean', description: 'Dean (English Male)' },
];

onMount(async () => {
  speakers = PRESET_VOICES;
});

</script>

<div class="space-y-4">
  <h3 class="text-sm font-medium flex items-center gap-1.5">
    <Icon icon="mdi:voice" class="size-4" />
    语音合成 (TTS)
  </h3>

  <!-- Mode Toggle -->
  <div class="flex gap-2">
    <button onclick={() => { ttsMode = 'preset'; handleReset(); }} class="px-3 py-1.5 text-xs rounded-lg border {ttsMode === 'preset' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-accent'} transition-colors">预设音色</button>
    <button onclick={() => { ttsMode = 'custom'; handleReset(); }} class="px-3 py-1.5 text-xs rounded-lg border {ttsMode === 'custom' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-accent'} transition-colors">自定义音色</button>
    <button onclick={() => { ttsMode = 'clone'; handleReset(); }} class="px-3 py-1.5 text-xs rounded-lg border {ttsMode === 'clone' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-accent'} transition-colors">声音克隆</button>
  </div>

  {#if ttsMode === 'preset'}
    <!-- Preset Voice -->
    <div class="space-y-1.5">
      <Label for="tts-speaker">预制音色</Label>
      <select id="tts-speaker" bind:value={ttsSpeaker} class="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs">
        {#each speakers as sp}
          <option value={sp.id}>{sp.id} — {sp.description}</option>
        {/each}
      </select>
    </div>
    <div class="space-y-1.5">
      <Label for="tts-instruct">风格指令 <span class="text-muted-foreground text-[10px]">(可选)</span></Label>
      <textarea id="tts-instruct" bind:value={ttsInstruct} use:autoResize placeholder="用轻快上扬的语调，语速稍快，声音明亮有活力"
        class="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs placeholder:text-muted-foreground scrollbar-hide"></textarea>
      <div class="text-[10px] text-muted-foreground">支持在文本中嵌入标签：(开心)[语速加快][笑][叹气] 等</div>
    </div>
  {:else if ttsMode === 'custom'}
    <!-- Custom Voice Design -->
    <div class="space-y-1.5">
      <Label for="tts-instruct-custom">音色描述 <span class="text-muted-foreground text-[10px]">(可选，支持导演模式)</span></Label>
      <textarea id="tts-instruct-custom" bind:value={ttsInstruct} use:autoResize
        placeholder="【角色】五十多岁的中年男性，声音低沉浑厚
【场景】深夜在书房给远方的儿子写信
【指导】语速缓慢，带着慈爱与叮嘱，偶尔停顿思考"
        class="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs placeholder:text-muted-foreground scrollbar-hide"></textarea>
      <details class="text-[10px] text-muted-foreground">
        <summary class="cursor-pointer hover:text-foreground">可用风格标签</summary>
        <div class="mt-1 space-y-0.5">
          <div>基础情绪：开心/悲伤/愤怒/恐惧/惊讶/兴奋/委屈/平静/冷漠</div>
          <div>整体语调：温柔/高冷/活泼/严肃/慵懒/俏皮/深沉/干练/凌厉</div>
          <div>音色定位：磁性/醇厚/清亮/空灵/稚嫩/苍老/甜美/沙哑/醇雅</div>
          <div>人设腔调：夹子音/御姐音/正太音/大叔音/台湾腔</div>
          <div>方言：东北话/四川话/河南话/粤语</div>
          <div>文本中嵌入 [语速加快] [笑] [叹气] [深呼吸] 等标签可精细控制</div>
        </div>
      </details>
    </div>
  {:else}
    <!-- Voice Clone -->
    <div class="space-y-1.5">
      <Label for="tts-refaudio">参考音频</Label>
      <input id="tts-refaudio" type="file" accept="audio/*" onchange={handleFileSelect}
        class="block w-full text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-primary/10 file:text-primary hover:file:bg-primary/20 cursor-pointer" />
      {#if audioFile}
        <div class="text-xs text-muted-foreground">{audioFile.name} ({(audioFile.size / 1024).toFixed(1)} KB)</div>
        <audio src={audioUrl} controls class="w-full h-10 mt-1" />
      {/if}
    </div>
    <div class="space-y-1.5">
      <Label for="tts-reftext">参考文本 <span class="text-muted-foreground text-[10px]">(可选)</span></Label>
      <div class="text-[10px] text-muted-foreground">上传参考音频后即可克隆音色，无需填写文本</div>
    </div>
  {/if}

  <!-- Audio Tags -->
  <div class="space-y-1.5">
    <Label>音频标签 <span class="text-muted-foreground text-[10px]">(点击添加，自动嵌入合成文本开头)</span></Label>
    <div><span class="text-[9px] text-muted-foreground">基础情绪</span>
      {#each ['开心','悲伤','愤怒','恐惧','惊讶','兴奋','委屈','平静','冷漠'] as tag}
        <button onclick={() => { ttsTags = ttsTags.includes(tag) ? ttsTags.replace('('+tag+')','').trim() : ttsTags + '('+tag+')' }} class="px-2 py-0.5 text-[10px] rounded-full border m-0.5 {ttsTags.includes(tag) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-accent'} transition-colors">{tag}</button>
      {/each}
    </div>
    <div><span class="text-[9px] text-muted-foreground">复合情绪</span>
      {#each ['怅然','欣慰','无奈','愧疚','释然','嫉妒','厌倦','忐忑','动情'] as tag}
        <button onclick={() => { ttsTags = ttsTags.includes(tag) ? ttsTags.replace('('+tag+')','').trim() : ttsTags + '('+tag+')' }} class="px-2 py-0.5 text-[10px] rounded-full border m-0.5 {ttsTags.includes(tag) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-accent'} transition-colors">{tag}</button>
      {/each}
    </div>
    <div><span class="text-[9px] text-muted-foreground">整体语调</span>
      {#each ['温柔','高冷','活泼','严肃','慵懒','俏皮','深沉','干练','凌厉'] as tag}
        <button onclick={() => { ttsTags = ttsTags.includes(tag) ? ttsTags.replace('('+tag+')','').trim() : ttsTags + '('+tag+')' }} class="px-2 py-0.5 text-[10px] rounded-full border m-0.5 {ttsTags.includes(tag) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-accent'} transition-colors">{tag}</button>
      {/each}
    </div>
    <div><span class="text-[9px] text-muted-foreground">音色定位</span>
      {#each ['磁性','醇厚','清亮','空灵','稚嫩','苍老','甜美','沙哑','醇雅'] as tag}
        <button onclick={() => { ttsTags = ttsTags.includes(tag) ? ttsTags.replace('('+tag+')','').trim() : ttsTags + '('+tag+')' }} class="px-2 py-0.5 text-[10px] rounded-full border m-0.5 {ttsTags.includes(tag) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-accent'} transition-colors">{tag}</button>
      {/each}
    </div>
    <div><span class="text-[9px] text-muted-foreground">人设腔调</span>
      {#each ['夹子音','御姐音','正太音','大叔音','台湾腔'] as tag}
        <button onclick={() => { ttsTags = ttsTags.includes(tag) ? ttsTags.replace('('+tag+')','').trim() : ttsTags + '('+tag+')' }} class="px-2 py-0.5 text-[10px] rounded-full border m-0.5 {ttsTags.includes(tag) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-accent'} transition-colors">{tag}</button>
      {/each}
    </div>
    <div><span class="text-[9px] text-muted-foreground">方言</span>
      {#each ['东北话','四川话','河南话','粤语'] as tag}
        <button onclick={() => { ttsTags = ttsTags.includes(tag) ? ttsTags.replace('('+tag+')','').trim() : ttsTags + '('+tag+')' }} class="px-2 py-0.5 text-[10px] rounded-full border m-0.5 {ttsTags.includes(tag) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-accent'} transition-colors">{tag}</button>
      {/each}
    </div>
    <div><span class="text-[9px] text-muted-foreground">细粒度控制 <span class="text-muted-foreground/60">([标签] 格式嵌入文本中间)</span></span>
      {#each ['笑','轻笑','大笑','冷笑','抽泣','呜咽','哽咽','嚎啕大哭','紧张','害怕','激动','疲惫','委屈','撒娇','心虚','震惊','不耐烦','颤抖','声音颤抖','变调','破音','鼻音','气声','沙哑','吸气','深呼吸','叹气','长叹一口气','喘息','屏息','语速加快','语速减慢','小声'] as tag}
        <button onclick={() => { const fmt = '['+tag+']'; ttsTags = ttsTags.includes(tag) ? ttsTags.replace('['+tag+']','').trim() : ttsTags + fmt }} class="px-2 py-0.5 text-[10px] rounded-full border m-0.5 {ttsTags.includes(tag) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-accent'} transition-colors">{tag}</button>
      {/each}
    </div>
    <div><span class="text-[9px] text-muted-foreground">特殊</span>
      {#each ['唱歌','孙悟空','林黛玉'] as tag}
        <button onclick={() => { ttsTags = ttsTags.includes(tag) ? ttsTags.replace('('+tag+')','').trim() : ttsTags + '('+tag+')' }} class="px-2 py-0.5 text-[10px] rounded-full border m-0.5 {ttsTags.includes(tag) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-accent'} transition-colors">{tag}</button>
      {/each}
    </div>
    <textarea bind:value={ttsTags} use:autoResize placeholder="也可手动输入，多个标签直接拼接如(开心)[深呼吸]你好呀"
      class="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs placeholder:text-muted-foreground scrollbar-hide"></textarea>
  </div>

  <!-- Language -->
  <div class="space-y-1.5">
    <Label for="tts-lang">语言</Label>
    <select id="tts-lang" bind:value={ttsLanguage} class="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs">
      <option value="auto">自动检测</option>
      <option value="zh">中文</option>
      <option value="en">英文</option>
      <option value="ja">日文</option>
      <option value="ko">韩文</option>
    </select>
  </div>

  <!-- Target Text -->
  <div class="space-y-1.5">
    <Label for="tts-text">要合成的文字</Label>
    <textarea id="tts-text" bind:value={ttsTargetText} use:autoResize
      placeholder="输入要合成语音的文字内容"
      class="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs placeholder:text-muted-foreground scrollbar-hide"></textarea>
  </div>

  <!-- Submit -->
  <Button onclick={handleSubmit}
    disabled={submitting || !ttsTargetText || done} class="w-full">
    <Icon icon="mdi:send" class="size-4 mr-1" />
    {submitting ? '合成中...' : done ? '已完成' : '开始生成'}
    {#if estimatedCost > 0}
      <Badge variant="secondary" class="ml-1.5 text-[10px] px-1">{costLabel}</Badge>
    {/if}
  </Button>

  <!-- Error -->
  {#if error}
    <Alert variant="destructive">
      <Icon icon="mdi:alert-circle" class="size-4" />
      <AlertDescription class="text-xs">{error}</AlertDescription>
    </Alert>
  {/if}

  <!-- Result -->
  {#if done}
    <div class="space-y-2 border rounded-lg p-3">
      <div class="text-xs font-medium flex items-center gap-1.5">
        <Icon icon="mdi:check-circle" class="size-4 text-green-500" />
        转换完成
      </div>
      {#if resultUrl}
        <audio src={resultUrl} controls class="w-full h-10" />
        <div class="flex gap-2">
          <a href={resultUrl} download class="flex-1">
            <Button variant="default" size="sm" class="w-full">
              <Icon icon="mdi:download" class="size-4 mr-1" />
              下载音频
            </Button>
          </a>
          <Button variant="outline" size="sm" onclick={handleReset}>重新开始</Button>
        </div>
      {:else}
        <div class="text-xs text-muted-foreground">
          音频文件处理中，请前往<a href="/draw/#mine" class="underline font-medium">"我的"页面</a>查看和下载。
        </div>
        <Button variant="outline" size="sm" onclick={handleReset}>重新开始</Button>
      {/if}
    </div>
  {/if}
</div>

<style>
  :global(.scrollbar-hide)::-webkit-scrollbar { display: none; }
  :global(.scrollbar-hide) { scrollbar-width: none; -ms-overflow-style: none; }
</style>
