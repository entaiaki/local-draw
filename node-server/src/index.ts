import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { jwtAuth } from './middleware/auth.js';
import { queueRouter } from './routes/queue.js';
import { imageRouter } from './routes/images.js';
import { adminRouter } from './routes/admin.js';
import { workflowRouter } from './routes/workflow.js';
import { statusRouter, setupWsStatus } from './routes/status.js';
import { loadConfig } from './services/config.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/status' });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Config
const config = loadConfig();

// Auth middleware
app.use('/api/draw', jwtAuth(config));

// Routes
app.use('/api/draw', queueRouter);
app.use('/api/output', imageRouter);
app.use('/api/draw/admin', adminRouter);
app.use('/api/draw', statusRouter);
app.use('/api/workflow', workflowRouter);

// Health check
app.get('/api/_diag', (req, res) => {
  res.json({ active_count: 0, active_status: null, subscribers: wss.clients.size });
});

// Additional API routes
app.get('/api/resolutions', (req, res) => {
  res.json({ presets: [
    { label: '512×512', w: 512, h: 512 }, { label: '768×768', w: 768, h: 768 },
    { label: '1024×1024', w: 1024, h: 1024 }, { label: '1216×832', w: 1216, h: 832 },
    { label: '832×1216', w: 832, h: 1216 },
  ]});
});

app.get('/api/styles', (req, res) => {
  const sf = path.join(path.dirname(config.creator_map_file), 'styles.json');
  try { res.json(JSON.parse(fs.readFileSync(sf, 'utf-8'))); } catch { res.json({ styles: [] }); }
});

app.get('/api/thumbnail', (req, res) => {
  const p = req.query.path as string;
  if (!p) return res.status(404).json({ error: 'no thumbnail' });
  // Check thumbnails dir first
  const thumbDir = config.thumb_dir || path.join(process.cwd(), '..', 'web', 'thumbnails');
  const thumbPath = path.join(thumbDir, path.basename(p));
  if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath);
  // Fallback: serve original from output dir
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
  items.push({ image_path, reason: reason || '', status: 'pending', created_at: Date.now() / 1000 });
  fs.writeFileSync(recFile, JSON.stringify(items, null, 2), 'utf-8');
  res.json({ ok: true });
});

// GET /api/draw/my-recommendations
app.get('/api/draw/my-recommendations', (req, res) => {
  const recFile = path.join(path.dirname(config.creator_map_file), 'recommendations.json');
  try { const d = JSON.parse(fs.readFileSync(recFile, 'utf-8')); res.json({ items: d, total: d.length }); }
  catch { res.json({ items: [], total: 0 }); }
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
  const file = config.creator_map_file;
  try {
    if (fs.existsSync(file)) {
      let lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
      lines = lines.filter(l => !l.startsWith(relPath + '\t'));
      fs.writeFileSync(file + '.tmp', lines.join('\n') + '\n', 'utf-8');
      fs.renameSync(file + '.tmp', file);
    }
  } catch {}
  res.json({ ok: true });
});

// GET /api/image (本地优先，ComfyUI 兜底)
app.get('/api/image', async (req, res) => {
  const filename = req.query.filename as string;
  const subfolder = (req.query.subfolder as string) || '';
  if (!filename) return res.status(400).json({ error: 'need filename' });
  // 先从本地 output 目录找
  const localPath = path.join(config.output_dir, subfolder, filename);
  if (fs.existsSync(localPath)) return res.sendFile(localPath);
  // 本地没有则从 ComfyUI 代理
  try {
    const comfyApi = axios.create({ baseURL: `http://${config.comfyui_host}:${config.comfyui_port}`, timeout: 30000 });
    const resp = await comfyApi.get('/api/view', { params: { filename, subfolder, type: 'output' }, responseType: 'arraybuffer' });
    res.set('Content-Type', resp.headers['content-type'] || 'image/png');
    res.send(resp.data);
  } catch { res.status(404).json({ error: 'image not found' }); }
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

    const uuid = require('uuid');
    const ext1 = image1.originalname?.split('.').pop() || 'png';
    const safeName1 = `img2img_${uuid.v4().replace(/-/g, '').slice(0, 12)}_${Math.floor(Date.now() / 1000)}.${ext1}`;

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

// WebSocket status
setupWsStatus(wss, config);

const PORT = parseInt(process.env.PORT || config.web_port || '8080');
server.listen(PORT, config.web_host || '0.0.0.0', () => {
  console.log(`Server running on http://${config.web_host || '0.0.0.0'}:${PORT}`);
});
