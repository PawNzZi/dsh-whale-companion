/**
 * dsh-whale-companion —— HDSH App 专属的鲸鱼娘插件（无头）。
 *
 * 提供：
 *   GET  /companion/health          安装/版本/启用状态/能力
 *   GET  /companion/config          读取当前人格
 *   POST /companion/config          更新人格与运行设置
 *   POST /companion/pet             摸摸头等互动
 *   POST /companion/chat            一轮对话（隐藏 session + 人格 prompt）
 *   GET  /companion/tasks           任务列表
 *   POST /companion/tasks           创建任务（异步执行）
 *   POST /companion/tasks/cancel    取消任务（body 带 taskId）
 *   GET  /companion/events          WebSocket upgrade，推送结构化事件
 *
 * 插件不注册桌面端用户命令，不做桌面端 UI；人格、记忆、养成数据的长期真源
 * 全部在 App，本地只有隐藏工作区和会话日志。
 *
 * 设计文档：../docs/WHALE_COMPANION.md
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompanionError, isCompanionError } from './errors.js';
import {
  MAX_CHAT_BODY_BYTES,
  MAX_CONFIG_BODY_BYTES,
  MAX_TASK_BODY_BYTES,
  PLUGIN_VERSION,
  SCHEMA_VERSION
} from './constants.js';
import { normalizeOptions } from './config.js';
import {
  admit,
  connectionAdmission,
  methodNotAllowed,
  methodOf,
  queryOf,
  readJson,
  readRawBody,
  sendError,
  sendJson
} from './http.js';
import { normalizeProfile, normalizeCompanionContext, normalizeTaskRequest, parseModelReply, taskView, trimText } from './protocol.js';
import { buildChatInput, buildResumeTaskInput, buildTaskInput } from './prompt.js';
import { ReplyTextExtractor } from './streaming.js';
import { CompanionEvents } from './events.js';
import { ApprovalBridge } from './approval-bridge.js';
import { AgentRunner } from './agent-runner.js';
import { TaskStore } from './task-store.js';
import { FileStore, sanitizeFilename } from './file-store.js';
import { ProactiveScheduler } from './proactive.js';
import { BiliDuty } from './bili.js';
import { StateStore, defaultStatePath } from './state.js';
import { createWorkspaceResolver } from './workspace.js';
import { acceptWebSocket, rejectUpgrade } from './ws.js';

export const name = 'whale-companion';

/** DSH 的 HTTP 路由与连接鉴权服务；Agent 等运行时按需可选读取。 */
export const inject = ['webServer', 'connection'];

const CAPABILITIES = [
  'health',
  'config',
  'pet',
  'chat',
  'task',
  'file',
  'approval',
  'proactive',
  'bili',
  'events',
  'memoryCandidate'
];

/** 只允许在运行时通过 POST /companion/config 调整的字段。 */
const RUNTIME_SETTINGS = Object.freeze([
  'approvalPolicy',
  'approvalTimeoutMs',
  'chatTimeoutMs',
  'taskTimeoutMs',
  'maxQueue',
  'sessionMaxTurns',
  'workspaceEnabled',
  'workspaceTitle',
  'maxUploadBytes',
  'proactive'
]);

function makeLogger(ctx) {
  return (message) => {
    const line = `[dsh-whale-companion] ${message}`;
    try {
      ctx.logger?.info?.(line);
    } catch {
      // logger 不可用时只走 console
    }
    console.info(line);
  };
}

function logError(log, req, error) {
  const where = `${req.method ?? '?'} ${req.url ?? '?'}`;
  log(`${where} failed: ${error?.message ?? String(error)}`);
}

/** 握手前校验 upgrade 请求，失败直接写 HTTP 错误并关闭 socket。 */
function admitUpgrade(ctx, req, socket) {
  const verdict = connectionAdmission(ctx, req);
  if (!verdict.ok) {
    rejectUpgrade(socket, verdict.status, 'DSH authentication required');
    return false;
  }
  return true;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  const options = normalizeOptions(config);
  const state = {
    profile: normalizeProfile({}),
    updatedAt: Date.now()
  };
  const startedAt = Date.now();
  const log = makeLogger(ctx);

  const workspace = createWorkspaceResolver({ ctx, options, log });
  const stateStore = new StateStore({ file: options.statePath || defaultStatePath(), log });
  const saved = stateStore.load();
  if (saved?.proactiveSettings && typeof saved.proactiveSettings === 'object') {
    options.proactive = normalizeOptions({ ...options, proactive: saved.proactiveSettings }).proactive;
  }
  const events = new CompanionEvents({
    log,
    version: PLUGIN_VERSION,
    heartbeatMs: options.eventHeartbeatMs
  });

  function snapshotState() {
    return {
      tasks: tasks.toJSON(),
      files: files.toJSON(),
      approvals: approvals.toJSON(),
      proactive: proactive.toJSON(),
      proactiveSettings: { ...options.proactive }
    };
  }

  function schedulePersist() {
    stateStore.schedule(snapshotState);
  }

  const files = new FileStore({ maxFiles: options.maxFiles, onChange: schedulePersist });
  files.restore(saved?.files);

  const tasks = new TaskStore({ max: 50, onChange: schedulePersist });
  tasks.restore(saved?.tasks, { resume: options.taskResume });

  /** @type {AgentRunner | undefined} */
  let runner;
  const approvals = new ApprovalBridge({
    events,
    options,
    log,
    onChange: schedulePersist,
    getTaskId: () => runner?.activeTaskId ?? null,
    getProfile: () => state.profile,
    onPending: (approval) => {
      if (approval.taskId === null || approval.taskId === undefined) {
        return;
      }
      const task = tasks.get(approval.taskId);
      if (task === undefined) {
        return;
      }
      tasks.markWaiting(task, approval);
      events.broadcast('companion.task', { task: tasks.view(task) });
    },
    onSettled: (approval) => {
      if (approval.taskId === null || approval.taskId === undefined) {
        return;
      }
      const task = tasks.get(approval.taskId);
      if (task === undefined || task.status !== 'waiting-approval') {
        return;
      }
      tasks.resumeRunning(task);
      events.broadcast('companion.task', { task: tasks.view(task) });
    }
  });
  approvals.restore(saved?.approvals);

  const proactive = new ProactiveScheduler({
    events,
    options,
    getProfile: () => state.profile,
    log,
    onChange: schedulePersist,
    generate: async (context) => {
      // 只有隐藏 Agent 空闲时才用模型生成，避免和用户对话抢队列。
      const info = runner?.info();
      if (info === undefined || info.running || info.queued > 0 || approvals.pendingCount() > 0) {
        return null;
      }
      try {
        return await runner.generateProactive(options.proactive.generationTimeoutMs, context);
      } catch (error) {
        log(`proactive generation failed: ${error?.message ?? error}`);
        return null;
      }
    }
  });
  proactive.restore(saved?.proactive);

  runner = new AgentRunner({
    ctx,
    options,
    getProfile: () => state.profile,
    getWorkspace: () => workspace.resolve(),
    approvals,
    log
  });

  const bili = new BiliDuty({
    getProfile: () => state.profile,
    log,
    onShare: (share) => {
      events.broadcast('companion.bili', { share });
    },
    generateComment: async (video, subtitle) => {
      const info = runner?.info();
      if (info !== undefined && (info.running || info.queued > 0)) {
        return null;
      }
      return await runner.generateBiliComment(video, subtitle);
    }
  });
  bili.start();

  // 把恢复后的「中断任务」状态写回磁盘。
  stateStore.schedule(snapshotState);

  /** 单轮成功回复按 requestId 缓存，App 重试时不会重复消耗一次模型调用。 */
  const chatCache = new Map();
  function rememberReply(requestId, reply) {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return;
    }
    chatCache.set(requestId, reply);
    if (chatCache.size > 100) {
      const oldest = chatCache.keys().next().value;
      chatCache.delete(oldest);
    }
  }

  function scheduleTask(task) {
    const missingFiles = (task.files ?? []).filter((file) => {
      const meta = files.get(file.id);
      return meta === undefined || !existsSync(meta.absolutePath);
    });
    if (missingFiles.length > 0) {
      tasks.fail(task, new CompanionError(
        'file-missing',
        `attachment missing: ${missingFiles.map((file) => file.name).join(', ')}`,
        404
      ));
      events.broadcast('companion.task', { task: tasks.view(task) });
      return;
    }
    const controller = new AbortController();
    task.controller = controller;
    const run = async () => {
      const workspaceInfo = await workspace.resolve();
      let text;
      let resumed = false;
      if (task.resumeSessionId) {
        try {
          await runner.resumeAgent(task.resumeSessionId);
          resumed = true;
          text = buildResumeTaskInput(
            { kind: task.kind, title: task.title, instruction: task.instruction, files: task.files },
            state.profile,
            workspaceInfo ?? {}
          );
          log(`task ${task.id} resumed from session ${task.resumeSessionId}`);
        } catch (error) {
          log(`task ${task.id} resume unavailable, falling back to re-run: ${error?.message ?? error}`);
        }
      }
      if (!resumed) {
        text = buildTaskInput(
          { kind: task.kind, title: task.title, instruction: task.instruction, files: task.files },
          state.profile,
          workspaceInfo ?? {}
        );
      }
      return runner.runTurn(text, {
        timeoutMs: options.taskTimeoutMs,
        signal: controller.signal,
        taskId: task.id,
        onSession: (sessionId) => {
          task.sessionId = sessionId;
          schedulePersist();
        },
        onStart: () => {
          tasks.markRunning(task);
          events.broadcast('companion.task', { task: tasks.view(task) });
        }
      });
    };
    Promise.resolve()
      .then(run)
      .then((result) => {
        const reply = parseModelReply(result.text, {
          requestId: task.requestId ?? '',
          fallbackEmotion: 'happy'
        });
        tasks.complete(task, {
          text: reply.text,
          steps: result.steps,
          emotion: reply.emotion
        });
      })
      .catch((error) => {
        tasks.fail(task, error);
      })
      .finally(() => {
        task.controller = null;
        events.broadcast('companion.task', { task: tasks.view(task) });
      });
  }

  // ---------------------------------------------------------------- handlers

  // 重启后按 taskResume 策略重排的 queued 任务（包括用户崩溃前排队的任务）。
  for (const task of tasks.queued()) {
    scheduleTask(task);
  }

  async function handleHealth(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'GET') {
      methodNotAllowed(req, res, 'GET');
      return;
    }
    const workspaceInfo = workspace.info();
    sendJson(res, 200, {
      installed: true,
      version: PLUGIN_VERSION,
      minAppVersion: options.minAppVersion,
      enabled: options.enabled,
      dshOnline: true,
      schemaVersion: SCHEMA_VERSION,
      capabilities: options.enabled ? CAPABILITIES : [],
      sessionWorkspace: options.sessionWorkspace,
      agentPreset: options.agentPreset,
      workspace: workspaceInfo === null
        ? null
        : { id: workspaceInfo.id, title: workspaceInfo.title, ready: Boolean(workspaceInfo.path) },
      session: runner.info(),
      approvals: approvals.pendingCount(),
      files: files.count(),
      proactive: proactive.status(),
      state: { savedAt: stateStore.info().lastSavedAt },
      events: events.count(),
      uptimeMs: Date.now() - startedAt
    });
  }

  async function handleConfig(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    const method = methodOf(req);
    if (method === 'GET') {
      sendJson(res, 200, {
        version: PLUGIN_VERSION,
        profile: state.profile,
        settings: {
          approvalPolicy: options.approvalPolicy,
          approvalTimeoutMs: options.approvalTimeoutMs,
          fallbackPreset: options.fallbackPreset,
          chatTimeoutMs: options.chatTimeoutMs,
          taskTimeoutMs: options.taskTimeoutMs,
          maxQueue: options.maxQueue,
          sessionMaxTurns: options.sessionMaxTurns,
          workspaceEnabled: options.workspaceEnabled,
          workspaceTitle: options.workspaceTitle,
          maxUploadBytes: options.maxUploadBytes,
          maxFiles: options.maxFiles,
          taskResume: options.taskResume,
          statePath: options.statePath,
          proactive: { ...options.proactive }
        },
        updatedAt: state.updatedAt
      });
      return;
    }
    if (method !== 'POST') {
      methodNotAllowed(req, res, 'GET, POST');
      return;
    }

    const body = await readJson(req, MAX_CONFIG_BODY_BYTES);
    const profileSource = body.profile !== undefined
      ? body.profile
      : (body.name !== undefined ? body : undefined);
    if (profileSource !== undefined) {
      state.profile = normalizeProfile(profileSource, state.profile);
    }
    if (body.settings !== null && typeof body.settings === 'object') {
      const requested = {};
      for (const key of RUNTIME_SETTINGS) {
        if (body.settings[key] !== undefined) {
          requested[key] = body.settings[key];
        }
      }
      // 主动消息设置支持局部更新：App 只传 enabled 时不要清掉其它字段。
      if (requested.proactive !== null && typeof requested.proactive === 'object') {
        requested.proactive = { ...options.proactive, ...requested.proactive };
      }
      const next = normalizeOptions({ ...options, ...requested });
      Object.assign(options, next);
      runner.applyApprovalPolicy(options.approvalPolicy);
      proactive.configure();
      if (options.approvalPolicy === 'never') {
        approvals.cancelAll();
      }
    }
    state.updatedAt = Date.now();
    schedulePersist();
    sendJson(res, 200, {
      saved: true,
      profile: state.profile,
      settings: {
        approvalPolicy: options.approvalPolicy,
        approvalTimeoutMs: options.approvalTimeoutMs,
        fallbackPreset: options.fallbackPreset,
        chatTimeoutMs: options.chatTimeoutMs,
        taskTimeoutMs: options.taskTimeoutMs,
        maxQueue: options.maxQueue,
        sessionMaxTurns: options.sessionMaxTurns,
        workspaceEnabled: options.workspaceEnabled,
        workspaceTitle: options.workspaceTitle,
        maxUploadBytes: options.maxUploadBytes,
        maxFiles: options.maxFiles,
        taskResume: options.taskResume,
        statePath: options.statePath,
        proactive: { ...options.proactive }
      },
      updatedAt: state.updatedAt
    });
  }

  async function handlePet(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    if (methodOf(req) !== 'POST') {
      methodNotAllowed(req, res, 'POST');
      return;
    }
    const body = await readJson(req, MAX_CONFIG_BODY_BYTES);
    const action = trimText(body.action, 32) ?? 'pet';
    if (action !== 'pet') {
      sendError(res, 400, 'unsupported-action', 'only "pet" is supported');
      return;
    }
    // 心情和亲密度由 App 本地决定；插件只确认互动并给出建议动作。
    const reply = {
      schemaVersion: SCHEMA_VERSION,
      requestId: trimText(body.requestId, 128) ?? null,
      accepted: true,
      action: 'pet',
      mood: 'happy',
      emotion: 'happy',
      animation: 'happy'
    };
    events.broadcast('companion.interaction', { action: 'pet', emotion: 'happy' });
    sendJson(res, 200, reply);
  }

  function prepareChat(body) {
    const context = normalizeCompanionContext(body, state.profile);
    if (context.profile !== null) {
      state.profile = context.profile;
      state.updatedAt = Date.now();
    }
    return context;
  }

  function fallbackEmotionOf(context) {
    return context.state.mood === 'idle' ? 'happy' : context.state.mood;
  }

  function finishChat(context, result) {
    const fallbackEmotion = fallbackEmotionOf(context);
    const reply = parseModelReply(result.text, {
      requestId: context.requestId,
      fallbackEmotion
    });
    reply.taskEvents = result.steps;
    rememberReply(context.requestId, reply);
    events.broadcast('companion.message', { reply });
    return reply;
  }

  async function handleChat(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    if (methodOf(req) !== 'POST') {
      methodNotAllowed(req, res, 'POST');
      return;
    }
    const body = await readJson(req, MAX_CHAT_BODY_BYTES);
    const context = prepareChat(body);
    const cached = chatCache.get(context.requestId);
    if (cached !== undefined) {
      sendJson(res, 200, cached);
      return;
    }
    const instruction = buildChatInput(context, state.profile.name);
    const result = await runner.runTurn(instruction, {
      timeoutMs: options.chatTimeoutMs,
      fallbackEmotion: fallbackEmotionOf(context)
    });
    sendJson(res, 200, finishChat(context, result));
  }

  /**
   * SSE 流式对话：event: delta / reply / error。
   * 正文从模型的「正文 + [[meta]]」输出里增量提取，不会把 JSON 打给用户。
   */
  async function handleChatStream(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    if (methodOf(req) !== 'POST') {
      methodNotAllowed(req, res, 'POST');
      return;
    }
    const body = await readJson(req, MAX_CHAT_BODY_BYTES);
    const context = prepareChat(body);
    const cached = chatCache.get(context.requestId);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.flushHeaders?.();

    let finished = false;
    let clientGone = false;
    const controller = new AbortController();
    const send = (event, data) => {
      if (finished || clientGone) {
        return false;
      }
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        return false;
      }
    };
    res.on?.('close', () => {
      if (!finished) {
        clientGone = true;
        controller.abort();
      }
    });
    const heartbeat = setInterval(() => {
      if (!finished && !clientGone) {
        try {
          res.write(': ping\n\n');
        } catch {
          // 连接已断开，close 会处理
        }
      }
    }, 15_000);
    heartbeat.unref?.();

    try {
      if (cached !== undefined) {
        send('reply', cached);
        return;
      }
      const extractor = new ReplyTextExtractor();
      const instruction = buildChatInput(context, state.profile.name);
      const result = await runner.runTurn(instruction, {
        timeoutMs: options.chatTimeoutMs,
        signal: controller.signal,
        fallbackEmotion: fallbackEmotionOf(context),
        onDelta: (chunk) => {
          const delta = extractor.push(chunk);
          if (delta.length > 0) {
            const delivered = send('delta', { requestId: context.requestId, text: delta });
            if (!delivered) {
              clientGone = true;
              controller.abort();
            }
          }
        },
        onTool: (tool) => {
          const delivered = send('tool', { requestId: context.requestId, ...tool });
          if (!delivered) {
            clientGone = true;
            controller.abort();
          }
        }
      });
      const tail = extractor.finish();
      if (tail.length > 0) {
        send('delta', { requestId: context.requestId, text: tail });
      }
      send('reply', finishChat(context, result));
    } catch (error) {
      if (!clientGone) {
        send('error', {
          code: typeof error?.code === 'string' ? error.code : 'internal',
          message: typeof error?.message === 'string' ? error.message : 'request failed'
        });
      }
    } finally {
      finished = true;
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {
        // 已经断开
      }
    }
  }

  async function handleTasks(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    const method = methodOf(req);
    if (method === 'GET') {
      const query = queryOf(req);
      const limit = Number.parseInt(query.get('limit') ?? '', 10);
      const status = query.get('status') ?? undefined;
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        tasks: tasks.list({ limit: Number.isFinite(limit) ? limit : 20, status }),
        active: tasks.activeCount(),
        events: events.count()
      });
      return;
    }
    if (method !== 'POST') {
      methodNotAllowed(req, res, 'GET, POST');
      return;
    }

    const body = await readJson(req, MAX_TASK_BODY_BYTES);
    const input = normalizeTaskRequest(body);
    const attachedFiles = input.fileIds.map((fileId) => files.require(fileId));
    const filesView = attachedFiles.map((file) => files.view(file));
    const { task, created } = tasks.create({ ...input, files: filesView });
    if (created) {
      scheduleTask(task);
    }
    const view = tasks.view(task);
    events.broadcast('companion.task', { task: view });
    sendJson(res, created ? 202 : 200, {
      schemaVersion: SCHEMA_VERSION,
      created,
      task: view
    });
  }

  async function handleTaskCancel(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    if (methodOf(req) !== 'POST') {
      methodNotAllowed(req, res, 'POST');
      return;
    }
    const body = await readJson(req, MAX_TASK_BODY_BYTES);
    const taskId = trimText(body.taskId, 128);
    if (taskId === undefined) {
      throw new CompanionError('bad-request', 'taskId is required', 400);
    }
    const outcome = tasks.cancel(taskId);
    const view = tasks.view(outcome.task);
    events.broadcast('companion.task', { task: view });
    sendJson(res, 200, {
      schemaVersion: SCHEMA_VERSION,
      requestId: trimText(body.requestId, 128) ?? null,
      cancelled: outcome.cancelled,
      task: view
    });
  }

  async function handleApprovals(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    const method = methodOf(req);
    if (method === 'GET') {
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        approvals: approvals.list(),
        pending: approvals.pendingCount(),
        history: approvals.history(10)
      });
      return;
    }
    if (method !== 'POST') {
      methodNotAllowed(req, res, 'GET, POST');
      return;
    }
    const body = await readJson(req, MAX_CONFIG_BODY_BYTES);
    const approvalId = trimText(body.approvalId, 128);
    if (approvalId === undefined) {
      throw new CompanionError('bad-request', 'approvalId is required', 400);
    }
    const decision = body.decision === 'allow' || body.decision === 'approve'
      ? 'allow'
      : (body.decision === 'reject' || body.decision === 'deny' ? 'reject' : undefined);
    if (decision === undefined) {
      throw new CompanionError('bad-request', 'decision must be "allow" or "reject"', 400);
    }
    const approval = approvals.decide(approvalId, decision);
    if (approval === null) {
      throw new CompanionError('approval-not-found', 'approval not found or already decided', 404);
    }
    sendJson(res, 200, {
      schemaVersion: SCHEMA_VERSION,
      requestId: trimText(body.requestId, 128) ?? null,
      approval
    });
  }

  async function handleFiles(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    const method = methodOf(req);
    if (method === 'GET') {
      const query = queryOf(req);
      const limit = Number.parseInt(query.get('limit') ?? '', 10);
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        files: files.list({ limit: Number.isFinite(limit) ? limit : 20 }),
        count: files.count(),
        maxUploadBytes: options.maxUploadBytes
      });
      return;
    }
    if (method !== 'POST') {
      methodNotAllowed(req, res, 'GET, POST');
      return;
    }

    const workspaceInfo = await workspace.resolve();
    if (!workspaceInfo?.path) {
      throw new CompanionError('workspace-unavailable', 'the companion workspace is not available', 409);
    }
    const query = queryOf(req);
    const headerName = req.headers['x-companion-filename'];
    let rawName = query.get('name') ?? 'file.bin';
    if (typeof headerName === 'string' && headerName.length > 0) {
      try {
        rawName = decodeURIComponent(headerName);
      } catch {
        rawName = headerName;
      }
    }
    const name = sanitizeFilename(rawName);
    const buffer = await readRawBody(req, options.maxUploadBytes);
    if (buffer.length === 0) {
      throw new CompanionError('bad-request', 'empty upload', 400);
    }

    const uploadsDir = path.join(workspaceInfo.path, 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const id = `f_${randomUUID()}`;
    let storedName = name;
    let absolutePath = path.join(uploadsDir, storedName);
    if (existsSync(absolutePath)) {
      storedName = `${id}-${name}`;
      absolutePath = path.join(uploadsDir, storedName);
    }
    // 路径必须落在 uploads/ 内，避免文件名穿越。
    const resolvedDir = path.resolve(uploadsDir);
    const resolvedFile = path.resolve(absolutePath);
    if (resolvedFile !== path.join(resolvedDir, storedName)) {
      throw new CompanionError('bad-request', 'invalid file name', 400);
    }
    await writeFile(resolvedFile, buffer);
    const contentType = typeof req.headers['content-type'] === 'string'
      ? req.headers['content-type'].slice(0, 100)
      : 'application/octet-stream';
    const file = files.add({
      id,
      name,
      bytes: buffer.length,
      contentType,
      relPath: `uploads/${storedName}`,
      absolutePath: resolvedFile,
      createdAt: Date.now()
    });
    events.broadcast('companion.file', { file: files.view(file), count: files.count() });
    sendJson(res, 201, {
      schemaVersion: SCHEMA_VERSION,
      file: files.view(file)
    });
  }

  async function handleFileDelete(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    if (methodOf(req) !== 'POST') {
      methodNotAllowed(req, res, 'POST');
      return;
    }
    const body = await readJson(req, MAX_CONFIG_BODY_BYTES);
    const fileId = trimText(body.fileId, 128);
    if (fileId === undefined) {
      throw new CompanionError('bad-request', 'fileId is required', 400);
    }
    files.require(fileId);
    files.remove(fileId);
    events.broadcast('companion.file', { file: null, fileId, count: files.count() });
    sendJson(res, 200, {
      schemaVersion: SCHEMA_VERSION,
      requestId: trimText(body.requestId, 128) ?? null,
      deleted: true,
      count: files.count()
    });
  }

  async function handleProactive(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    const method = methodOf(req);
    if (method === 'GET') {
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        ...proactive.status(),
        recent: proactive.recentMessages(10)
      });
      return;
    }
    if (method !== 'POST') {
      methodNotAllowed(req, res, 'GET, POST');
      return;
    }
    const body = await readJson(req, MAX_CONFIG_BODY_BYTES);
    if (body.action === 'context') {
      proactive.setContext(body.context);
      schedulePersist();
      sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, saved: true });
      return;
    }
    if (body.action === 'test') {
      const sent = await proactive.trigger('test');
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        sent,
        reason: sent ? 'sent' : (proactive.lastSkip ?? 'not-sent'),
        message: proactive.lastMessage ?? null,
        status: proactive.status()
      });
      return;
    }
    if (body.action === 'feedback') {
      const messageId = trimText(body.messageId, 128);
      const value = body.feedback;
      if (messageId === undefined || !['like', 'dislike', 'dismiss'].includes(value)) {
        throw new CompanionError('bad-request', 'messageId and feedback are required', 400);
      }
      const ok = proactive.recordFeedback(messageId, value);
      sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, recorded: ok, status: proactive.status() });
      return;
    }
    throw new CompanionError('bad-request', 'action must be "test" or "feedback"', 400);
  }

  async function handleBiliConfig(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    const method = methodOf(req);
    if (method === 'GET') {
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        config: bili.publicConfig()
      });
      return;
    }
    if (method !== 'POST') {
      methodNotAllowed(req, res, 'GET, POST');
      return;
    }
    const body = await readJson(req, MAX_CONFIG_BODY_BYTES);
    const saved = bili.saveConfig(body);
    sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, saved: true, config: saved });
  }

  async function handleBiliRun(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    if (methodOf(req) !== 'POST') {
      methodNotAllowed(req, res, 'POST');
      return;
    }
    const body = await readJson(req, MAX_CONFIG_BODY_BYTES);
    let result;
    try {
      result = await bili.run({ force: body.force === true });
    } catch (error) {
      sendError(res, 400, 'bili-failed', error?.message ?? 'B站活动失败');
      return;
    }
    sendJson(res, 200, {
      schemaVersion: SCHEMA_VERSION,
      ...result
    });
  }

  async function handleBiliStatus(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'GET') {
      methodNotAllowed(req, res, 'GET');
      return;
    }
    sendJson(res, 200, {
      schemaVersion: SCHEMA_VERSION,
      config: bili.publicConfig()
    });
  }

  async function handleBiliQr(req, res) {
    if (!admit(ctx, req, res)) return;
    if (!options.enabled) {
      sendError(res, 409, 'disabled', 'whale companion is disabled');
      return;
    }
    if (methodOf(req) !== 'POST') {
      methodNotAllowed(req, res, 'POST');
      return;
    }
    const body = await readJson(req, MAX_CONFIG_BODY_BYTES);
    try {
      if (body.action === 'start') {
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ...(await bili.qrStart()) });
        return;
      }
      if (body.action === 'poll') {
        sendJson(res, 200, {
          schemaVersion: SCHEMA_VERSION,
          ...(await bili.qrPoll(trimText(body.sessionId, 128)))
        });
        return;
      }
      if (body.action === 'cancel') {
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ...bili.qrCancel() });
        return;
      }
      throw new Error('action must be start, poll or cancel');
    } catch (error) {
      sendError(res, 400, 'bili-login-failed', error?.message ?? 'B站登录失败');
    }
  }

  async function handleEventsHttp(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'GET') {
      methodNotAllowed(req, res, 'GET');
      return;
    }
    sendError(res, 426, 'upgrade-required', 'connect to this path with a websocket upgrade');
  }

  // ---------------------------------------------------------------- routing

  function wrap(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        logError(log, req, error);
        if (res.headersSent) {
          res.end();
          return;
        }
        if (isCompanionError(error)) {
          sendError(res, error.status, error.code, error.message);
        } else {
          sendError(res, 500, 'internal', 'request failed');
        }
      }
    };
  }

  const routes = [
    { kind: 'exact', path: '/companion/health', handler: handleHealth },
    { kind: 'exact', path: '/companion/config', handler: handleConfig },
    { kind: 'exact', path: '/companion/pet', handler: handlePet },
    { kind: 'exact', path: '/companion/chat', handler: handleChat },
    { kind: 'exact', path: '/companion/chat/stream', handler: handleChatStream },
    { kind: 'exact', path: '/companion/tasks', handler: handleTasks },
    { kind: 'exact', path: '/companion/tasks/cancel', handler: handleTaskCancel },
    { kind: 'exact', path: '/companion/approvals', handler: handleApprovals },
    { kind: 'exact', path: '/companion/files', handler: handleFiles },
    { kind: 'exact', path: '/companion/files/delete', handler: handleFileDelete },
    { kind: 'exact', path: '/companion/proactive', handler: handleProactive },
    { kind: 'exact', path: '/companion/bili/config', handler: handleBiliConfig },
    { kind: 'exact', path: '/companion/bili/run', handler: handleBiliRun },
    { kind: 'exact', path: '/companion/bili/status', handler: handleBiliStatus },
    { kind: 'exact', path: '/companion/bili/login/qr', handler: handleBiliQr },
    { kind: 'exact', path: '/companion/events', handler: handleEventsHttp }
  ];

  function handleUpgrade(req, socket, head) {
    if (!admitUpgrade(ctx, req, socket)) {
      return;
    }
    try {
      const client = acceptWebSocket(req, socket, head);
      if (client !== null) {
        events.add(client);
        log(`websocket event stream opened (${events.count()} client(s))`);
      }
    } catch (error) {
      log(`websocket upgrade failed: ${error?.message ?? error}`);
      try {
        socket.destroy();
      } catch {
        // 忽略
      }
    }
  }

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register({
      ...route,
      handler: wrap(route.handler)
    }));
    disposers.push(ctx.webServer.registerUpgrade({
      path: '/companion/events',
      handler: handleUpgrade
    }));

    return () => {
      bili.stop();
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 已经注销的路由忽略
        }
      }
      events.closeAll();
      approvals.cancelAll();
      proactive.stop();
      void runner.dispose();
      stateStore.flush(snapshotState);
      log('companion routes disposed');
    };
  }, 'dsh-whale-companion: companion routes');

  log(`v${PLUGIN_VERSION} loaded, enabled=${String(options.enabled)}, workspace=${options.workspaceEnabled ? 'on' : 'off'}`);
}

// 导出内部模块，便于测试直接覆盖。
export { normalizeOptions } from './config.js';
export { foldTurnEvents } from './agent-runner.js';
export { taskView };
