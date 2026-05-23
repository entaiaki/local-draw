import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { jwtAuth, requireAuth } from './middleware/auth.js';
import { queueRouter } from './routes/queue.js';
import { imageRouter } from './routes/images.js';
import { adminRouter } from './routes/admin.js';
import { workflowRouter } from './routes/workflow.js';
import { statusRouter, setupWsStatus } from './routes/status.js';
import { loadConfig } from './services/config.js';
import { walletRouter, deductPoints, refundPoints, loadPointsCfg } from './routes/wallet.js';

// CLI arg parsing: --host HOST --port PORT
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--host' && argv[i + 1]) {
    process.env.WEB_HOST = argv[++i];
  } else if (argv[i] === '--port' && argv[i + 1]) {
    process.env.WEB_PORT = argv[++i];
  }
}

// Load .env into process.env
for (const dir of [process.cwd(), path.join(process.cwd(), '..')]) {
  try {
    const envContent = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
    for (const line of envContent.split('\n')) {
      const m = line.match(/^(\w+)="([^"]*)"\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/status' });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Config
const config = loadConfig();

// Auth middleware
app.use('/api', jwtAuth(config));

// Routes (dynamic import for hot reload support)
const hot = (modPath: string, exportName = 'default') => (req: any, res: any, next: any) => { import(modPath).then(m => (m[exportName] || m.default || m)(req, res, next)).catch(next); };
app.use('/api/draw', hot('./routes/queue.js', 'queueRouter'));
app.use('/api/output', hot('./routes/images.js', 'imageRouter'));
app.use('/api/draw/admin', hot('./routes/admin.js', 'adminRouter'));
app.use('/api/draw/admin', hot('./routes/collaborator.js', 'adminCollaboratorRouter'));
app.use('/api/draw/collaborator', hot('./routes/collaborator.js', 'collaboratorRouter'));
app.use('/api/draw', hot('./routes/status.js', 'statusRouter'));
app.use('/api', hot('./routes/workflow.js', 'workflowRouter'));
app.use('/api/wallet', walletRouter);
app.use('/api/draw/admin', walletRouter);
app.get('/health', (_req, res) => res.set('Cache-Control', 'no-store, no-cache, must-revalidate').status(200).json({ status: 'ok' }));

// Health check
app.get('/api/_diag', (req, res) => {
  res.json({ active_count: 0, active_status: null, subscribers: wss.clients.size });
});

// Additional API routes
app.get('/api/resolutions', (req, res) => {
  const rf = path.join(path.dirname(config.creator_map_file), 'resolutions.json');
  try { res.json(JSON.parse(fs.readFileSync(rf, 'utf-8'))); } catch { res.json({ presets: [] }); }
});

app.get('/api/style_thumbnail', (req, res) => {
  const name = req.query.name as string;
  if (!name) return res.status(404).json({ error: 'no style' });
  const dirs = [
    config.thumb_dir || path.join(process.cwd(), '..', 'web', 'thumbnails'),
    path.join(process.cwd(), '..', 'web', 'style_thumbnails'),
  ];
  for (const dir of dirs) {
    const direct = path.resolve(dir, name);
    if (direct.startsWith(path.resolve(dir)) && fs.existsSync(direct)) return res.sendFile(direct);
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
      const fp = path.resolve(dir, name + ext);
      if (fp.startsWith(path.resolve(dir)) && fs.existsSync(fp)) return res.sendFile(fp);
    }
  }
  res.status(404).json({ error: 'not found' });
});

app.get('/api/styles', (req, res) => {
  const sf = path.join(path.dirname(config.creator_map_file), 'styles.json');
  try {
    const styles = JSON.parse(fs.readFileSync(sf, 'utf-8'));
    const result = styles.map((s: any) => ({
      ...s,
      thumbnail_url: s.image ? `/api/style_thumbnail?name=${encodeURIComponent(s.image)}` : undefined,
    }));
    res.json({ styles: result });
  } catch { res.json({ styles: [] }); }
});

const THUMB_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

app.get('/api/thumbnail', (req, res) => {
  const p = req.query.path as string;
  if (!p) return res.status(404).json({ error: 'no thumbnail' });

  // Look for thumbnail alongside workflow file: workflows/<subdir>/<category>/<basename>.ext
  const workflowsDir = config.workflows_dir || path.join(process.cwd(), '..', 'node-server', 'workflows');
  // p is like "鸣潮/卡提希娅.json" or "WAI/鸣潮/卡提希娅.json"
  // Remove WAI/ or ANIMA/ prefix if present, then we have "category/name.json"
  const relPath = p.replace(/^(WAI|ANIMA)\//i, '');
  const baseName = relPath.replace(/\.json$/i, '');
  for (const ext of THUMB_EXTS) {
    const fp = path.resolve(workflowsDir, baseName + ext);
    if (fp.startsWith(path.resolve(workflowsDir)) && fs.existsSync(fp)) return res.sendFile(fp);
    // Also check with WAI/ prefix
    const fp2 = path.resolve(workflowsDir, 'WAI', baseName + ext);
    if (fp2.startsWith(path.resolve(workflowsDir)) && fs.existsSync(fp2)) return res.sendFile(fp2);
    // Also check with ANIMA/ prefix
    const fp3 = path.resolve(workflowsDir, 'ANIMA', baseName + ext);
    if (fp3.startsWith(path.resolve(workflowsDir)) && fs.existsSync(fp3)) return res.sendFile(fp3);
  }

  // Fallback: old thumbnails directory
  const thumbDir = config.thumb_dir || path.join(process.cwd(), '..', 'web', 'thumbnails');
  const thumbPath = path.join(thumbDir, path.basename(p));
  if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath);

  // 兜底：从输出目录返回原图
  const relNorm = p.replace(/\\/g, '/').replace(/^\//, '');
  if (!relNorm.includes('..')) {
    for (const baseDir of [config.output_dir, config.archive_dir]) {
      const fp = path.resolve(baseDir, relNorm);
      if (fp.startsWith(path.resolve(baseDir)) && fs.existsSync(fp)) return res.sendFile(fp);
    }
  }
  res.status(404).json({ error: 'not found' });
});

// Draw-specific routes mounted directly
const drawRouter = express.Router();
drawRouter.use(express.json());

// POST /api/draw/recommend
app.post('/api/draw/recommend', (req, res) => {
  const { image_path, reason } = req.body || {};
  if (!image_path) return res.status(400).json({ error: 'need image_path' });
  const recFile = path.join(path.dirname(config.creator_map_file), 'recommendations.json');
  let items: any[] = [];
  try { items = JSON.parse(fs.readFileSync(recFile, 'utf-8')); } catch {}
  const user: any = (req as any).user || {};
  items.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    image_path,
    user_id: user.id || 0,
    user_reason: reason || '',
    status: 'pending',
    timestamp: Date.now() / 1000,
  });
  fs.writeFileSync(recFile, JSON.stringify(items, null, 2), 'utf-8');
  res.json({ ok: true });
});

// GET /api/draw/my-recommendations
app.get('/api/draw/my-recommendations', (req, res) => {
  const user: any = (req as any).user;
  if (!user?.id) return res.status(401).json({ detail: 'unauthorized' });
  const recFile = path.join(path.dirname(config.creator_map_file), 'recommendations.json');
  try {
    const all = JSON.parse(fs.readFileSync(recFile, 'utf-8'));
    const d = all.filter((i: any) => i.user_id === user.id);
    res.json({ items: d, total: d.length });
  } catch { res.json({ items: [], total: 0 }); }
});

// DELETE /api/draw/my-images
app.delete('/api/draw/my-images', (req, res) => {
  const jwt = require('jsonwebtoken');
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let user: any = null;
  try { user = jwt.verify(token, Buffer.from(config.jwt_secret, 'utf-8')); } catch {}
  if (!user?.id) return res.status(401).json({ detail: 'unauthorized' });
  const relPath = req.body?.path as string;
  if (!relPath) return res.status(400).json({ error: 'need path' });
  // Record to deleted list (keep UID and file)
  try {
    const df = path.join(path.dirname(config.creator_map_file), 'deleted_images.json');
    let deleted: string[] = [];
    try { deleted = JSON.parse(fs.readFileSync(df, 'utf-8')); } catch {}
    if (!deleted.includes(relPath)) deleted.push(relPath);
    fs.writeFileSync(df, JSON.stringify(deleted, null, 2), 'utf-8');
  } catch {}
  res.json({ ok: true });
});

// 全局图片压缩（低CPU，sharp/libvips）
const IMG_MIN_SIZE = 50 * 1024; // <50KB 不压缩
async function compressImage(fp: string, req: Request, res: Response): Promise<boolean> {
  try {
    const stat = fs.statSync(fp);
    if (!stat.isFile() || stat.size < IMG_MIN_SIZE) return false;
    const ext = path.extname(fp).toLowerCase();
    const acceptHdr = typeof req.headers?.get === 'function' ? req.headers.get('accept') : req.headers['accept'];
    const preferWebp = (acceptHdr || '').toLowerCase().includes('image/webp');
    const sharp = require('sharp');
    let pipeline = sharp(fp, { animated: ext === '.gif' }).rotate();
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
      if (preferWebp) {
        const buf = await pipeline.webp({ quality: 75, effort: 0 }).toBuffer();
        if (buf.length < stat.size * 0.8) { res.setHeader('Content-Type', 'image/webp'); res.send(buf); return true; }
      } else {
        const buf = await pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
        if (buf.length < stat.size * 0.8) { res.setHeader('Content-Type', 'image/jpeg'); res.send(buf); return true; }
      }
    }
  } catch {}
  return false;
}

// GET /api/image (本地优先，ComfyUI 兜底)
app.get('/api/image', async (req, res) => {
  const filename = req.query.filename as string;
  const subfolder = (req.query.subfolder as string) || '';
  if (!filename) return res.status(400).json({ error: 'need filename' });
  // 先从本地 output 目录找
  const localPath = path.join(config.output_dir, subfolder, filename);
  if (fs.existsSync(localPath)) {
    if (await compressImage(localPath, req, res)) return;
    return res.sendFile(localPath);
  }
  // 本地没有则从 ComfyUI 代理
  try {
    const comfyApi = axios.create({ baseURL: `http://${config.comfyui_host}:${config.comfyui_port}`, timeout: 30000 });
    const resp = await comfyApi.get('/api/view', { params: { filename, subfolder, type: 'output' }, responseType: 'arraybuffer' });
    res.set('Content-Type', resp.headers['content-type'] || 'image/png');
    res.send(resp.data);
  } catch { res.status(404).json({ error: 'image not found' }); }
});

// 原图访问（支持 .blob 后缀）
app.get('/api/uploads/:filename', (req, res) => {
  const fp = path.resolve(path.join(process.cwd(), '..', 'web', 'uploads'), req.params.filename);
  if (!fp.startsWith(path.resolve(path.join(process.cwd(), '..', 'web', 'uploads'))) || !fs.existsSync(fp)) {
    return res.status(404).json({ error: 'not found' });
  }
  const ext = path.extname(fp).toLowerCase();
  const mt: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.blob': 'image/png' };
  if (mt[ext]) res.type(mt[ext]);
  res.sendFile(fp);
});

// POST /api/draw/admin/wf_thumbnail
app.post('/api/draw/admin/wf_thumbnail', (req, res) => {
  const multer = require('multer');
  const upload = multer().single('file');
  upload(req, res, (err: any) => {
    if (err) return res.status(400).json({ error: 'upload failed' });
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: 'no file' });
    const thumbDir = path.join(process.cwd(), '..', 'web', 'thumbnails');
    fs.mkdirSync(thumbDir, { recursive: true });
    const ext = path.extname(file.originalname) || '.png';
    const filename = `wf_${Date.now().toString(36)}${ext}`;
    fs.writeFileSync(path.join(thumbDir, filename), file.buffer);
    res.json({ ok: true, filename });
  });
});

// POST /api/img2img/upload
app.post('/api/img2img/upload', async (req, res) => {
  const multer = require('multer');
  const upload = multer().fields([{ name: 'image1', maxCount: 1 }, { name: 'image2', maxCount: 1 }]);
  upload(req, res, async (err: any) => {
    if (err) return res.status(400).json({ error: 'upload failed' });
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const image1 = files?.image1?.[0];
    const image2 = files?.image2?.[0];
    if (!image1) return res.status(400).json({ error: 'need image1' });
	  if ((image1?.buffer?.length || 0) > 500 * 1024) return res.status(413).json({ error: '图片超过500KB限制，请压缩后上传' });
	  if (image2 && (image2?.buffer?.length || 0) > 500 * 1024) return res.status(413).json({ error: '图片超过500KB限制，请压缩后上传' });

    const uuid = require('uuid');
    let ext1 = (image1.originalname?.split('.').pop()?.toLowerCase()) || '';
	    const mimeExt = image1.mimetype?.split('/').pop() || '';
	    if (!ext1 || ext1 === 'blob' || !['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext1)) {
	      ext1 = (mimeExt === 'jpeg' ? 'jpg' : mimeExt) || 'png';
	    }
    const safeName1 = `img2img_${uuid.v4().replace(/-/g, '').slice(0, 12)}_${Math.floor(Date.now() / 1000)}.${ext1}`;
    // 保存原图到永久目录
    const upDir = path.join(process.cwd(), '..', 'web', 'uploads');
    fs.mkdirSync(upDir, { recursive: true });
    fs.writeFileSync(path.join(upDir, safeName1), image1.buffer);

    try {
      const FormData = require('form-data');
      const fd1 = new FormData();
      fd1.append('image', image1.buffer, { filename: safeName1, contentType: image1.mimetype });
      fd1.append('type', 'input');
      fd1.append('overwrite', 'true');
      const comfyApi = axios.create({ baseURL: `http://${config.comfyui_host}:${config.comfyui_port}`, timeout: 30000 });
      const r1 = await comfyApi.post('/api/upload/image', fd1, { headers: { ...fd1.getHeaders(), 'Comfy-User': '' } });
      const result: any = { ok: true, image1_name: r1.data.name };

      if (image2) {
        const ext2 = image2.originalname?.split('.').pop() || 'png';
        const safeName2 = `img2img_${uuid.v4().replace(/-/g, '').slice(0, 12)}_${Math.floor(Date.now() / 1000)}.${ext2}`;
        fs.writeFileSync(path.join(upDir, safeName2), image2.buffer);
        const fd2 = new FormData();
        fd2.append('image', image2.buffer, { filename: safeName2, contentType: image2.mimetype });
        fd2.append('type', 'input');
        fd2.append('overwrite', 'true');
        const r2 = await comfyApi.post('/api/upload/image', fd2, { headers: { ...fd2.getHeaders(), 'Comfy-User': '' } });
        result.image2_name = r2.data.name;
      }

      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message || 'upload failed' }); }
  });
});

// POST /api/_reset
app.post('/api/_reset', (req, res) => {
  const { setActive, resetActive } = require('./routes/status.js');
  resetActive();
  res.json({ ok: true });
});

// POST /api/translate — LLM 前置翻译
const _translateRate: Record<string, number> = {};
app.post('/api/translate', requireAuth, async (req, res) => {
  const uid = String(req.user?.id || '');
  const now = Date.now();
  if (_translateRate[uid] && now - _translateRate[uid] < 10000) {
    return res.status(429).json({ error: '操作太频繁，请 10 秒后再试' });
  }
  _translateRate[uid] = now;

  // Turnstile verification
  const tsToken = req.body?.turnstile_token;
  if (!tsToken) return res.status(403).json({ detail: '请完成人机验证' });
  try {
    const tsResp = await axios.post('https://challenges.cloudflare.com/turnstile/v0/siteverify',
      new URLSearchParams({ secret: config.turnstile_secret_key, response: tsToken }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!tsResp.data?.success) return res.status(403).json({ detail: '人机验证失败' });
  } catch { return res.status(503).json({ detail: '人机验证服务不可用' }); }

  const { prompt, original_prompt, negative_prompt, mode } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'need prompt' });
  }

  try {
    const { loadConfig, loadJson } = await import('./services/config.js');
    const freshConfig = loadConfig();
    const llmCfg = loadJson(freshConfig.llm_config_file, {});
    const activeProfile = llmCfg.profiles?.[llmCfg.active ?? 0];
    console.log(`[LLM] translate, profile: ${activeProfile?.name || 'unnamed'}, provider: ${activeProfile?.provider || 'local'}, mode: ${mode || 'wai'}`);
    const { translatePrompt } = await import('./services/llm.js');
    const result = await translatePrompt(prompt, original_prompt || undefined, negative_prompt || undefined, freshConfig, undefined, mode === 'anima');
    // Deduct points only on success
    if ((req as any).user?.role !== 'admin') {
      const ptCfg = loadPointsCfg();
      deductPoints((req as any).user?.id, ptCfg.llm_translate);
    }
    res.json({ ok: true, positive: result.positive, negative: result.negative });
  } catch (e: any) {
    res.json({ ok: false, error: (e.message || String(e)).slice(0, 1000) });
  }
});

// WebSocket status
setupWsStatus(wss, config);

const PORT = parseInt(process.env.PORT || config.web_port || '8080');
server.listen(PORT, config.web_host || '0.0.0.0', () => {
  console.log(`Server running on http://${config.web_host || '0.0.0.0'}:${PORT}`);
});
