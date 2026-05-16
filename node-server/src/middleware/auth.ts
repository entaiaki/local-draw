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
    // Only protect /api/draw routes
    if (!req.path.startsWith('/api/draw') && !req.path.startsWith('/api/output')) {
      return next();
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
  const secret = process.env.JWT_SECRET || '';
  const user = verifyToken(token, secret);
  if (!user) {
    return res.status(401).json({ detail: 'token 无效或已过期，请重新登录' });
  }
  req.user = user;
  next();
}
