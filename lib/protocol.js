/**
 * 请求/响应协议：白名单、长度限制、模型输出解析。
 *
 * 所有 App 传入的字段都先经过这里再进入 prompt；所有模型输出都先经过这里
 * 再返回 App。任何未知字段、未知枚举、超长文本都会被丢弃或截断。
 */
import { randomUUID } from 'node:crypto';
import {
  ACTIONS,
  EMOTIONS,
  GROWTH_TYPES,
  LIMITS,
  MEMORY_KINDS,
  SCHEMA_VERSION,
  TASK_KINDS,
  TASK_STATUSES
} from './constants.js';
import { CompanionError } from './errors.js';
import { splitReplyText } from './streaming.js';

export function trimText(value, max) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampRatio(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

const PROFILE_FALLBACK = Object.freeze({
  name: '鲸鱼娘',
  userTitle: '你',
  personality: 'gentle',
  energy: 'medium',
  clinginess: 'low',
  humor: 'medium',
  verbosity: 'short',
  workMode: 'companion',
  allowCoquettish: true,
  allowJealousy: true,
  allowCare: true,
  autoLowRisk: false,
  reportProgress: true,
  chatTimeoutMs: 120000
});

/**
 * 规范化 App 传入的人格。
 * 布尔设置必须区分“未传”和 false：用 fallback 保留上一次保存的值。
 */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function intInRange(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** 人格字段白名单；未知字段不会进入 prompt。 */
export function normalizeProfile(raw, fallback = PROFILE_FALLBACK) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    name: trimText(source.name, LIMITS.name) ?? fallback.name,
    userTitle: trimText(source.userTitle, LIMITS.userTitle) ?? fallback.userTitle,
    personality: trimText(source.personality, LIMITS.personality) ?? fallback.personality,
    energy: trimText(source.energy, LIMITS.personality) ?? fallback.energy,
    clinginess: trimText(source.clinginess, LIMITS.personality) ?? fallback.clinginess,
    humor: trimText(source.humor, LIMITS.personality) ?? fallback.humor,
    verbosity: trimText(source.verbosity, LIMITS.personality) ?? fallback.verbosity,
    workMode: trimText(source.workMode, LIMITS.personality) ?? fallback.workMode,
    allowCoquettish: boolOr(source.allowCoquettish, fallback.allowCoquettish),
    allowJealousy: boolOr(source.allowJealousy, fallback.allowJealousy),
    allowCare: boolOr(source.allowCare, fallback.allowCare),
    autoLowRisk: boolOr(source.autoLowRisk, fallback.autoLowRisk),
    reportProgress: boolOr(source.reportProgress, fallback.reportProgress),
    chatTimeoutMs: intInRange(source.chatTimeoutMs, fallback.chatTimeoutMs, 30_000, 900_000)
  };
}

function normalizeMood(value) {
  return EMOTIONS.includes(value) ? value : 'idle';
}

/** App 每次请求携带的养成状态；只读，不持久化。 */
export function normalizeState(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    mood: normalizeMood(source.mood),
    affinity: clampNumber(source.affinity, 0, 1_000_000, 0),
    trust: clampNumber(source.trust, 0, 1_000_000, 0),
    level: clampNumber(source.level, 0, 1_000_000, 1),
    moodReason: trimText(source.moodReason, 120) ?? null
  };
}

/** 长期记忆摘要由 App 传入，插件只读不写。 */
export function normalizeMemory(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const items = [];
  for (const entry of raw.slice(0, LIMITS.memoryItems)) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const text = trimText(entry.text, LIMITS.memoryText);
    if (text === undefined) {
      continue;
    }
    items.push({
      id: trimText(entry.id, 64) ?? null,
      text,
      kind: MEMORY_KINDS.includes(entry.kind) ? entry.kind : 'fact',
      confidence: clampRatio(entry.confidence, 0.5)
    });
  }
  return items;
}

/** 最近几轮对话，用于在没有持久记忆时补足上下文。 */
export function normalizeRecentMessages(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const messages = [];
  for (const entry of raw.slice(-LIMITS.recentMessages)) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const text = trimText(entry.text, LIMITS.recentText);
    if (text === undefined) {
      continue;
    }
    messages.push({
      role: entry.role === 'companion' || entry.role === 'assistant' ? 'companion' : 'user',
      text
    });
  }
  return messages;
}

/**
 * 解析 POST /companion/chat 的 CompanionContext。
 * @param {unknown} body
 * @param {object} [fallbackProfile] 请求未带人格时沿用当前人格
 */
export function normalizeCompanionContext(body, fallbackProfile = PROFILE_FALLBACK) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CompanionError('bad-request', 'a JSON object body is required', 400);
  }
  const schemaVersion = body.schemaVersion === undefined ? SCHEMA_VERSION : body.schemaVersion;
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new CompanionError(
      'schema-version',
      `unsupported schemaVersion: ${String(schemaVersion)}`,
      400
    );
  }
  const requestId = trimText(body.requestId, LIMITS.requestId) ?? randomUUID();
  const message = trimText(body.message, LIMITS.message);
  if (message === undefined) {
    throw new CompanionError('bad-request', 'message is required', 400);
  }
  return {
    schemaVersion,
    requestId,
    profile: body.profile === undefined ? null : normalizeProfile(body.profile, fallbackProfile),
    state: normalizeState(body.state),
    memory: normalizeMemory(body.memory),
    recentMessages: normalizeRecentMessages(body.recentMessages),
    message,
    taskId: trimText(body.taskId, 128) ?? null
  };
}

/**
 * 把模型返回的一段文本解析成 CompanionReply 的字段。
 *
 * 首选格式是「正文 + [[meta]]{...}」；同时兼容旧版整段 JSON
 * （{"text":...}）以及纯文本。解析失败时退回纯文本回复，
 * 保证 App 至少能显示一句话，而不是整轮失败。
 */
export function parseModelReply(rawText, { requestId, fallbackEmotion = 'happy' }) {
  const text = typeof rawText === 'string' ? rawText : '';
  const { body, metaRaw } = splitReplyText(text);
  let meta = null;
  if (metaRaw !== null) {
    meta = extractJsonObject(metaRaw);
  } else {
    const head = body.trimStart();
    if (head.startsWith('{') || head.startsWith('```')) {
      meta = extractJsonObject(body);
    }
  }
  const fallbackText = trimText(body, LIMITS.replyText) ?? '……';
  if (meta === null) {
    return {
      schemaVersion: SCHEMA_VERSION,
      requestId,
      text: fallbackText,
      emotion: fallbackEmotion,
      action: 'nod',
      taskEvents: [],
      memoryCandidates: [],
      growthSignals: [],
      proactiveHint: null
    };
  }
  const replyText = trimText(meta.text, LIMITS.replyText) ?? fallbackText;
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    text: replyText,
    emotion: EMOTIONS.includes(meta.emotion) ? meta.emotion : fallbackEmotion,
    action: ACTIONS.includes(meta.action) ? meta.action : 'nod',
    taskEvents: [],
    memoryCandidates: normalizeMemoryCandidates(meta.memoryCandidates),
    growthSignals: normalizeGrowthSignals(meta.growthSignals),
    proactiveHint: normalizeProactiveHint(meta.proactiveHint)
  };
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    candidates.push(fenced[1].trim());
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value;
      }
    } catch {
      // 继续尝试下一种截取方式
    }
  }
  return null;
}

function normalizeMemoryCandidates(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const items = [];
  for (const entry of raw.slice(0, 3)) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const text = trimText(entry.text, LIMITS.memoryText);
    if (text === undefined) {
      continue;
    }
    items.push({
      text,
      kind: MEMORY_KINDS.includes(entry.kind) ? entry.kind : 'fact',
      confidence: clampRatio(entry.confidence, 0.6)
    });
  }
  return items;
}

function normalizeGrowthSignals(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const signals = [];
  for (const entry of raw.slice(0, 5)) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const type = GROWTH_TYPES.includes(entry.type) ? entry.type : 'chat';
    signals.push({ type, value: clampNumber(entry.value, 0, 1000, 1) });
  }
  return signals;
}

function normalizeProactiveHint(raw) {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const text = trimText(raw.text, 200);
  if (text === undefined) {
    return null;
  }
  return { text, reason: trimText(raw.reason, 80) ?? 'follow-up' };
}

/** POST /companion/tasks 的入参。 */
export function normalizeTaskRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CompanionError('bad-request', 'a JSON object body is required', 400);
  }
  const kind = TASK_KINDS.includes(body.kind) ? body.kind : 'chat';
  const rawInstruction = body.instruction ?? body.message ?? body.prompt ?? body.command;
  const instruction = trimText(rawInstruction, LIMITS.taskInstruction);
  if (instruction === undefined) {
    throw new CompanionError('bad-request', 'instruction is required', 400);
  }
  const fileIds = Array.isArray(body.fileIds)
    ? body.fileIds
      .map((value) => trimText(value, 128))
      .filter((value) => value !== undefined)
      .slice(0, 5)
    : [];
  return {
    kind,
    instruction,
    title: trimText(body.title, LIMITS.taskTitle) ?? instruction.slice(0, 40),
    requestId: trimText(body.requestId, LIMITS.requestId) ?? null,
    fileIds,
    resumeOnRestart: body.resumeOnRestart === true
  };
}

/** 任务状态的对外投影；不含 AbortController 等内部对象。 */
export function taskView(task) {
  return {
    id: task.id,
    kind: task.kind,
    title: task.title,
    status: TASK_STATUSES.includes(task.status) ? task.status : 'failed',
    instruction: task.instruction,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
    result: task.result ? task.result.slice(0, LIMITS.taskResult) : null,
    emotion: task.emotion ?? null,
    approval: task.approval ?? null,
    files: Array.isArray(task.files) ? task.files : [],
    attempt: Number.isFinite(task.attempt) ? task.attempt : 1,
    resumeOnRestart: task.resumeOnRestart === true,
    resumedAt: task.resumedAt ?? null,
    sessionId: task.sessionId ?? null,
    error: task.error ?? null,
    steps: task.steps ?? [],
    requestId: task.requestId ?? null
  };
}

export function isTaskStatus(value) {
  return TASK_STATUSES.includes(value);
}
