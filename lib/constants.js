/**
 * 协议常量与插件默认值。
 *
 * 这里是 App ↔ 插件之间唯一共享的枚举白名单：App 只应把这里的值映射成
 * 动画/卡片状态，插件也只返回这些值，避免模型输出直接驱动 UI。
 */

export const PLUGIN_VERSION = '0.8.0';

/** Companion API 的协议版本；App 不兼容时应拒绝整轮对话。 */
export const SCHEMA_VERSION = 1;

/** 心情与表情枚举（App 映射到安全动画）。 */
export const EMOTIONS = Object.freeze([
  'idle',
  'happy',
  'angry',
  'cute',
  'coquettish',
  'concerned',
  'sleepy',
  'working',
  'thinking',
  'proud'
]);

/** 动作白名单；App 不认识的动作品回落成 none。 */
export const ACTIONS = Object.freeze([
  'none',
  'nod',
  'shake',
  'wave',
  'tilt',
  'hop',
  'stretch',
  'doze',
  'ponder',
  'pat'
]);

/** 记忆候选类型；只会作为「建议」返回，是否写入由 App 决定。 */
export const MEMORY_KINDS = Object.freeze(['preference', 'fact', 'event', 'relationship']);

/** 成长信号类型；数值含义由 App 决定。 */
export const GROWTH_TYPES = Object.freeze([
  'chat',
  'task_completed',
  'task_failed',
  'praised',
  'companion_interaction'
]);

export const TASK_KINDS = Object.freeze(['chat', 'file', 'command']);
export const TASK_STATUSES = Object.freeze([
  'queued',
  'running',
  'waiting-approval',
  'succeeded',
  'failed',
  'cancelled'
]);

export const DEFAULT_OPTIONS = Object.freeze({
  enabled: true,
  minAppVersion: '0.1.0',
  sessionWorkspace: '鲸鱼娘',
  agentPreset: 'whale-companion',
  /**
   * 'app'：隐藏会话用 ask 策略，审批请求转成 companion.approval 事件交给 App 决定；
   * 'never'：高风险操作直接失败，不打扰 App。
   */
  approvalPolicy: 'app',
  /** 审批等待上限；超时按拒绝处理。 */
  approvalTimeoutMs: 300_000,
  /** 默认预设不可用时退回的预设（旧版 dsh 只有内置 standard）。 */
  fallbackPreset: 'standard',
  /** 单轮对话超时。 */
  chatTimeoutMs: 120_000,
  /** 单个后台任务超时（命令任务可能更久）。 */
  taskTimeoutMs: 600_000,
  /** 同时排队 + 执行的请求上限，超出返回 429。 */
  maxQueue: 4,
  /** 隐藏 session 轮数上限，达到后换一个新 session，避免上下文无限增长。 */
  sessionMaxTurns: 40,
  /** 人格 section 在 system prompt 中的排序位置。 */
  promptOrder: 5000,
  /** 是否为鲸鱼娘建立独立工作区。 */
  workspaceEnabled: true,
  workspacePath: '',
  workspaceTitle: '鲸鱼娘',
  /** WebSocket 心跳间隔。 */
  eventHeartbeatMs: 30_000,
  /** 上传文件大小上限与保留数量。 */
  maxUploadBytes: 20 * 1024 * 1024,
  maxFiles: 100,
  /** 持久化状态文件；留空用 <DSH_HOME>/whale-companion/state.json。 */
  statePath: '',
  /** 重启后是否重新排队未完成任务：off / opt-in（任务带 resumeOnRestart）/ all。 */
  taskResume: 'opt-in',
  /** 主动消息默认值（文档 §12.1）。 */
  proactive: Object.freeze({
    enabled: false,
    mode: 'template',
    dailyLimit: 3,
    minIntervalMinutes: 120,
    quietStart: '22:30',
    quietEnd: '08:00',
    generationTimeoutMs: 60_000,
    templates: Object.freeze([])
  })
});

/** 请求体上限：聊天上下文可能带记忆和最近消息。 */
export const MAX_CHAT_BODY_BYTES = 128 * 1024;
export const MAX_TASK_BODY_BYTES = 64 * 1024;
export const MAX_CONFIG_BODY_BYTES = 32 * 1024;

/** 单条输入/输出的长度上限。 */
export const LIMITS = Object.freeze({
  name: 40,
  userTitle: 40,
  personality: 32,
  message: 4000,
  memoryText: 300,
  memoryItems: 32,
  recentMessages: 12,
  recentText: 500,
  taskInstruction: 8000,
  taskTitle: 80,
  replyText: 8000,
  toolEvents: 12,
  taskResult: 4000,
  requestId: 128,
  approvalReason: 500
});
