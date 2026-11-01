/**
 * 主动消息调度器。
 *
 * 只在「App 已连上 /companion/events」时发送：App 被杀或没连，WS 客户端为 0，
 * 调度器不生成、不排队、不补发（与卡片“已下线”的语义一致）。
 *
 * 默认参数（文档 §12.1）：
 *   - 每天 3 条；
 *   - 最小间隔 2 小时；
 *   - 免打扰 22:30–08:00；
 *   - 用户可在 App 里改成 0~5 条 / 关闭。
 *
 * 消息默认由本地模板生成，不调用模型；App 收到 `companion.proactive` 后
 * 决定展示方式（前台气泡 / 后台本地通知 / 卡片）。
 */
import { randomUUID } from 'node:crypto';

const TICK_INTERVAL_MS = 30_000;
const HISTORY_LIMIT = 20;

const DEFAULT_TEMPLATES = {
  morning: [
    '早上好呀，今天想先做哪件事？',
    '新的一天，先喝口水再开工吧。'
  ],
  noon: [
    '中午啦，记得吃饭。',
    '忙到现在的话，先休息十分钟吧。'
  ],
  afternoon: [
    '下午也一起加油，卡住了就叫我。',
    '要不要把今天剩下的任务理一理？'
  ],
  evening: [
    '今天辛苦了，剩下的明天再战。',
    '晚上好，今天有什么想聊的吗？'
  ],
  night: [
    '夜深了，早点休息，我明天还在。',
    '如果还在忙，记得给自己留一点睡眠。'
  ]
};

function parseClock(value, fallback) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return fallback;
  }
  return value;
}

function minutesOf(value) {
  const [hour, minute] = value.split(':').map((part) => Number.parseInt(part, 10));
  return hour * 60 + minute;
}

function dayKey(now) {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function slotOf(now) {
  const hour = new Date(now).getHours();
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 14) return 'noon';
  if (hour >= 14 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

function inQuietWindow(minutes, start, end) {
  const from = minutesOf(start);
  const to = minutesOf(end);
  if (from === to) {
    return false;
  }
  return from < to
    ? minutes >= from && minutes < to
    : minutes >= from || minutes < to;
}

function nextClockTime(now, clock) {
  const date = new Date(now);
  const [hour, minute] = clock.split(':').map((part) => Number.parseInt(part, 10));
  const next = new Date(date);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

export class ProactiveScheduler {
  /**
   * @param {object} input
   * @param {import('./events.js').CompanionEvents} input.events
   * @param {object} input.options 运行配置，读取 options.proactive
   * @param {() => object} input.getProfile
   * @param {(message: string) => void} input.log
   * @param {() => void} [input.onChange] 状态变化（用于持久化）
   * @param {() => number} [input.now]
   * @param {() => Promise<{text?: string, emotion?: string} | null>} [input.generate]
   *   模型生成回调；mode=model 时使用，返回 null 表示当前忙/失败，退回模板。
   */
  constructor({ events, options, getProfile, log, onChange, now = () => Date.now(), generate }) {
    this.events = events;
    this.options = options;
    this.getProfile = getProfile;
    this.log = log;
    this.onChange = onChange;
    this.now = now;
    this.generate = generate;
    this.timer = null;
    this.sending = false;
    this.day = dayKey(this.now());
    this.sentToday = 0;
    this.lastSentAt = null;
    this.lastMessage = null;
    this.recent = [];
    this.feedback = { like: 0, dislike: 0, dismiss: 0 };
    this.rotation = 0;
    this.lastSkip = null;
    this.context = null;
    this.configure();
  }

  get settings() {
    return this.options.proactive;
  }

  start() {
    if (this.timer !== null || !this.settings.enabled) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.log(`proactive tick failed: ${error?.message ?? error}`);
      });
    }, TICK_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 配置变更后重新评估定时器。 */
  configure() {
    this.stop();
    this.start();
  }

  /** App 同步来的上下文：人格之外的状态、全部记忆、最近对话、未回复计数。 */
  setContext(context) {
    this.context = context !== null && typeof context === 'object' ? context : null;
  }

  #rollDay(now) {
    const today = dayKey(now);
    if (today !== this.day) {
      this.day = today;
      this.sentToday = 0;
      this.onChange?.();
    }
  }

  inQuietHours(now = this.now()) {
    const date = new Date(now);
    return inQuietWindow(date.getHours() * 60 + date.getMinutes(), this.settings.quietStart, this.settings.quietEnd);
  }

  nextEligibleAt(now = this.now()) {
    if (!this.settings.enabled || this.settings.dailyLimit === 0 || this.events.count() === 0) {
      return null;
    }
    this.#rollDay(now);
    if (this.sentToday >= this.settings.dailyLimit) {
      return nextClockTime(now, '00:00');
    }
    const intervalMs = this.settings.minIntervalMinutes * 60_000;
    let next = Math.max(now, this.lastSentAt === null ? now : this.lastSentAt + intervalMs);
    if (this.inQuietHours(next)) {
      next = nextClockTime(next, this.settings.quietEnd);
    }
    return next;
  }

  status() {
    const now = this.now();
    this.#rollDay(now);
    return {
      enabled: this.settings.enabled,
      mode: this.settings.mode,
      sentToday: this.sentToday,
      dailyLimit: this.settings.dailyLimit,
      minIntervalMinutes: this.settings.minIntervalMinutes,
      quietStart: this.settings.quietStart,
      quietEnd: this.settings.quietEnd,
      quiet: this.inQuietHours(now),
      clients: this.events.count(),
      lastSentAt: this.lastSentAt,
      nextEligibleAt: this.nextEligibleAt(now),
      feedback: { ...this.feedback }
    };
  }

  /** 定时检查；返回是否发出了一条。 */
  async tick(now = this.now()) {
    if (!this.settings.enabled) {
      return false;
    }
    return this.#send(now, 'scheduled', false);
  }

  /**
   * App 侧的「立即发一条」测试 / 手动触发。
   * 忽略免打扰与最小间隔，但仍要求插件开启且有客户端连接。
   */
  async trigger(reason = 'test') {
    return this.#send(this.now(), reason, true);
  }

  async #send(now, reason, force) {
    if (this.sending) {
      this.lastSkip = 'busy';
      return false;
    }
    if (!this.settings.enabled) {
      this.lastSkip = 'disabled';
      return false;
    }
    if (this.events.count() === 0 && !force) {
      this.lastSkip = 'no-client';
      return false;
    }
    this.#rollDay(now);
    if (this.sentToday >= this.settings.dailyLimit && !force) {
      this.lastSkip = 'daily-limit';
      return false;
    }
    if (!force) {
      if (this.inQuietHours(now)) {
        this.lastSkip = 'quiet';
        return false;
      }
      if (this.lastSentAt !== null && now - this.lastSentAt < this.settings.minIntervalMinutes * 60_000) {
        this.lastSkip = 'interval';
        return false;
      }
    }
    this.lastSkip = null;
    this.sending = true;
    try {
      let text = null;
      let source = 'template';
      if (this.settings.mode === 'model' && typeof this.generate === 'function') {
        try {
          const generated = await this.generate(this.context);
          if (generated !== null && typeof generated?.text === 'string' && generated.text.trim().length > 0) {
            text = generated.text.trim().slice(0, 500);
            source = 'model';
          }
        } catch (error) {
          this.log(`proactive model generation failed: ${error?.message ?? error}`);
        }
      }
      if (text === null) {
        text = this.#pickText(this.getProfile(), now);
      }
      // 生成期间 App 可能已经断开；非测试触发才放弃；测试消息由接口回传给 App。
      if (this.events.count() === 0 && !force) {
        this.lastSkip = 'no-client';
        return false;
      }
      const message = {
        id: `p_${randomUUID()}`,
        text,
        source,
        importance: 'normal',
        reason,
        createdAt: now
      };
      this.sentToday += 1;
      this.lastSentAt = now;
      this.lastMessage = message;
      this.recent.unshift(message);
      if (this.recent.length > HISTORY_LIMIT) {
        this.recent.length = HISTORY_LIMIT;
      }
      this.events.broadcast('companion.proactive', {
        message,
        status: { sentToday: this.sentToday, dailyLimit: this.settings.dailyLimit }
      });
      this.onChange?.();
      this.log(`proactive message sent (${reason}, ${source}), ${this.sentToday}/${this.settings.dailyLimit} today`);
      return true;
    } finally {
      this.sending = false;
    }
  }

  #pickText(profile, now) {
    const configured = Array.isArray(this.settings.templates) ? this.settings.templates : [];
    const slot = slotOf(now);
    const pool = configured.length > 0 ? configured : DEFAULT_TEMPLATES[slot];
    const template = pool[this.rotation % pool.length];
    this.rotation = (this.rotation + 1) % 1_000_000;
    return template
      .replaceAll('{name}', profile?.name ?? '鲸鱼娘')
      .replaceAll('{userTitle}', profile?.userTitle ?? '你');
  }

  /** 记录 App 对某条主动消息的反馈；只做计数，不推进任何养成数值。 */
  recordFeedback(messageId, value) {
    if (!['like', 'dislike', 'dismiss'].includes(value)) {
      return false;
    }
    this.feedback[value] += 1;
    this.recent = this.recent.map((message) => (
      message.id === messageId ? { ...message, feedback: value } : message
    ));
    this.onChange?.();
    return true;
  }

  recentMessages(limit = 10) {
    return this.recent.slice(0, Math.max(1, Math.min(HISTORY_LIMIT, limit)));
  }

  toJSON() {
    return {
      day: this.day,
      sentToday: this.sentToday,
      lastSentAt: this.lastSentAt,
      lastMessage: this.lastMessage,
      recent: this.recent.slice(0, HISTORY_LIMIT),
      feedback: { ...this.feedback },
      context: this.context
    };
  }

  restore(saved) {
    if (saved === null || typeof saved !== 'object') {
      return;
    }
    const today = dayKey(this.now());
    this.day = typeof saved.day === 'string' ? saved.day : today;
    this.sentToday = this.day === today && Number.isFinite(saved.sentToday)
      ? Math.max(0, Math.trunc(saved.sentToday))
      : 0;
    this.lastSentAt = Number.isFinite(saved.lastSentAt) ? saved.lastSentAt : null;
    this.lastMessage = saved.lastMessage ?? null;
    this.recent = Array.isArray(saved.recent) ? saved.recent.slice(0, HISTORY_LIMIT) : [];
    this.context = saved.context !== null && typeof saved.context === 'object' ? saved.context : null;
    this.feedback = {
      like: Number.isFinite(saved.feedback?.like) ? saved.feedback.like : 0,
      dislike: Number.isFinite(saved.feedback?.dislike) ? saved.feedback.dislike : 0,
      dismiss: Number.isFinite(saved.feedback?.dismiss) ? saved.feedback.dismiss : 0
    };
    if (this.day !== today) {
      this.sentToday = 0;
    }
  }
}

export { parseClock, DEFAULT_TEMPLATES };
