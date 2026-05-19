import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { AppConfig } from '../services/config.js';
import { UserPayload } from '../types/index.js';

declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
}

export function jwtAuth(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token) {
      const secret = loadSecret();
      const user = verifyToken(token, secret);
      if (user) {
        const banErr = checkBan(user.id);
        if (banErr) return res.status(403).json(banErr);
      }
    }
    next();
  };
}

export function verifyToken(token: string, secret: string): UserPayload | null {
  try {
    const decoded = jwt.verify(token, Buffer.from(secret, 'utf-8')) as any;
    if (decoded && decoded.id && decoded.role && decoded.email) {
      return { id: decoded.id, role: decoded.role, email: decoded.email };
    }
  } catch {}
  return null;
}

function loadSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    const envPath = path.join(process.cwd(), '..', '.env');
    if (fs.existsSync(envPath)) {
      const m = fs.readFileSync(envPath, 'utf-8').match(/^JWT_SECRET="(.+?)"\s*$/m);
      if (m) return m[1].trim();
    }
  } catch {}
  return '';
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const secret = loadSecret();
  const user = verifyToken(token, secret);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ detail: '需要管理员权限' });
  }
  req.user = user;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const secret = loadSecret();
  const user = verifyToken(token, secret);
  if (!user) {
    return res.status(401).json({ detail: '论坛登录凭证已过期，请刷新页面或重新登录' });
  }
  req.user = user;
  // Check ban status
  const banErr = checkBan(user.id);
  if (banErr) return res.status(403).json(banErr);
  next();
}

interface BanEntry {
  user_id: number;
  reason: string;
  banned_at: number;
  banned_until: number;
}

export function loadBans(): BanEntry[] {
  try {
    const f = path.join(process.cwd(), '..', 'web', 'banned_users.txt');
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
      // 旧格式 [id, id] -> 新格式
      if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'number') {
        const migrated = raw.map((id: number) => ({
          user_id: id,
          reason: '违规行为',
          banned_at: Math.floor(Date.now() / 1000) - 86400 * 365,
          banned_until: Math.floor(Date.now() / 1000) + 86400 * 365,
        }));
        saveBans(migrated);
        return migrated;
      }
      return raw;
    }
  } catch {}
  return [];
}

export function saveBans(bans: BanEntry[]): void {
  const f = path.join(process.cwd(), '..', 'web', 'banned_users.txt');
  fs.writeFileSync(f, JSON.stringify(bans, null, 2), 'utf-8');
}

export function checkBan(userId: number): { detail: string; code: string; reason: string; banned_until: number } | null {
  const now = Math.floor(Date.now() / 1000);
  let bans = loadBans();
  let changed = false;
  // Remove expired bans
  const active = bans.filter(b => {
    if (b.banned_until <= now) { changed = true; return false; }
    return true;
  });
  if (changed) saveBans(active);
  const ban = active.find(b => b.user_id === userId);
  if (!ban) return null;
  const remaining = Math.max(1, Math.ceil((ban.banned_until - now) / 86400));
  return {
    detail: `您已被封禁，原因：${ban.reason}，还有 ${remaining} 天解封`,
    code: 'USER_BANNED',
    reason: ban.reason,
    banned_until: ban.banned_until,
  };
}
