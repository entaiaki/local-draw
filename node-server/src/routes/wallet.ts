import express, { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { loadConfig, loadJson, saveJson } from '../services/config.js';
import { queryOrder } from '../services/aifadian.js';

const router = Router();
router.use(express.json());

const config = loadConfig();
const HERE = path.dirname(config.creator_map_file);

function walletFile() { return path.join(HERE, 'wallets.json'); }
function ordersFile() { return path.join(HERE, 'orders.json'); }
function pointsConfigFile() { return path.join(HERE, 'points_config.json'); }

const DEFAULT_POINTS_CONFIG = { text_to_image: 10, image_to_image: 100, llm_translate: 1 };

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

// GET /api/wallet/balance
router.get('/balance', async (req: Request, res: Response) => {
  const uid = getUserId(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  const wallets = loadWallets();
  const wallet = wallets[uid] || { balance: 0, total_purchased: 0 };

  // Check pending orders - poll aifadian
  const orders = loadOrders();
  const pending = orders.filter((o) => o.user_id === uid && o.status === 'pending');
  if (pending.length > 0) {
    const aifadianUserId = process.env.AIFADIAN_USER_ID || '';
    const aifadianToken = process.env.AIFADIAN_API_KEY || '';
    if (aifadianUserId && aifadianToken) {
      for (const order of pending) {
        const result = await queryOrder(order.order_id, aifadianUserId, aifadianToken);
        if (result.order?.status === 2) {
          order.status = 'paid';
          order.paid_at = Math.floor(Date.now() / 1000);
          wallet.balance = (wallet.balance || 0) + order.points;
          wallet.total_purchased = (wallet.total_purchased || 0) + order.points;
        }
      }
      saveOrders(orders);
      if (wallet.balance > 0 || wallet.total_purchased > 0) {
        wallets[uid] = wallet;
        saveWallets(wallets);
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

  const payUrl = planUrl.replace('remark=1', `remark=${uid}`);
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
  res.json(loadPointsConfig());
});

// GET /api/wallet/orders
router.get('/orders', (req: Request, res: Response) => {
  const uid = getUserId(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  const orders = loadOrders().filter((o) => o.user_id === uid);
  res.json({ items: orders });
});

// Deduct points (internal, called from queue.ts and index.ts)
export function deductPoints(userId: number, cost: number): { ok: boolean; balance?: number; error?: string } {
  if (cost <= 0) return { ok: true };
  const wallets = loadWallets();
  const w = wallets[userId];
  if (!w || (w.balance || 0) < cost) {
    return { ok: false, error: '点数不足', balance: w?.balance || 0 };
  }
  w.balance -= cost;
  wallets[userId] = w;
  saveWallets(wallets);
  return { ok: true, balance: w.balance };
}

export { router as walletRouter };
export { loadPointsConfig as loadPointsCfg };
