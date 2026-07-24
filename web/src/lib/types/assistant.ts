export type AssistantMode = 'wife' | 'professional';

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /** 当 role=assistant 且生成了参数卡时存在 */
  card?: GeneratedCard | null;
  /** 生成的图片路径（队列完成后回填） */
  imagePath?: string | null;
  /** 队列状态 */
  queueStatus?: 'idle' | 'queued' | 'running' | 'done' | 'failed';
  queueId?: number;
  queueError?: string;
}

export interface GeneratedCard {
  /** 正向提示词（英文） */
  positivePrompt: string;
  /** 反向提示词（英文） */
  negativePrompt: string;
  /** 用户原始输入（中文） */
  originalPrompt: string;
  /** 推荐的 workflow 路径，如 "WAI/base/none.json" */
  workflowPath: string;
  /** 图像宽度 */
  width: number;
  /** 图像高度 */
  height: number;
  /** 画风标签 */
  styleTags: string;
  /** 模型模式：WAI / Anima / Flux */
  mode: string;
  /** 识别的角色名称 */
  character: string;
  /** 识别的画风名称 */
  style: string;
  /** 助手回复文字 */
  reply: string;
}

export interface ChatRequest {
  prompt: string;
  mode: AssistantMode;
}

export interface ChatResponse {
  success: boolean;
  message: string;
  card?: GeneratedCard | null;
  error?: string;
}

export interface Character {
  name: string;
  lora_file: string;
  trigger_tags: string[];
  model_target: string;
  alternatives: string | null;
}

export type DrawMode = 'WAI' | 'Anima' | 'Flux' | 'Real' | 'Pony';
