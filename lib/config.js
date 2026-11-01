/**
 * 插件启动配置的归一化：所有字段都有上限和默认值，避免错误配置把
 * 隐藏会话的超时、队列或工作区写到不可控的位置。
 */
import { DEFAULT_OPTIONS } from './constants.js';
import { parseClock } from './proactive.js';

function intInRange(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function text(value, fallback, max) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed.slice(0, max);
}

/** 主动消息设置：App 可以只传部分字段，其余沿用当前值。 */
export function normalizeProactive(raw, fallback = DEFAULT_OPTIONS.proactive) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const base = fallback ?? DEFAULT_OPTIONS.proactive;
  const templates = Array.isArray(source.templates)
    ? source.templates
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .slice(0, 10)
      .map((item) => item.trim().slice(0, 200))
    : [...(base.templates ?? [])];
  return {
    enabled: source.enabled === true,
    mode: source.mode === 'model' ? 'model' : 'template',
    dailyLimit: intInRange(source.dailyLimit, base.dailyLimit, 0, 1000000),
    minIntervalMinutes: intInRange(source.minIntervalMinutes, base.minIntervalMinutes, 5, 1440),
    quietStart: parseClock(source.quietStart, base.quietStart),
    quietEnd: parseClock(source.quietEnd, base.quietEnd),
    generationTimeoutMs: intInRange(source.generationTimeoutMs, base.generationTimeoutMs, 5_000, 300_000),
    templates
  };
}

export function normalizeOptions(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const base = DEFAULT_OPTIONS;
  return {
    enabled: source.enabled !== false,
    minAppVersion: text(source.minAppVersion, base.minAppVersion, 40),
    sessionWorkspace: text(source.sessionWorkspace, base.sessionWorkspace, 60),
    agentPreset: text(source.agentPreset, base.agentPreset, 60),
    // 兼容旧配置里的 'ask'：都表示把审批交给 App 决定。
    approvalPolicy: source.approvalPolicy === 'never' ? 'never' : 'app',
    approvalTimeoutMs: intInRange(source.approvalTimeoutMs, base.approvalTimeoutMs, 5_000, 1_800_000),
    fallbackPreset: text(source.fallbackPreset, base.fallbackPreset, 60),
    chatTimeoutMs: intInRange(source.chatTimeoutMs, base.chatTimeoutMs, 5_000, 900_000),
    taskTimeoutMs: intInRange(source.taskTimeoutMs, base.taskTimeoutMs, 5_000, 3_600_000),
    maxQueue: intInRange(source.maxQueue, base.maxQueue, 1, 32),
    sessionMaxTurns: intInRange(source.sessionMaxTurns, base.sessionMaxTurns, 0, 500),
    promptOrder: intInRange(source.promptOrder, base.promptOrder, -100_000, 100_000),
    workspaceEnabled: source.workspaceEnabled !== false,
    workspacePath: text(source.workspacePath, base.workspacePath, 500),
    workspaceTitle: text(source.workspaceTitle, base.workspaceTitle, 60),
    eventHeartbeatMs: intInRange(source.eventHeartbeatMs, base.eventHeartbeatMs, 5_000, 120_000),
    maxUploadBytes: intInRange(source.maxUploadBytes, base.maxUploadBytes, 1024, 200 * 1024 * 1024),
    maxFiles: intInRange(source.maxFiles, base.maxFiles, 10, 500),
    statePath: text(source.statePath, base.statePath, 500),
    taskResume: source.taskResume === 'all'
      ? 'all'
      : (source.taskResume === 'off' ? 'off' : 'opt-in'),
    proactive: normalizeProactive(source.proactive, base.proactive)
  };
}
