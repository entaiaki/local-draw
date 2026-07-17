export type DrawApiEnv = 'prod' | 'dev';

export interface DrawApiErrorPayload {
  code?: string;
  message?: string;
  error?: string;
  detail?: string;
}

export class DrawApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, payload: DrawApiErrorPayload = {}) {
    super(payload.detail || payload.message || payload.error || `生图请求失败（${status}）`);
    this.name = 'DrawApiError';
    this.status = status;
    this.code = payload.code;
  }
}

// --- API response types ---

export interface DrawWorkflow {
  path: string;
  name: string;
  thumbnail: boolean;
  category: string;
}

export interface DrawWorkflowsResponse {
  workflows: DrawWorkflow[];
  category_order: string[];
}

export interface DrawWorkflowDetail {
  builtin_prompt: string;
  builtin_negative_prompt: string;
  [key: string]: any;
}

export interface DrawStyle {
  name: string;
  tags: string;
  image?: string;
  thumbnail_url?: string;
}

export interface DrawStylesResponse {
  styles: DrawStyle[];
}

export interface DrawResolution {
  w: number;
  h: number;
  label?: string;
}

export interface DrawResolutionsResponse {
  presets: DrawResolution[];
}

export interface DrawOutputItem {
  path: string;
  mtime: number;
  size?: number;
  creator_id?: string;
}

export interface DrawRecommendation {
  id: string;
  image_path: string;
  user_id: number;
  timestamp: number;
  status: 'pending' | 'approved' | 'rejected';
  user_reason?: string | null;
  admin_reason?: string | null;
}

export interface DrawOutputListResponse {
  output_dir: string;
  archive_dir: string;
  exists: boolean;
  total: number;
  items: DrawOutputItem[];
}

export interface DrawFeaturedResponse {
  items: DrawOutputItem[];
  total: number;
}

export interface Nomination {
  id: string;
  image_paths: string[];
  collaborator_id: number;
  status: 'pending' | 'approved' | 'rejected';
  submitted_at: number;
  note?: string;
  reviewed_by?: number | null;
  reviewed_at?: number | null;
  admin_reason?: string | null;
}

export interface DrawTranslateResponse {
  text: string;
  negative: string;
}

// --- WebSocket message types ---

export interface WsLogMessage {
  type: 'log';
  message: string;
}

export interface WsLlmStartMessage {
  type: 'llm_start';
}

export interface WsLlmChunkMessage {
  type: 'llm_chunk';
  delta: string;
}

export interface WsLlmDoneMessage {
  type: 'llm_done';
  text: string;
  negative?: string;
}

export interface WsProgressMessage {
  type: 'progress';
  node: string;
  value: number;
  max: number;
  done: number;
  total: number;
}

export interface WsPromptIdMessage {
  type: 'prompt_id';
  prompt_id: string;
  final_prompt: string;
}

export interface WsPreviewMessage {
  type: 'preview';
  image: string;
}

export interface WsImageMessage {
  type: 'image';
  url: string;
  filename: string;
  subfolder: string;
  image_type: string;
}

export interface WsDoneMessage {
  type: 'done';
  final_prompt: string;
  count: number;
}

export interface WsCostMessage {
  type: 'cost';
  kwh: number;
  cost: number;
}

export interface WsErrorMessage {
  type: 'error';
  message: string;
}

export interface WsStatusMessage {
  type: 'status';
  online: number;
  busy: boolean;
  active: number;
  stage?: string;
  workflow?: string;
  node?: string;
  value?: number;
  max?: number;
  prompt_id?: string;
  item_id?: number;
}

export interface WsOnlineMessage {
  type: 'online';
  count: number;
}


export type WsRunMessage =
  | WsLogMessage
  | WsLlmStartMessage
  | WsLlmChunkMessage
  | WsLlmDoneMessage
  | WsProgressMessage
  | WsPromptIdMessage
  | WsPreviewMessage
  | WsImageMessage
  | WsDoneMessage
  | WsCostMessage
  | WsErrorMessage;

export type WsStatusEvent =
  | WsStatusMessage
  | WsOnlineMessage

export interface WsRunPayload {
  token: string;
  workflow_path: string;
  inline_workflow?: object | null;
  direct_prompt: string;
  width?: number | null;
  height?: number | null;
  style_tags?: string;
  negative_prompt?: string;
  seed?: number;
  image1_name?: string;
  image2_name?: string;
  denoise?: number;
  reverse_push?: boolean;
}

// --- Admin types ---

export interface AdminRecentImage {
  path: string;
  user_id: string;
  mtime: number;
  deleted?: boolean;
  prompt?: string;
  negative_prompt?: string;
  image1?: string;
  image2?: string;
}

export interface AdminLimits {
  gen_cooldown_sec: number;
  gen_cooldown_after_sec: number;
  max_queue_per_user: number;
  image_rate_window_sec: number;
  image_rate_max: number;
  report_window_sec: number;
  report_window_max: number;
  report_pending_max: number;
  gpu_poll_interval_ms: number;
  gpu_cache_ttl_ms: number;
  gc_interval_hours: number;
  category_order: string[];
  turnstile_enabled?: boolean;
}

export interface AdminAnnouncement {
  enabled: boolean;
  title: string;
  content: string;
}

export interface AdminGcResult {
  ok: boolean;
  cleaned: Record<string, number>;
}

export interface AdminLlmProfile {
  name: string;
  provider: 'google' | 'custom';
  local_endpoint?: string;
  google_api_key?: string;
  google_model?: string;
  google_thinking?: string;
  custom_endpoint?: string;
  custom_api_key?: string;
  custom_model?: string;
  llm_stream?: boolean;
}

export interface Preset {
  id: string;
  name: string;
  content: string;
  type: 'positive' | 'negative';
}

export interface AdminLlmConfig {
  profiles: AdminLlmProfile[];
  active: number;
}

export interface LoraApplication {
  id: string;
  user_id: number;
  url: string;
  name: string;
  category: string;
  trigger: string;
  type: 'WAI' | 'Anima';
  status: 'pending' | 'approved' | 'rejected';
  created_at: number;
  reviewed_by?: number | null;
  reviewed_at?: number | null;
  admin_reason?: string | null;
}
