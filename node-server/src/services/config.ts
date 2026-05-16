import fs from 'fs';
import path from 'path';
import { Limits, LlmConfig } from '../types/index.js';

export interface AppConfig {
  web_host: string;
  web_port: number;
  jwt_secret: string;
  comfyui_host: string;
  comfyui_port: number;
  comfyui_api: string;
  comfyui_ws: string;
  lms_host: string;
  lms_port: number;
  lms_api: string;
  output_dir: string;
  archive_dir: string;
  thumb_dir: string;
  workflows_dir: string;
  creator_map_file: string;
  limits_file: string;
  llm_config_file: string;
  state_file: string;
}

const here = path.join(process.cwd(), '..', 'web');

export function loadConfig(): AppConfig {
  // 从 .env 文件加载 JWT_SECRET
  let jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret) {
    for (const dir of [here, path.join(here, '..')]) {
      try {
        const envPath = path.join(dir, '.env');
        if (fs.existsSync(envPath)) {
          const envContent = fs.readFileSync(envPath, 'utf-8');
          const match = envContent.match(/^JWT_SECRET="(.+?)"\s*$/m);
          if (match) { jwtSecret = match[1].trim(); break; }
        }
      } catch {}
    }
  }

  return {
    web_host: process.env.WEB_HOST || '0.0.0.0',
    web_port: parseInt(process.env.WEB_PORT || '8080'),
    jwt_secret: jwtSecret,
    comfyui_host: process.env.COMFYUI_HOST || '127.0.0.1',
    comfyui_port: parseInt(process.env.COMFYUI_PORT || '8188'),
    get comfyui_api() { return `http://${this.comfyui_host}:${this.comfyui_port}`; },
    get comfyui_ws() { return `ws://${this.comfyui_host}:${this.comfyui_port}`; },
    lms_host: process.env.LMS_HOST || '127.0.0.1',
    lms_port: parseInt(process.env.LMS_PORT || '1234'),
    get lms_api() { return `http://${this.lms_host}:${this.lms_port}`; },
    output_dir: process.env.OUTPUT_DIR || 'C:\\Users\\acofo\\Desktop\\ComfyUI-WorkFisher-V2\\ComfyUI\\output',
    archive_dir: process.env.ARCHIVE_DIR || 'C:\\Users\\acofo\\Documents\\ComfyUI\\archived_output',
    thumb_dir: path.join(path.join(process.cwd(), '..', 'web'), 'thumbnails'),
    workflows_dir: process.env.COMFYUI_WORKFLOWS_DIR || 'C:\\Users\\acofo\\Desktop\\ComfyUI-WorkFisher-V2\\ComfyUI\\user\\default\\workflows',
    creator_map_file: path.join(here, 'creator_users.txt'),
    limits_file: path.join(here, 'limits.json'),
    llm_config_file: path.join(here, 'llm_config.json'),
    state_file: path.join(here, 'state.json'),
  };
}

export function loadJson<T>(filePath: string, defaults: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {}
  return defaults;
}

export function saveJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export const DEFAULT_LIMITS: Limits = {
  gen_cooldown_sec: 30,
  gen_cooldown_after_sec: 30,
  max_queue_per_user: 1,
  image_rate_window_sec: 60,
  image_rate_max: 120,
  report_window_sec: 300,
  report_window_max: 3,
  report_pending_max: 10,
  gpu_poll_interval_ms: 5000,
  gpu_cache_ttl_ms: 5000,
  gc_interval_hours: 6,
  category_order: [],
};

export function loadLimits(filePath: string): Limits {
  return loadJson(filePath, DEFAULT_LIMITS);
}
