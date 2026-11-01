/**
 * 后台任务注册表。
 *
 * 任务是「App 发起、电脑端 DSH 执行、结果回传」的异步单元：
 *   queued → running ⇄ waiting-approval → succeeded / failed / cancelled
 *
 * 任务元数据会持久化到状态文件；DSH 重启时，没跑完的任务会被标记为
 * failed/interrupted，App 可以据此提示重试。
 */
import { randomUUID } from 'node:crypto';
import { CompanionError } from './errors.js';
import { isTaskStatus, taskView } from './protocol.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

const INTERRUPTED = { code: 'interrupted', message: 'DSH restarted before the task finished' };

export class TaskStore {
  constructor({ max = 50, onChange } = {}) {
    this.max = max;
    this.onChange = onChange;
    this.tasks = new Map();
    this.order = [];
    this.byRequest = new Map();
  }

  /**
   * 创建任务；同一个 requestId 重复提交时返回已有任务（幂等）。
   * @returns {{task: object, created: boolean}}
   */
  create({ kind, title, instruction, requestId, files = [], resumeOnRestart = false }) {
    if (requestId !== null && requestId !== undefined) {
      const existing = this.byRequest.get(requestId);
      if (existing !== undefined) {
        return { task: existing, created: false };
      }
    }
    const task = {
      id: `t_${randomUUID()}`,
      kind,
      title,
      instruction,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      emotion: null,
      error: null,
      approval: null,
      files: Array.isArray(files) ? files : [],
      steps: [],
      requestId: requestId ?? null,
      attempt: 1,
      resumeOnRestart: resumeOnRestart === true,
      resumedAt: null,
      sessionId: null,
      resumeSessionId: null,
      controller: null,
      cancelRequested: false
    };
    this.tasks.set(task.id, task);
    this.order.push(task.id);
    if (task.requestId !== null) {
      this.byRequest.set(task.requestId, task);
    }
    this.#trim();
    this.onChange?.();
    return { task, created: true };
  }

  get(id) {
    return this.tasks.get(id);
  }

  require(id) {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new CompanionError('not-found', 'task not found', 404);
    }
    return task;
  }

  list({ limit = 20, status } = {}) {
    const safeLimit = Math.min(50, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const wanted = isTaskStatus(status) ? status : null;
    const result = [];
    for (let index = this.order.length - 1; index >= 0 && result.length < safeLimit; index -= 1) {
      const task = this.tasks.get(this.order[index]);
      if (task === undefined) {
        continue;
      }
      if (wanted !== null && task.status !== wanted) {
        continue;
      }
      result.push(taskView(task));
    }
    return result;
  }

  activeCount() {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (!TERMINAL.has(task.status)) {
        count += 1;
      }
    }
    return count;
  }

  markRunning(task) {
    if (task.cancelRequested || task.status !== 'queued') {
      return;
    }
    task.status = 'running';
    task.startedAt = Date.now();
    this.onChange?.();
  }

  /** 任务因等待 App 审批而暂停；审批视图一并返回给 App。 */
  markWaiting(task, approval) {
    if (task.cancelRequested || TERMINAL.has(task.status)) {
      return;
    }
    task.status = 'waiting-approval';
    task.approval = approval;
    if (task.startedAt === null) {
      task.startedAt = Date.now();
    }
    this.onChange?.();
  }

  /** 审批已回答，任务回到运行中。 */
  resumeRunning(task) {
    if (task.status !== 'waiting-approval') {
      return;
    }
    task.status = 'running';
    task.approval = null;
    this.onChange?.();
  }

  complete(task, result) {
    if (task.cancelRequested) {
      this.#finishCancelled(task);
      return;
    }
    task.status = 'succeeded';
    task.approval = null;
    task.result = typeof result?.text === 'string' ? result.text : null;
    task.emotion = typeof result?.emotion === 'string' ? result.emotion : null;
    task.steps = Array.isArray(result?.steps) ? result.steps : [];
    task.finishedAt = Date.now();
    this.onChange?.();
  }

  fail(task, error) {
    if (task.cancelRequested || error?.code === 'cancelled') {
      this.#finishCancelled(task);
      return;
    }
    task.status = 'failed';
    task.approval = null;
    task.error = {
      code: typeof error?.code === 'string' ? error.code : 'task-failed',
      message: typeof error?.message === 'string' ? error.message : 'task failed'
    };
    task.finishedAt = Date.now();
    this.onChange?.();
  }

  /** 取消任务：立即标记 cancelled，运行中的 turn 由 AbortSignal 中断。 */
  cancel(id) {
    const task = this.require(id);
    if (TERMINAL.has(task.status)) {
      return { cancelled: false, task };
    }
    task.cancelRequested = true;
    try {
      task.controller?.abort();
    } catch {
      // 忽略
    }
    this.#finishCancelled(task);
    return { cancelled: true, task };
  }

  view(task) {
    return taskView(task);
  }

  /** 当前排队中的任务（启动时用于恢复/续跑）。 */
  queued() {
    return this.order
      .map((id) => this.tasks.get(id))
      .filter((task) => task !== undefined && task.status === 'queued');
  }

  toJSON() {
    return this.order
      .map((id) => this.tasks.get(id))
      .filter((task) => task !== undefined)
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        title: task.title,
        instruction: task.instruction,
        status: task.status,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        result: task.result,
        emotion: task.emotion,
        error: task.error,
        approval: task.approval,
        files: task.files,
        steps: task.steps,
        requestId: task.requestId,
        attempt: task.attempt,
        resumeOnRestart: task.resumeOnRestart,
        resumedAt: task.resumedAt,
        sessionId: task.sessionId
      }));
  }

  /**
   * 恢复持久化任务。
   *
   * 没跑完的任务无法从中断的模型步骤继续，只能重新执行一遍；是否重排由
   * `taskResume` 决定：
   *   - off：不重排，标记 failed/interrupted；
   *   - opt-in：只重排 `resumeOnRestart: true` 的任务；
   *   - all：所有未完成任务都重排。
   *
   * @param {object[]} entries
   * @param {{resume?: 'off' | 'opt-in' | 'all'}} [options]
   */
  restore(entries, { resume = 'off' } = {}) {
    if (!Array.isArray(entries)) {
      return;
    }
    for (const raw of entries.slice(-this.max)) {
      if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string') {
        continue;
      }
      const status = isTaskStatus(raw.status) ? raw.status : 'failed';
      const wasActive = status === 'running' || status === 'waiting-approval';
      const task = {
        id: raw.id,
        kind: raw.kind,
        title: typeof raw.title === 'string' ? raw.title : '',
        instruction: typeof raw.instruction === 'string' ? raw.instruction : '',
        status,
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
        startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
        finishedAt: Number.isFinite(raw.finishedAt) ? raw.finishedAt : null,
        result: typeof raw.result === 'string' ? raw.result : null,
        emotion: typeof raw.emotion === 'string' ? raw.emotion : null,
        error: raw.error ?? null,
        approval: raw.approval ?? null,
        files: Array.isArray(raw.files) ? raw.files : [],
        steps: Array.isArray(raw.steps) ? raw.steps : [],
        requestId: typeof raw.requestId === 'string' ? raw.requestId : null,
        attempt: Number.isFinite(raw.attempt) ? raw.attempt : 1,
        resumeOnRestart: raw.resumeOnRestart === true,
        resumedAt: Number.isFinite(raw.resumedAt) ? raw.resumedAt : null,
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
        resumeSessionId: null,
        controller: null,
        cancelRequested: false
      };
      if (!TERMINAL.has(task.status)) {
        const eligible = resume === 'all' || (resume === 'opt-in' && task.resumeOnRestart);
        if (eligible) {
          task.status = 'queued';
          task.attempt += 1;
          task.resumedAt = Date.now();
          task.error = null;
          task.approval = null;
          task.finishedAt = null;
          task.startedAt = null;
          task.result = null;
          task.steps = [];
          // 只有“真正跑过”的任务才有可恢复的 session；排队没开始的任务直接重跑。
          task.resumeSessionId = wasActive ? task.sessionId : null;
        } else {
          task.status = 'failed';
          task.error = { ...INTERRUPTED };
          task.approval = null;
          task.finishedAt = task.finishedAt ?? Date.now();
        }
      }
      this.tasks.set(task.id, task);
      this.order.push(task.id);
      if (task.requestId !== null) {
        this.byRequest.set(task.requestId, task);
      }
    }
  }

  #finishCancelled(task) {
    if (task.status === 'cancelled') {
      return;
    }
    task.status = 'cancelled';
    task.approval = null;
    task.error = { code: 'cancelled', message: 'task cancelled' };
    task.finishedAt = Date.now();
    this.onChange?.();
  }

  /** 只淘汰最老的已结束任务，绝不丢正在排队/执行的任务。 */
  #trim() {
    while (this.order.length > this.max) {
      const oldest = this.order[0];
      const task = this.tasks.get(oldest);
      if (task !== undefined && !TERMINAL.has(task.status)) {
        break;
      }
      this.order.shift();
      if (task !== undefined) {
        this.tasks.delete(oldest);
        if (task.requestId !== null && this.byRequest.get(task.requestId) === task) {
          this.byRequest.delete(task.requestId);
        }
      }
    }
  }
}
