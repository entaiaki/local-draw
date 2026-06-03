import express, { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(express.json({ limit: '50mb' }));

const TTS_TEMP_DIR = path.join(process.cwd(), 'tts_temp');
const TTS_INPUT_DIR = path.join(TTS_TEMP_DIR, 'input');
const TTS_OUTPUT_DIR = path.join(TTS_TEMP_DIR, 'output');
const TTS_STATE_FILE = path.join(TTS_TEMP_DIR, 'tts_queue_state.json');
const TTS_RECORDS_FILE = path.join(TTS_TEMP_DIR, 'tts_records.json');
const TTS_RECORDS_DIR = path.join(TTS_TEMP_DIR, 'records');
[TTS_INPUT_DIR, TTS_OUTPUT_DIR, TTS_RECORDS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

interface TtsQueueItem {
  id: number;
  user_id: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  inputPath: string;
  inputMime: string;
  text: string;
  refText: string | null;
  xVectorMode: boolean;
  language: string;
  audioDuration: number;
  cost: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  outputPath: string | null;
  error: string | null;
  speaker?: string;
  instruct?: string;
}

let ttsIdCounter = 0;
const ttsQueue: TtsQueueItem[] = [];
const MAX_TTS_CONCURRENT = 1;
let ttsActiveCount = 0;
let ttsProcessing = false;

function saveTtsState(): void {
  try {
    fs.writeFileSync(TTS_STATE_FILE, JSON.stringify({ idCounter: ttsIdCounter, items: ttsQueue }, null, 2), 'utf-8');
  } catch {}
}

function loadTtsState(): void {
  try {
    if (fs.existsSync(TTS_STATE_FILE)) {
      const d = JSON.parse(fs.readFileSync(TTS_STATE_FILE, 'utf-8'));
      ttsIdCounter = d.idCounter || 0;
      ttsQueue.length = 0;
      for (const i of d.items || []) {
        if (i.status === 'running') {
          i.status = 'failed';
          i.error = '服务重启，任务终止';
          i.finished_at = Date.now() / 1000;
        }
        ttsQueue.push(i);
      }
    }
  } catch {}
}
loadTtsState();

function ttsQueuePosition(id: number): number {
  let pos = 1;
  for (const qi of ttsQueue) {
    if (qi.status !== 'pending') continue;
    if (qi.id === id) return pos;
    pos++;
  }
  return 0;
}

async function processTtsQueue(): Promise<void> {
  if (ttsProcessing) return;
  ttsProcessing = true;
  try {
    while (true) {
      if (ttsActiveCount >= MAX_TTS_CONCURRENT) return;
      const item = ttsQueue.find(qi => qi.status === 'pending');
      if (!item) return;
      ttsActiveCount++;
      item.status = 'running';
      item.started_at = Date.now() / 1000;
      saveTtsState();
      try {
        if (item.speaker) {
          const { callTtsViaComfy } = await import('../services/tts_client.js');
          const result = await callTtsViaComfy({
            text: item.text, speaker: item.speaker, language: item.language, instruct: item.instruct,
          });
          item.outputPath = result.output_path;
        } else {
          const { callTtsGenerate } = await import('../services/tts_client.js');
          const result = await callTtsGenerate({
            audioPath: item.inputPath, text: item.text, refText: item.refText || undefined,
            xVectorMode: item.xVectorMode, language: item.language,
          });
          item.outputPath = result.output_path;
        }
        item.status = 'done';
        saveTtsRecord(item);
      } catch (e: any) {
        item.status = 'failed';
        item.error = (e.message || String(e)).slice(0, 2000);
        if (item.cost > 0) {
          try { const { refundPoints } = await import('./wallet.js'); await refundPoints(item.user_id, item.cost); } catch {}
        }
      } finally {
        item.finished_at = Date.now() / 1000;
        ttsActiveCount--;
        saveTtsState();
        try { if (item.inputPath) fs.unlinkSync(item.inputPath); } catch {}
      }
    }
  } finally {
    ttsProcessing = false;
  }
}

function queueNext(): void {
  processTtsQueue().catch(() => {});
}

const ttsUpload = multer({ dest: TTS_INPUT_DIR }).single('audio');

// POST /api/draw/tts/generate
router.post('/generate', (req: Request, res: Response) => {
  ttsUpload(req, res, async (err: any) => {
    if (err) return res.status(400).json({ error: 'upload failed: ' + (err.message || String(err)) });
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: 'no audio file' });
    const text = req.body?.text as string;
    if (!text) {
      try { fs.unlinkSync(file.path); } catch {}
      return res.status(400).json({ error: 'need text' });
    }
    const xVectorMode = req.body?.x_vector_mode === 'true';
    const refText = (req.body?.ref_text as string) || '';
    if (!xVectorMode && !refText) {
      try { fs.unlinkSync(file.path); } catch {}
      return res.status(400).json({ error: '非 X-Vector 模式下参考文本为必填项' });
    }
    try {
      const { deductPoints, loadPointsCfg } = await import('./wallet.js');
      const cfg = loadPointsCfg();
      const audioDuration = parseFloat(req.body?.audio_duration as string) || 0;
      const cost = Math.max(cfg.tts_generate || 1, Math.ceil(text.length * (cfg.tts_per_char || 0.01)) + Math.ceil(audioDuration * (cfg.tts_per_sec || 0.033)));
      if (cost > 0) {
        const user = (req as any).user;
        const ptResult = await deductPoints(user?.id, cost);
        if (!ptResult.ok) {
          try { fs.unlinkSync(file.path); } catch {}
          return res.status(402).json({ error: '点数不足', need: cost, balance: ptResult.balance || 0 });
        }
      }
      ttsIdCounter++;
      const item: TtsQueueItem = {
        id: ttsIdCounter,
        user_id: (req as any).user?.id || 0,
        status: 'pending',
        inputPath: file.path,
        inputMime: file.mimetype,
        text,
        refText: refText || null,
        xVectorMode,
        language: (req.body?.language as string) || 'auto',
        audioDuration,
        cost,
        created_at: Date.now() / 1000,
        started_at: null,
        finished_at: null,
        outputPath: null,
        error: null,
      };
      ttsQueue.push(item);
      saveTtsState();
      queueNext();
      res.json({ queued: true, item_id: item.id, position: ttsQueuePosition(item.id) });
    } catch (e: any) {
      try { fs.unlinkSync(file.path); } catch {}
      res.status(500).json({ error: e.message || '提交失败' });
    }
  });
});

// GET /api/draw/tts/my-queue
router.get('/my-queue', (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const now = Date.now() / 1000;
  const items = ttsQueue
    .filter(qi => qi.user_id === userId && (now - qi.created_at) < 7200)
    .map(qi => ({
      id: qi.id,
      status: qi.status,
      created_at: qi.created_at,
      started_at: qi.started_at,
      finished_at: qi.finished_at,
      error: qi.error,
      position: qi.status === 'pending' ? ttsQueuePosition(qi.id) : null,
    }));
  res.json({ items });
});

// GET /api/draw/tts/status/:id
router.get('/status/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id));
  const item = ttsQueue.find(qi => qi.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  res.json({
    id: item.id,
    status: item.status,
    created_at: item.created_at,
    started_at: item.started_at,
    finished_at: item.finished_at,
    error: item.error,
    position: item.status === 'pending' ? ttsQueuePosition(item.id) : null,
  });
});

// GET /api/draw/tts/result/:id
router.get('/result/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id));
  const item = ttsQueue.find(qi => qi.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (item.status !== 'done' || !item.outputPath) {
    return res.status(400).json({ error: 'not ready', status: item.status });
  }
  if (!fs.existsSync(item.outputPath)) {
    return res.status(404).json({ error: 'output file not found' });
  }
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Disposition', `attachment; filename="tts_${id}.wav"`);
  const stream = fs.createReadStream(item.outputPath);
  stream.pipe(res);
  stream.on('end', () => {
    try { if (item.outputPath) fs.unlinkSync(item.outputPath); } catch {}
  });
  stream.on('error', () => {});
});

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

function saveTtsRecord(item: TtsQueueItem): void {
  // Store the original output path from Python server for later download
  try {
    const records: TtsRecord[] = JSON.parse(fs.readFileSync(TTS_RECORDS_FILE, 'utf-8'));
    records.unshift({
      id: item.id,
      user_id: item.user_id,
      text: item.text,
      refText: item.refText,
      xVectorMode: item.xVectorMode,
      language: item.language,
      audioDuration: item.audioDuration,
      cost: item.cost,
      outputPath: item.outputPath,
      created_at: item.created_at,
      finished_at: item.finished_at || Date.now() / 1000,
    });
    if (records.length > 500) records.length = 500;
    fs.writeFileSync(TTS_RECORDS_FILE, JSON.stringify(records, null, 2), 'utf-8');
  } catch (e: any) {
    const records: TtsRecord[] = [{
      id: item.id, user_id: item.user_id, text: item.text, refText: item.refText,
      xVectorMode: item.xVectorMode, language: item.language, audioDuration: item.audioDuration,
      cost: item.cost, outputPath: item.outputPath, created_at: item.created_at,
      finished_at: item.finished_at || Date.now() / 1000,
    }];
    fs.writeFileSync(TTS_RECORDS_FILE, JSON.stringify(records, null, 2), 'utf-8');
  }
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

// --- Custom Voice (Preset) ---

// GET /api/draw/tts/speakers
router.get('/speakers', async (_req: Request, res: Response) => {
  try {
    const { fetchSpeakers } = await import('../services/tts_client.js');
    const data = await fetchSpeakers();
    res.json(data);
  } catch {
    res.json({ speakers: [
      { id: 'Vivian', description: 'Vivian' },
      { id: 'Serena', description: 'Serena' },
      { id: 'Uncle_Fu', description: 'Uncle_Fu' },
      { id: 'Dylan', description: 'Dylan' },
      { id: 'Eric', description: 'Eric' },
      { id: 'Ryan', description: 'Ryan' },
      { id: 'Aiden', description: 'Aiden' },
      { id: 'Ono_Anna', description: 'Ono_Anna' },
      { id: 'Sohee', description: 'Sohee' },
    ]});
  }
});

// POST /api/draw/tts/custom-voice
router.post('/custom-voice', requireAuth, async (req: Request, res: Response) => {
  const { text, speaker, language, instruct } = req.body;
  if (!text) return res.status(400).json({ error: 'need text' });
  if (!speaker) return res.status(400).json({ error: 'need speaker' });
  try {
    const { deductPoints, loadPointsCfg } = await import('./wallet.js');
    const cfg = loadPointsCfg();
    const cost = Math.max(cfg.tts_generate || 1, Math.ceil(text.length * (cfg.tts_per_char || 0.01)));
    const user = (req as any).user;
    if (cost > 0) {
      const pt = await deductPoints(user?.id, cost);
      if (!pt.ok) return res.status(402).json({ error: '点数不足', need: cost, balance: pt.balance || 0 });
    }
    ttsIdCounter++;
    const item: TtsQueueItem = {
      id: ttsIdCounter, user_id: user?.id || 0, status: 'pending',
      inputPath: '', inputMime: '', text, refText: null, xVectorMode: false,
      language: language || 'auto', audioDuration: 0, cost,
      created_at: Date.now() / 1000, started_at: null, finished_at: null,
      outputPath: null, error: null, speaker, instruct,
    };
    ttsQueue.push(item);
    saveTtsState();
    queueNext();
    res.json({ queued: true, item_id: item.id, position: ttsQueuePosition(item.id) });
  } catch (e: any) {
    res.status(500).json({ error: e.message || '提交失败' });
  }
});

// POST /v1/audio/speech — OpenAI-compatible endpoint for SillyTavern
router.post('/v1/audio/speech', async (req: Request, res: Response) => {
  const { input, voice, model } = req.body;
  if (!input) return res.status(400).json({ error: 'need input text' });
  const speaker = voice || 'Vivian';
  try {
    const { callTtsCustomVoice } = await import('../services/tts_client.js');
    const result = await callTtsCustomVoice({ text: input, speaker, language: 'auto' });
    if (!result.ok || !result.output_path || !fs.existsSync(result.output_path))
      return res.status(500).json({ error: 'generation failed' });
    res.setHeader('Content-Type', 'audio/wav');
    fs.createReadStream(result.output_path).pipe(res);
  } catch (e: any) {
    res.status(500).json({ error: e.message || '生成失败' });
  }
});

export { router as ttsRouter, TTS_RECORDS_FILE, loadTtsRecords, saveTtsRecords, deleteRecordAudio };
