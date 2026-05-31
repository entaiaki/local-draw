export interface UserPayload {
  id: number;
  role: string;
  email: string;
}

export interface DrawApiErrorPayload {
  code?: string;
  message?: string;
  error?: string;
  detail?: string;
}

export interface QueueItem {
  id: number;
  user_id: number;
  params: Record<string, unknown>;
  status: 'pending' | 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}

export interface RunRequest {
  workflow_path: string;
    turnstile_token?: string;
  inline_workflow?: Record<string, unknown>;
    inline_workflow_api?: Record<string, any>;
  direct_prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  style_tags?: string;
  seed?: number;
  image1_name?: string;
  image2_name?: string;
  denoise?: number;
}

export interface Limits {
  gen_cooldown_sec: number;
  gen_cooldown_after_sec: number;
  max_queue_per_user: number;
  image_rate_window_sec: number;
  image_rate_max: number;

  llm_cooldown_sec: number;
  gc_interval_hours: number;
  category_order: string[];
  turnstile_enabled?: boolean;
}

export interface LlmProfile {
  name?: string;
  provider: 'local' | 'google' | 'custom';
  local_endpoint?: string;
  google_api_key?: string;
  google_model?: string;
  google_thinking?: string;
  custom_endpoint?: string;
  custom_api_key?: string;
  custom_model?: string;
  llm_stream?: boolean;
}

export interface LlmConfig {
  profiles: LlmProfile[];
  active: number;
}

export interface WsStatusMessage {
  type: 'status' | 'online';
  online?: number;
  active?: number;
  busy?: boolean;
  stage?: string;
  node?: string;
  value?: number;
  max?: number;
  started_at?: number;
  prompt_id?: string;
  final_prompt?: string;
  done?: number;
  total?: number;
}
