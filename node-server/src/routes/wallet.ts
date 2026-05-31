import express, { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { loadConfig, loadJson, saveJson } from '../services/config.js';
import { queryPaidByRemark } from '../services/aifadian.js';

const router = Router();
router.use(express.json());

const config = loadConfig();
const HERE = path.dirname(config.creator_map_file);

// Serialization lock for wallet writes (prevents V2 race condition)
let walletLock = Promise.resolve();
function withWalletLock<T>(fn: () => T): Promise<T> {
  let release: () => void;
  const prev = walletLock;
  walletLock = new Promise(r => { release = r; });
  return prev.then(() => { try { return fn(); } finally { release(); } });
}

function walletFile() { return path.join(HERE, 'wallets.json'); }
function ordersFile() { return path.join(HERE, 'orders.json'); }
function pointsConfigFile() { return path.join(HERE, 'points_config.json'); }

const DEFAULT_POINTS_CONFIG = { text_to_image: 10, image_to_image: 100, llm_translate: 1, signup_bonus: 0, text_to_image_anima: 20, tts_generate: 5 };

interface Wallet {
  balance: number;
  total_purchased: number;
}
interface Order {
  order_id: string;
  user_id: number;
  plan_id: string;
  amount: number; // yuan
  points: number;
  status: 'pending' | 'paid' | 'failed';
  remark: string;
  created_at: number;
  paid_at?: number;
}

function loadWallets(): Record<number, Wallet> { return loadJson(walletFile(), {}); }
function saveWallets(d: Record<number, Wallet>) { saveJson(walletFile(), d); }
function loadOrders(): Order[] { return loadJson(ordersFile(), []); }
function saveOrders(d: Order[]) { saveJson(ordersFile(), d); }
export function loadPointsConfig(): typeof DEFAULT_POINTS_CONFIG {
  return loadJson(pointsConfigFile(), DEFAULT_POINTS_CONFIG);
}
function savePointsConfig(d: any) { saveJson(pointsConfigFile(), d); }

function getUserId(req: Request): number | null {
  const user = (req as any).user;
  return user?.id || null;
}

function creatorUserIds(): Set<number> {
  const ids = new Set<number>();
  try {
    const f = path.join(HERE, 'creator_users.txt');
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
        const parts = line.trim().split('\t');
        if (parts.length === 2 && /^\d+$/.test(parts[1].trim())) ids.add(Number(parts[1].trim()));
      }
    }
  } catch {}
  return ids;
}

// GET /api/wallet/balance
router.get('/balance', async (req: Request, res: Response) => {
  const uid = getUserId(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  // Auto-create wallet, give signup bonus if configured
  let wallets = loadWallets();
  const ptsCfg = loadPointsConfig();
  const bonus = ptsCfg.signup_bonus || 0;

  if (!wallets[uid]) {
    wallets[uid] = { balance: bonus, total_purchased: bonus };
    saveWallets(wallets);
    if (bonus > 0) console.log(`[wallet] signup bonus uid=${uid} bonus=${bonus}`);
    wallets = loadWallets();
  } else if (bonus > 0 && wallets[uid].balance === 0 && wallets[uid].total_purchased === 0) {
    // Retroactively grant bonus to users who had 0/0 wallets from scanner
    wallets[uid].balance = bonus;
    wallets[uid].total_purchased = bonus;
    saveWallets(wallets);
    console.log(`[wallet] signup bonus (retro) uid=${uid} bonus=${bonus}`);
    wallets = loadWallets();
  }
  const wallet = wallets[uid] || { balance: 0, total_purchased: 0 };

  // Poll aifadian for paid orders matching this user's remark (UID)
  const aifadianUserId = process.env.AIFADIAN_USER_ID || '';
  const aifadianToken = process.env.AIFADIAN_API_KEY || '';
  console.log(`[wallet] balance check uid=${uid} aifadianCfg=${!!(aifadianUserId && aifadianToken)}`);
  if (aifadianUserId && aifadianToken) {
    const result = await queryPaidByRemark(String(uid), aifadianUserId, aifadianToken);
    console.log(`[wallet] aifadian result ec=${result.ec} orders=${result.orders?.length} error=${result.error || 'none'}`);
    if (result.ec === 200 && result.orders.length > 0) {
      const orders = loadOrders();
      let changed = false;
      for (const paidOrder of result.orders) {
        const existing = orders.find((o) => o.order_id === paidOrder.out_trade_no && o.status === 'paid');
        console.log(`[wallet] order ${paidOrder.out_trade_no} existing=${!!existing} status=${paidOrder.status}`);
        if (existing) continue;
        // Credit points — multiply by sku count (support multi-unit purchases)
        let pts = 0;
        const skus = paidOrder.sku_detail || [];
        if (skus.length > 0) {
          for (const sku of skus) pts += (sku.count || 1) * 6000;
        } else {
          pts = 6000;
        }
        wallet.balance = (wallet.balance || 0) + pts;
        wallet.total_purchased = (wallet.total_purchased || 0) + pts;
        orders.push({
          order_id: paidOrder.out_trade_no,
          user_id: uid,
          plan_id: '',
          amount: 0,
          points: pts,
          status: 'paid',
          remark: String(uid),
          created_at: Date.now() / 1000,
          paid_at: Math.floor(Date.now() / 1000),
        });
        changed = true;
      }
      if (changed) {
        saveOrders(orders);
        wallets[uid] = wallet;
        saveWallets(wallets);
        console.log(`[wallet] credited uid=${uid} newBalance=${wallet.balance}`);
      }
    }
  }

  res.json({ balance: wallet.balance || 0, total_purchased: wallet.total_purchased || 0 });
});

// POST /api/wallet/create-order
router.post('/create-order', (req: Request, res: Response) => {
  const uid = getUserId(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  const { pay_url: planUrl, points } = req.body || {};
  if (!planUrl) return res.status(400).json({ error: 'need pay_url' });

  const orderId = 'order_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  const order: Order = {
    order_id: orderId,
    user_id: uid,
    plan_id: '',
    amount: 0,
    points: Number(points) || 0,
    status: 'pending',
    remark: String(uid),
    created_at: Date.now() / 1000,
  };

  const orders = loadOrders();
  orders.push(order);
  saveOrders(orders);

  const payUrl = planUrl.replace('remark=1', `remark=${uid}`) + `&custom_order_id=${uid}`;
  res.json({ pay_url: payUrl, order_id: orderId, points: order.points });
});

// GET /api/wallet/plans (public)
router.get('/plans', (req: Request, res: Response) => {
  const pf = path.join(HERE, 'plans.json');
  const plans = loadJson<any[]>(pf, []);
  res.json({ items: plans });
});

// GET /api/wallet/points-config (public)
router.get('/points-config', (req: Request, res: Response) => {
  const cfg = loadPointsConfig();
  const limits = loadJson<Record<string, any>>(path.join(HERE, 'limits.json'), {});
  (cfg as any).turnstile_enabled = limits.turnstile_enabled !== false;
  res.json(cfg);
});

// GET /api/wallet/orders
router.get('/orders', (req: Request, res: Response) => {
  const uid = getUserId(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  const orders = loadOrders().filter((o) => o.user_id === uid);
  res.json({ items: orders });
});

// Deduct points (internal)
export async function deductPoints(userId: number, cost: number): Promise<{ ok: boolean; balance?: number; error?: string }> {
  if (cost <= 0) return { ok: true };
  return withWalletLock(() => {
    const wallets = loadWallets();
    const w = wallets[userId];
    if (!w || (w.balance || 0) < cost) {
      return { ok: false, error: '点数不足', balance: w?.balance || 0 };
    }
    w.balance -= cost;
    wallets[userId] = w;
    saveWallets(wallets);
    return { ok: true, balance: w.balance };
  });
}

// Refund points on failure (internal)
export async function refundPoints(userId: number, cost: number): Promise<void> {
  if (cost <= 0) return;
  return withWalletLock(() => {
    const wallets = loadWallets();
    const w = wallets[userId];
    if (w) {
      w.balance = (w.balance || 0) + cost;
      saveWallets(wallets);
      console.log(`[wallet] refund uid=${userId} cost=${cost} newBalance=${w.balance}`);
    }
  });
}

export { router as walletRouter };
export { loadPointsConfig as loadPointsCfg };
export { creatorUserIds };
