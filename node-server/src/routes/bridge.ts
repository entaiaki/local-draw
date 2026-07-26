/** Bridge route: forward to local diffusers bridge server (127.0.0.1:8766).
 *  Z-Image / GLM-Image / Flux2-Klein run natively via diffusers, no ComfyUI workflow. */
import { Router } from 'express';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:8766';

export const bridgeRouter = Router();

// GET /api/draw/bridge/models — 桥接可用模型列表
bridgeRouter.get('/bridge/models', async (_req, res) => {
  try {
    const r = await fetch(`${BRIDGE_URL}/models`, { signal: AbortSignal.timeout(5000) });
    res.json(await r.json());
  } catch (e: any) {
    res.status(502).json({ ok: false, error: `bridge offline: ${e.message}` });
  }
});

// POST /api/draw/bridge — 直出生图 {model, prompt, negative_prompt?, width?, height?, steps?, guidance?}
bridgeRouter.post('/bridge', async (req, res) => {
  const { model, prompt, negative_prompt = '', width = 1024, height = 1024, steps = 0, guidance = -1 } = req.body || {};
  if (!model || !prompt) {
    return res.status(400).json({ ok: false, error: 'model and prompt required' });
  }
  try {
    const r = await fetch(`${BRIDGE_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, negative_prompt, width, height, steps, guidance }),
      signal: AbortSignal.timeout(300000),  // 首次加载~30s, 给5分钟上限
    });
    const data: any = await r.json();
    if (!data.ok) return res.status(500).json(data);
    // filename 落在 ComfyUI output 目录, 复用现有 /api/image 读取
    res.json({
      ok: true,
      image_url: `/api/image?filename=${encodeURIComponent(data.filename)}`,
      filename: data.filename,
      seed: data.seed,
      gen_sec: data.gen_sec,
      load_sec: data.load_sec,
    });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: `bridge error: ${e.message}` });
  }
});
