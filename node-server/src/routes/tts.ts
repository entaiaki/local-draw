import express, { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(express.json({ limit: '50mb' }));

const TTS_TEMP_DIR = path.join(process.cwd(), 'tts_temp');
const TTS_RECORDS_DIR = path.join(TTS_TEMP_DIR, 'records');
const TTS_RECORDS_FILE = path.join(TTS_TEMP_DIR, 'tts_records.json');
fs.mkdirSync(TTS_RECORDS_DIR, { recursive: true });

interface TtsRecord {
  id: number;
  user_id: number;
  text: string;
  refText: string | null;
  xVectorMode: boolean;
  language: string;
  audioDuration: number;
  cost: number;
  outputPath: string | null;
  created_at: number;
  finished_at: number;
}

function loadTtsRecords(): TtsRecord[] {
  try { return JSON.parse(fs.readFileSync(TTS_RECORDS_FILE, 'utf-8')); } catch { return []; }
}

function saveTtsRecords(records: TtsRecord[]): void {
  try { fs.writeFileSync(TTS_RECORDS_FILE, JSON.stringify(records, null, 2), 'utf-8'); } catch {}
}

function deleteRecordAudio(id: number): void {
  const records = loadTtsRecords();
  const rec = records.find(r => r.id === id);
  if (rec && rec.outputPath) { try { fs.unlinkSync(rec.outputPath); } catch {} }
}

// GET /api/draw/tts/my-records
router.get('/my-records', requireAuth, (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const records = loadTtsRecords().filter(r => r.user_id === userId);
  res.json({ items: records, total: records.length });
});

// GET /api/draw/tts/record-download/:id
router.get('/record-download/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id));
  const records = loadTtsRecords();
  const rec = records.find(r => r.id === id);
  if (!rec) return res.status(404).json({ error: 'record not found' });
  if (!rec.outputPath || !fs.existsSync(rec.outputPath)) return res.status(404).json({ error: 'audio file not found' });
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Disposition', `attachment; filename="tts_${id}.wav"`);
  fs.createReadStream(rec.outputPath).pipe(res);
});

// DELETE /api/draw/tts/my-record/:id
router.delete('/my-record/:id', requireAuth, (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  const id = parseInt(String(req.params.id));
  const records = loadTtsRecords();
  const idx = records.findIndex(r => r.id === id && r.user_id === userId);
  if (idx === -1) return res.status(404).json({ error: 'record not found' });
  records.splice(idx, 1);
  saveTtsRecords(records);
  deleteRecordAudio(id);
  res.json({ ok: true });
});

// GET /api/draw/tts/speakers
router.get('/speakers', async (_req: Request, res: Response) => {
  try {
    const { getPresetVoices } = await import('../services/xiaomimimo.js');
    res.json({ speakers: getPresetVoices() });
  } catch {
    res.json({ speakers: [
      { id: 'mimo_default', description: 'MiMo-默认' },
      { id: '糖戏糖', description: '糖戏糖（女）' },
      { id: 'Mia', description: 'Mia (English Female)' },
    ]});
  }
});

// POST /api/tts/synthesize — 直接调用 MiMo API
router.post('/synthesize', requireAuth, async (req: Request, res: Response) => {
  const { text, mode, speaker, instruct, tags, language, ref_audio_name, source } = req.body;
  if (!text) return res.status(400).json({ error: 'need text' });
  const ttsMode = mode || 'preset';

  try {
    // 扣分
    const { deductPoints, loadPointsCfg } = await import('./wallet.js');
    const cfg = loadPointsCfg();
    const cost = Math.max(cfg.tts_generate || 1, Math.ceil(text.length * (cfg.tts_per_char || 0.01)));
    const user = (req as any).user;
    if (cost > 0) {
      const pt = await deductPoints(user?.id, cost);
      if (!pt.ok) return res.status(402).json({ error: '点数不足', need: cost, balance: pt.balance || 0 });
    }

    // 调用 MiMo API
    const { callTtsApi, fileToDataUri, detectMimeFromExt } = await import('../services/xiaomimimo.js');
    let refAudioDataUri = undefined;
    if (ttsMode === 'clone' && ref_audio_name) {
      const upDir = path.join(process.cwd(), '..', 'web', 'uploads');
      const audioPath = path.join(upDir, ref_audio_name);
      if (fs.existsSync(audioPath)) {
        const ext = path.extname(ref_audio_name).replace('.', '');
        refAudioDataUri = fileToDataUri(audioPath, detectMimeFromExt(ext));
      }
    }

    const result = await callTtsApi({
      text,
      mode: ttsMode,
      speaker,
      instruct,
      tags,
      refAudioDataUri,
    });

    // 保存 WAV 到 output 目录
    const { loadConfig } = await import('../services/config.js');
    const config = loadConfig();
    const prefix = ttsMode === 'preset' ? 'TTS_Preset' : ttsMode === 'design' ? 'TTS_Design' : 'TTS_Clone';
    const outName = prefix + '_' + Date.now() + '.wav';
    fs.writeFileSync(path.join(config.output_dir, outName), result.wavBuffer);

    // UID 打标
    const cmapFile = config.creator_map_file;
    try {
      let lines = fs.existsSync(cmapFile) ? fs.readFileSync(cmapFile, 'utf-8').split('\n').filter(l => l.trim()) : [];
      lines = lines.filter(l => l.split('\t')[0] !== outName);
      lines.push(outName + '\t' + (user?.id || 0));
      fs.writeFileSync(cmapFile + '.tmp', lines.join('\n') + '\n', 'utf-8');
      fs.renameSync(cmapFile + '.tmp', cmapFile);
    } catch {}

    // prompt_meta
    const promptMetaFile = path.join(path.dirname(config.creator_map_file), 'prompt_meta.json');
    let promptMeta = {};
    try { promptMeta = JSON.parse(fs.readFileSync(promptMetaFile, 'utf-8')); } catch {}
    promptMeta[outName] = {
      prompt: text,
      source: source || undefined,
      negative_prompt: instruct || '',
      workflow_path: 'TTS/' + ttsMode,
      speaker: speaker || undefined,
      language: language || undefined,
    };
    try { fs.writeFileSync(promptMetaFile, JSON.stringify(promptMeta, null, 2), 'utf-8'); } catch {}

    res.json({ ok: true, filename: outName, cost });
  } catch (e: any) {
    try {
      const { refundPoints, loadPointsCfg } = await import('./wallet.js');
      const cfg = loadPointsCfg();
      const cost = Math.max(cfg.tts_generate || 1, Math.ceil((text || '').length * (cfg.tts_per_char || 0.01)));
      if (cost > 0) await refundPoints((req as any).user?.id, cost);
    } catch {}
    res.status(500).json({ error: e.message || '生成失败' });
  }
});

// POST /v1/audio/speech — OpenAI-compatible endpoint for SillyTavern
router.post('/v1/audio/speech', async (req: Request, res: Response) => {
  const { input, voice } = req.body;
  if (!input) return res.status(400).json({ error: 'need input text' });
  const speaker = voice || 'mimo_default';
  try {
    const { callTtsApi } = await import('../services/xiaomimimo.js');
    const result = await callTtsApi({
      text: input,
      mode: 'preset',
      speaker,
    });
    res.setHeader('Content-Type', 'audio/wav');
    res.send(result.wavBuffer);
  } catch (e: any) {
    res.status(500).json({ error: e.message || '生成失败' });
  }
});

export { router as ttsRouter, TTS_RECORDS_FILE, loadTtsRecords, saveTtsRecords, deleteRecordAudio };