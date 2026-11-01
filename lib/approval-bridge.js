/**
 * 审批桥：把隐藏会话的高风险操作转成 App 可以回答的一次性请求。
 *
 * 数据流：
 *   agent 工具 → ctx.approval.request()
 *     → 隐藏 Agent scope 上的 `approval/request` waterfall
 *     → ApprovalBridge 创建 pending + 广播 companion.approval
 *     → App 调 POST /companion/approvals 回答（或超时/取消）
 *     → 返回 'allowed-once' / 'rejected' / 'cancelled'
 *
 * 关键约束：
 *   - 只处理隐藏 Agent 自己的请求（listener 注册在它的 scope 上）；
 *   - 不调用 next()，避免落到桌面端审批 UI 或其它 answerer；
 *   - 只允许这一次（allowed-once），没有「永久允许」；
 *   - App 不在线时请求会保留到超时，App 重连后可以通过 GET 列表补答。
 */
import { randomUUID } from 'node:crypto';
import { LIMITS } from './constants.js';

const ALLOW = 'allowed-once';
const REJECT = 'rejected';
const CANCEL = 'cancelled';

/** 只读/查看类工具；低风险自动执行只覆盖这些，不包含写入、删除、shell。 */
const LOW_RISK_TOOLS = new Set([
  'read',
  'read_file',
  'readFile',
  'list',
  'list_dir',
  'ls',
  'glob',
  'grep',
  'search',
  'find',
  'stat',
  'file_info',
  'get_file_info'
]);

function text(value, max) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

function reasonOf(request) {
  const display = request?.displayReason;
  if (display !== null && typeof display === 'object') {
    const localized = display.zh ?? display.en;
    const value = text(localized, LIMITS.approvalReason);
    if (value !== null) {
      return value;
    }
  }
  return text(request?.reason, LIMITS.approvalReason);
}

export class ApprovalBridge {
  /**
   * @param {object} input
   * @param {import('./events.js').CompanionEvents} input.events
   * @param {object} input.options 运行配置（approvalPolicy / approvalTimeoutMs）
   * @param {(message: string) => void} input.log
   * @param {() => string | null} input.getTaskId 当前 turn 关联的任务 id
   * @param {() => object} [input.getProfile] 当前人格设置（低风险自动执行）
   * @param {(approval: object) => void} [input.onPending]
   * @param {(approval: object) => void} [input.onSettled]
   */
  constructor({ events, options, log, getTaskId, getProfile, onPending, onSettled, onChange }) {
    this.events = events;
    this.options = options;
    this.log = log;
    this.getTaskId = getTaskId;
    this.getProfile = getProfile;
    this.onPending = onPending;
    this.onSettled = onSettled;
    this.onChange = onChange;
    /** @type {Map<string, {view: object, finish: (outcome: string, status: string) => void}>} */
    this.pending = new Map();
    /** 已回答/过期的审批，最多保留 20 条，用于重启后审计。 */
    this.historyEntries = [];
  }

  get enabled() {
    return this.options.approvalPolicy !== 'never';
  }

  pendingCount() {
    return this.pending.size;
  }

  list() {
    return [...this.pending.values()].map((entry) => ({ ...entry.view, status: 'pending' }));
  }

  /**
   * 作为 `approval/request` 的 waterfall listener 调用。
   * 注意：不调用 next()——隐藏会话的审批只由 App 回答，不落到桌面 UI。
   * @param {object} request ApprovalRequestEvent
   * @returns {Promise<'allowed-once' | 'rejected' | 'cancelled'>}
   */
  async request(request) {
    if (!this.enabled) {
      return REJECT;
    }
    const toolName = text(request?.toolName, 80) ?? 'tool';
    const taskId = this.getTaskId();
    // 只对后台任务放行只读工具；写入、删除、命令和未知工具继续走审批。
    if (taskId !== null
      && this.getProfile?.()?.autoLowRisk === true
      && LOW_RISK_TOOLS.has(toolName)) {
      this.log(`auto-approved low-risk tool: ${toolName} task=${taskId}`);
      return ALLOW;
    }
    const id = `a_${randomUUID()}`;
    const view = {
      id,
      toolName,
      callId: text(request?.callId, 128),
      reason: reasonOf(request),
      taskId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.options.approvalTimeoutMs
    };

    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome, status) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        request?.signal?.removeEventListener?.('abort', onAbort);
        this.pending.delete(id);
        const settledView = { ...view, status, completedAt: Date.now() };
        this.historyEntries.unshift(settledView);
        if (this.historyEntries.length > 20) {
          this.historyEntries.length = 20;
        }
        try {
          this.onSettled?.(settledView);
        } catch (error) {
          this.log(`approval onSettled failed: ${error?.message ?? error}`);
        }
        this.events.broadcast('companion.approval', { approval: settledView });
        this.onChange?.();
        resolve(outcome);
      };
      const onAbort = () => settle(CANCEL, 'cancelled');
      const timer = setTimeout(() => settle(REJECT, 'expired'), this.options.approvalTimeoutMs);

      if (request?.signal?.aborted === true) {
        settle(CANCEL, 'cancelled');
        return;
      }
      request?.signal?.addEventListener?.('abort', onAbort, { once: true });

      this.pending.set(id, { view, finish: settle });
      try {
        this.onPending?.({ ...view, status: 'pending' });
      } catch (error) {
        this.log(`approval onPending failed: ${error?.message ?? error}`);
      }
      this.events.broadcast('companion.approval', { approval: { ...view, status: 'pending' } });
      this.onChange?.();
      this.log(`approval requested: ${view.toolName}${taskId === null ? '' : ` task=${taskId}`}`);
    });
  }

  /**
   * App 回答一个 pending 审批。
   * @param {string} id
   * @param {'allow' | 'reject'} decision
   * @returns {object | null} 回答后的视图；不存在返回 null
   */
  decide(id, decision) {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return null;
    }
    const allow = decision === 'allow';
    entry.finish(allow ? ALLOW : REJECT, allow ? 'allowed' : 'rejected');
    return { ...entry.view, status: allow ? 'allowed' : 'rejected' };
  }

  /** 插件卸载 / 隐藏会话重建时，所有等待中的审批按取消处理。 */
  cancelAll() {
    for (const entry of [...this.pending.values()]) {
      entry.finish(CANCEL, 'cancelled');
    }
  }

  /** 最近的审批结果（新的在前），App 可用于展示「刚才那次放行/拒绝」。 */
  history(limit = 10) {
    return this.historyEntries.slice(0, Math.max(1, Math.min(20, limit)));
  }

  toJSON() {
    return {
      pending: this.list(),
      history: this.history(20)
    };
  }

  /**
   * 恢复审批历史。上次进程里没回答的审批已经无法回答（对应 turn 已死），
   * 统一转成 expired 放进历史，不再作为 pending 暴露。
   */
  restore(saved) {
    if (saved === null || typeof saved !== 'object') {
      return;
    }
    const restored = [];
    if (Array.isArray(saved.pending)) {
      for (const entry of saved.pending) {
        if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') {
          restored.push({ ...entry, status: 'expired', completedAt: Date.now() });
        }
      }
    }
    if (Array.isArray(saved.history)) {
      for (const entry of saved.history) {
        if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') {
          restored.push(entry);
        }
      }
    }
    this.historyEntries = restored.slice(0, 20);
  }
}
