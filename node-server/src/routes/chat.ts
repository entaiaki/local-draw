import { Router, Request, Response } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { loadConfig, loadJson } from '../services/config.js';
import { streamChat, callGoogle } from '../services/llm.js';
import { deductPoints, refundPoints, loadPointsCfg } from './wallet.js';
import { queueItems, queuedUserIds, saveQueueState } from './queue.js';
import type { QueueItem } from '../types/index.js';

const router = Router();
const config = loadConfig();

const CHAT_SYSTEM_TEMPLATE = `{role_setup}

你可以在对话中自然地生成图片。在回复中插入生图标记：
[GEN: 英文Danbooru tags, 用逗号分隔]

重要：[GEN: ...] 标记是系统指令，用户完全看不到它。不要在文字中提及、解释或引用 [GEN:] 标记。

生图规则：
- 每说完一句话（以句号、感叹号、问号等结束），立即插入对应的 [GEN: ...] 标记
- 每句对话都配一张图，不要跳过
- tags 用英文 Danbooru 格式，描述当前这句话对应的画面
- CRITICAL: [GEN: ...] 中的 tags 必须以角色自身的 tag 开头（如角色名、外观特征），然后才是动作、表情、场景等。角色 tag 不能省略或删除
- 以角色扮演的方式自然回复，[GEN:] 标记穿插在文本中，但用户看不到它们

当前工作流自带提示词：{workflow_prompt}

负面提示词参考：{negative_ref}`;

interface ChatRequestBody {
  message: string;
  workflow_path?: string;
  style_tags?: string;
  system_prompt: string;
  negative_prompt?: string;
  history: Array<{ role: string; content: string }>;
}

function getActiveProfile(): Record<string, any> {
  const d = loadJson<any>(config.llm_config_file, {});
  const profiles = d.profiles || [];
  const active = d.active ?? 0;
  return profiles[active] || {};
}

// POST /api/draw/chat — SSE
router.post('/chat', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token, config.jwt_secret);
  if (!user) return res.status(401).json({ detail: '论坛登录凭证已过期，请刷新页面或重新登录' });
  if (user.role !== 'admin' && user.role !== 'user') return res.status(403).json({ detail: '已禁止使用酒馆' });

  const body = req.body as ChatRequestBody;
  if (!body.system_prompt?.trim()) return res.status(400).json({ detail: '请填写角色设定' });
  if (!body.message?.trim()) return res.status(400).json({ detail: '消息不能为空' });

  // 读取工作流自带的 builtin prompt
  let workflowPrompt = '(无)';
  if (body.workflow_path) {
    try {
      const { workflowToPromptApi } = await import('../services/runner.js');
      const fs = await import('fs');
      const path = await import('path');
      const wfPath = path.join(config.workflows_dir, body.workflow_path);
      if (fs.existsSync(wfPath)) {
        const wfData = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));
        const { positive_ref } = workflowToPromptApi(wfData);
        if (positive_ref) {
          const [nid, inp] = positive_ref;
          const v = wfData?.[nid]?.inputs?.[inp];
          if (typeof v === 'string' && v.trim()) workflowPrompt = v.trim();
        }
      }
    } catch {}
  }

  const negRef = body.negative_prompt?.trim() || 'worst quality, low quality, blurry';
  const systemContent = CHAT_SYSTEM_TEMPLATE
    .replace('{role_setup}', body.system_prompt.trim())
    .replace('{workflow_prompt}', workflowPrompt)
    .replace('{negative_ref}', negRef);

  const messages: Array<{ role: string; content: string }> = [];
  for (const h of body.history || []) {
    messages.push({ role: h.role, content: h.content });
  }
  // system prompt 拼入 user 消息（与文生图 callOpenAI 保持一致）
  messages.push({ role: 'user', content: systemContent + '\n\n' + body.message });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function send(event: string, data: unknown) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const cfg = getActiveProfile();
  const provider = cfg.provider || 'custom';

  let endpoint = '';
  let apiKey = '';
  let model = '';
  if (provider === 'google') {
    // Google 不支持流式 chat，回退到非流式
    endpoint = '';
    apiKey = cfg.google_api_key || '';
    model = cfg.google_model || '';
  } else if (provider === 'custom') {
    endpoint = (cfg.custom_endpoint || '').replace(/\/+$/, '');
    apiKey = cfg.custom_api_key || '';
    model = cfg.custom_model || '';
  } else {
    endpoint = (cfg.local_endpoint || config.lms_api || '').replace(/\/+$/, '');
  }

  try {
    let fullText = '';

    if (provider === 'google') {
      // Google: 非流式调用（system + history + user 拼成一条 user 消息）
      let historyText = '';
      for (const h of body.history || []) {
        historyText += `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}\n`;
      }
      const googleUserMsg = historyText + systemContent + '\n\n' + body.message;
      try {
        fullText = await callGoogle('', googleUserMsg, cfg);
      } catch (e: any) {
        send('error', { message: e.message || 'LLM 调用失败' });
        send('done', {});
        res.end();
        return;
      }
      // 一次性发送全部文本（过滤 [GEN:]）
      const cleanText = fullText.replace(/\s*\[GEN:\s*.+?\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleanText) send('text', { content: cleanText });
    } else {
      // OpenAI 兼容: 流式调用
      let lastCleanLen = 0;
      try {
        await streamChat(messages, endpoint, apiKey, model, (delta) => {
          fullText += delta;
          const cleanFull = fullText
            .replace(/\s*\[GEN:\s*.+?\]\s*/g, '')
            .replace(/\s*\[GEN:\s*[^\]]*$/, '');
          const cleanDelta = cleanFull.slice(lastCleanLen);
          if (cleanDelta) {
            send('text', { content: cleanDelta });
            lastCleanLen = cleanFull.length;
          }
        });
      } catch (e: any) {
        send('error', { message: e.message || 'LLM 调用失败' });
        send('done', {});
        res.end();
        return;
      }
    }

    // 提取所有 [GEN: tags]
    const genRegex = /\[GEN:\s*(.+?)\]/g;
    const genTagsList: string[] = [];
    let m;
    while ((m = genRegex.exec(fullText)) !== null) {
      genTagsList.push(m[1].trim());
    }

    // 批量入队
    if (genTagsList.length > 0 && body.workflow_path) {
      let queueIdCounter = queueItems.length > 0 ? Math.max(...queueItems.map(q => q.id)) : 0;
      const pointsCfg = loadPointsCfg();
      const costPer = pointsCfg.text_to_image || 0;

      for (let idx = 0; idx < genTagsList.length; idx++) {
        const tags = genTagsList[idx];
        const finalPrompt = body.style_tags?.trim()
          ? `${body.style_tags.trim()}, ${tags}`
          : tags;

        // 扣点
        let deducted = 0;
        if (costPer > 0) {
          const r = await deductPoints(user.id, costPer);
          if (!r.ok) {
            send('error', { message: `生图 #${idx + 1} 扣点失败: 余额不足` });
            continue;
          }
          deducted = costPer;
        }

        queueIdCounter++;
        const itemId = queueIdCounter;
        const item: QueueItem = {
          id: itemId,
          user_id: user.id,
          params: {
            direct_prompt: finalPrompt,
            workflow_path: body.workflow_path,
            style_tags: '',
            negative_prompt: body.negative_prompt || 'worst quality, low quality, blurry',
          },
          status: 'pending',
          created_at: Date.now() / 1000,
          started_at: null,
          finished_at: null,
          error: null,
        };
        queueItems.push(item);
        queuedUserIds[user.id] = (queuedUserIds[user.id] || 0) + 1;
        saveQueueState();

        send('gen_queued', { tags, item_id: itemId, index: idx, total: genTagsList.length });

        // 启动后台 runner
        (async () => {
          try {
            const { runQueueTask } = await import('../services/runner.js');
            await runQueueTask(item);
          } catch {}
        })();
      }
    }

    send('done', {});
  } catch (e: any) {
    send('error', { message: e.message || '未知错误' });
    send('done', {});
  }

  res.end();
});

export { router as chatRouter };
