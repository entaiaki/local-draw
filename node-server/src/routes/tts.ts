import express, { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';

const router = Router();
router.use(express.json({ limit: '50mb' }));

const TTS_TEMP_DIR = path.join(process.cwd(), 'tts_temp');
const TTS_INPUT_DIR = path.join(TTS_TEMP_DIR, 'input');
const TTS_OUTPUT_DIR = path.join(TTS_TEMP_DIR, 'output');
[TTS_INPUT_DIR, TTS_OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

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
  cost: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  outputPath: string | null;
  error: string | null;
}

let ttsIdCounter = 0;
const ttsQueue: TtsQueueItem[] = [];
const MAX_TTS_CONCURRENT = 1;
let ttsActiveCount = 0;
let ttsProcessing = false;

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
      try {
        const { callTtsGenerate } = await import('../services/tts_client.js');
        const result = await callTtsGenerate({
          audioPath: item.inputPath,
          text: item.text,
          refText: item.refText || undefined,
          xVectorMode: item.xVectorMode,
          language: item.language,
        });
        item.outputPath = result.output_path;
        item.status = 'done';
      } catch (e: any) {
        item.status = 'failed';
        item.error = (e.message || String(e)).slice(0, 2000);
        if (item.cost > 0) {
          try { const { refundPoints } = await import('./wallet.js'); await refundPoints(item.user_id, item.cost); } catch {}
        }
      } finally {
        item.finished_at = Date.now() / 1000;
        ttsActiveCount--;
        try { fs.unlinkSync(item.inputPath); } catch {}
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
    try {
      const { deductPoints, loadPointsCfg } = await import('./wallet.js');
      const cost = loadPointsCfg().tts_generate || 0;
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
        refText: (req.body?.ref_text as string) || null,
        xVectorMode: req.body?.x_vector_mode === 'true',
        language: (req.body?.language as string) || 'auto',
        cost,
        created_at: Date.now() / 1000,
        started_at: null,
        finished_at: null,
        outputPath: null,
        error: null,
      };
      ttsQueue.push(item);
      queueNext();
      res.json({ queued: true, item_id: item.id, position: ttsQueuePosition(item.id) });
    } catch (e: any) {
      try { fs.unlinkSync(file.path); } catch {}
      res.status(500).json({ error: e.message || '提交失败' });
    }
  });
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

export { router as ttsRouter };
