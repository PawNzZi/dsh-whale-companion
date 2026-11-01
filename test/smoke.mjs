/**
 * 插件装配冒烟测试（不启动 DSH）：
 *   node test/smoke.mjs
 *
 * 用假的 ctx / Agent 覆盖：
 *   - 路由注册 / dispose / 鉴权版本兼容；
 *   - health / config / pet / chat（含 SSE 流式）/ tasks / approvals / files / proactive；
 *   - requestId 幂等、任务排队与取消、附件任务、审批暂停与恢复；
 *   - 主动消息模板/模型模式、每日上限、免打扰；
 *   - 状态持久化、中断恢复、任务跨进程续跑。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply, foldTurnEvents } from '../lib/index.js';
import { ApprovalBridge } from '../lib/approval-bridge.js';
import { ProactiveScheduler } from '../lib/proactive.js';
import { parseModelReply } from '../lib/protocol.js';

const JSON_REPLY = JSON.stringify({
  text: '今天也要加油哦，我陪着你。',
  emotion: 'happy',
  action: 'nod',
  memoryCandidates: [{ text: '用户喜欢被鼓励', kind: 'preference', confidence: 0.8 }],
  growthSignals: [{ type: 'chat', value: 1 }]
});

// ---------------------------------------------------------------- helpers

function mockResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(data = '') {
      this.body = String(data);
    }
  };
}

function mockStreamResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    handlers: {},
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    flushHeaders() {},
    write(chunk) {
      this.body += String(chunk);
    },
    end() {
      this.writableEnded = true;
    },
    on(event, handler) {
      this.handlers[event] = handler;
    }
  };
}

function parseSse(body) {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith(':'))
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
      return { event, data };
    })
    .filter((entry) => entry.event !== undefined);
}

function request(method, body) {
  const req = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = '/companion/test';
  req.headers = {};
  return req;
}

function rawRequest(method, payload, headers = {}) {
  const req = payload === undefined ? Readable.from([]) : Readable.from([payload]);
  req.method = method;
  req.url = '/companion/files';
  req.headers = headers;
  return req;
}

function createFakeAgent() {
  let seq = 0;
  let pending = 0;
  let waiters = [];
  const events = [];
  const inputs = [];
  const streamHandlers = [];
  const sessionHandlers = [];

  const settle = (text) => {
    events.push({ type: 'assistant/message', seq: seq++, data: { message: { content: [{ type: 'text', text }] } } });
    events.push({ type: 'turn/end', seq: seq++, data: { turn: 1, reason: { kind: 'completed' } } });
    pending = Math.max(0, pending - 1);
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve();
  };

  const agent = {
    id: 'agent-test',
    block: false,
    stream: false,
    tools: [],
    followupCount: 0,
    cancelCount: 0,
    inputs,
    streamHandlers,
    sessionHandlers,
    release: null,
    session: {
      get seq() {
        return seq;
      },
      snapshotEvents(from) {
        return events.filter((event) => event.seq >= from);
      }
    },
    followup(message) {
      agent.followupCount += 1;
      const text = (message.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      inputs.push(text);
      pending += 1;
      events.push({ type: 'user/message', seq: seq++, data: {} });
      for (const tool of agent.tools) {
        for (const handler of sessionHandlers) {
          handler(null, { type: 'tool/call', data: { callId: tool.id, name: tool.name } });
        }
        for (const handler of sessionHandlers) {
          handler(null, {
            type: 'tool/result',
            data: {
              // 真实宿主不一定在 result 上带 toolCallId，runner 需要按调用顺序配对。
              message: {},
              ...(tool.status === 'failed' ? { error: { code: 'denied' } } : {})
            }
          });
        }
      }
      if (agent.stream) {
        agent.emitStream(agent.responseText(text));
      }
      if (agent.block) {
        agent.release = () => settle(agent.responseText(text));
        return;
      }
      settle(agent.responseText(text));
    },
    emitStream(full) {
      const chunks = [full.slice(0, 8), full.slice(8, 24), full.slice(24)].filter((part) => part.length > 0);
      for (const part of chunks) {
        for (const handler of streamHandlers) {
          handler({ frame: { type: 'chunk', chunk: { type: 'text-delta', text: part } } });
        }
      }
      for (const handler of streamHandlers) {
        handler({ frame: { type: 'end' } });
      }
    },
    whenIdle() {
      if (pending === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    cancel() {
      agent.cancelCount += 1;
      if (agent.release !== null) {
        const release = agent.release;
        agent.release = null;
        release();
      }
    },
    responseText() {
      return JSON_REPLY;
    }
  };
  return agent;
}

function createCtx(admission, { connection } = {}) {
  const routes = new Map();
  const upgrades = new Map();
  const disposers = [];
  const sections = [];
  const policies = [];
  const created = [];
  const disposed = [];
  const registeredPresets = [];
  const mountedPresets = [];
  const approvalHandlers = [];
  const resumedSessions = [];
  const agent = createFakeAgent();

  const services = {
    agents: {
      async create(options) {
        created.push(options);
        await options.setup?.(agentCtx);
        return {
          agent,
          async dispose() {
            disposed.push(agent);
          }
        };
      },
      async resume(options) {
        resumedSessions.push(options.resumeSessionId);
        await options.setup?.(agentCtx);
        return {
          agent,
          async dispose() {
            disposed.push(agent);
          }
        };
      }
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' })
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition);
        return () => {};
      },
      getSectionOrder: () => 0
    },
    approval: {
      setPolicy(target, policy) {
        policies.push({ agent: target, policy });
      }
    },
    agentPresets: {
      async register(definition) {
        registeredPresets.push(definition);
        return async () => {};
      },
      async mount(target, id) {
        mountedPresets.push(id);
        return { id };
      }
    },
    workspaceRegistry: {
      async create(workspacePath, title) {
        return { id: 'ws-test', title, path: workspacePath };
      }
    }
  };
  const agentCtx = {
    get: (serviceName) => services[serviceName],
    on(event, handler) {
      if (event === 'approval/request') {
        approvalHandlers.push(handler);
      } else if (event === 'agent/assistant-stream') {
        agent.streamHandlers.push(handler);
      } else if (event === 'session/event') {
        agent.sessionHandlers.push(handler);
      }
      return () => {};
    }
  };

  const ctx = {
    logger: { info: () => {} },
    connection: connection ?? { admit: () => admission },
    webServer: {
      register(definition) {
        if (routes.has(definition.path)) {
          throw new Error(`duplicate ${definition.path}`);
        }
        routes.set(definition.path, definition);
        return () => routes.delete(definition.path);
      },
      registerUpgrade(definition) {
        upgrades.set(definition.path, definition);
        return () => upgrades.delete(definition.path);
      }
    },
    get: (serviceName) => services[serviceName],
    effect(fn) {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    }
  };
  const statePath = path.join(os.tmpdir(), `dsh-whale-state-${randomUUID()}.json`);
  return {
    ctx,
    routes,
    upgrades,
    disposers,
    sections,
    policies,
    created,
    disposed,
    registeredPresets,
    mountedPresets,
    approvalHandlers,
    resumedSessions,
    agent,
    services,
    statePath
  };
}

async function call(routes, routePath, method, body) {
  const res = mockResponse();
  const route = routes.get(routePath);
  assert.ok(route, `route ${routePath} should be registered`);
  await route.handler(request(method, body), res);
  return { status: res.status, json: res.body.length > 0 ? JSON.parse(res.body) : null };
}

async function callRaw(routes, routePath, req) {
  const res = mockResponse();
  const route = routes.get(routePath);
  assert.ok(route, `route ${routePath} should be registered`);
  await route.handler(req, res);
  return { status: res.status, json: res.body.length > 0 ? JSON.parse(res.body) : null };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function disposeAll(context) {
  for (const dispose of context.disposers.reverse()) {
    if (typeof dispose === 'function') {
      dispose();
    }
  }
}

// ---------------------------------------------------------------- 装配 / health

const authorized = createCtx({ peer: { id: 'test' } });
apply(authorized.ctx, {
  enabled: true,
  minAppVersion: '0.1.0',
  workspaceEnabled: false,
  statePath: authorized.statePath
});
assert.equal(authorized.routes.size, 16);
assert.ok(authorized.upgrades.has('/companion/events'));

const health = await call(authorized.routes, '/companion/health', 'GET');
assert.equal(health.status, 200);
assert.equal(health.json.version, '0.8.0');
assert.equal(health.json.enabled, true);
for (const capability of ['chat', 'task', 'file', 'approval', 'proactive', 'events']) {
  assert.ok(health.json.capabilities.includes(capability), `missing ${capability}`);
}
assert.equal(health.json.session.sessionActive, false);
assert.equal(health.json.approvals, 0);
assert.equal(health.json.files, 0);
assert.equal(health.json.proactive.enabled, false);

const healthMethod = await call(authorized.routes, '/companion/health', 'POST', {});
assert.equal(healthMethod.status, 405);

// ---------------------------------------------------------------- config / pet

const configPost = await call(authorized.routes, '/companion/config', 'POST', {
  profile: { name: '小鲸', personality: 'genki' }
});
assert.equal(configPost.status, 200);
assert.equal(configPost.json.profile.name, '小鲸');
assert.equal(configPost.json.profile.userTitle, '你');
const configGet = await call(authorized.routes, '/companion/config', 'GET');
assert.equal(configGet.json.settings.approvalPolicy, 'app');
const settingsPost = await call(authorized.routes, '/companion/config', 'POST', {
  settings: { approvalPolicy: 'ask', chatTimeoutMs: 30_000 }
});
assert.equal(settingsPost.json.settings.approvalPolicy, 'app');
assert.equal(settingsPost.json.settings.chatTimeoutMs, 30_000);

const pet = await call(authorized.routes, '/companion/pet', 'POST', { action: 'pet' });
assert.equal(pet.status, 200);
assert.equal(pet.json.animation, 'happy');

// ---------------------------------------------------------------- chat

const chatBody = {
  schemaVersion: 1,
  requestId: 'req-1',
  profile: { name: '小鲸', userTitle: '主人', personality: 'genki', verbosity: 'short' },
  state: { mood: 'happy', affinity: 120, trust: 35, level: 4, moodReason: 'task_completed' },
  memory: [{ id: 'm1', text: '用户喜欢先看结论', kind: 'preference', confidence: 0.9 }],
  recentMessages: [{ role: 'user', text: '帮我整理一下今天的任务' }],
  message: '今天还有什么要做的？'
};
const chat = await call(authorized.routes, '/companion/chat', 'POST', chatBody);
assert.equal(chat.status, 200);
assert.equal(chat.json.text, '今天也要加油哦，我陪着你。');
assert.equal(chat.json.emotion, 'happy');
assert.equal(chat.json.action, 'nod');
assert.equal(chat.json.memoryCandidates.length, 1);
assert.equal(authorized.created.length, 1);
assert.match(authorized.created[0].sessionId, /^whale-companion-/);
assert.equal(authorized.sections.length, 2);
const personaPrefix = authorized.sections.find((section) => section.name === 'deployment:persona-prefix');
const personaSection = authorized.sections.find((section) => section.name === 'whale-companion:persona');
assert.ok(personaPrefix);
assert.ok(personaSection);
assert.match(personaSection.text(), /主人/);
assert.equal(authorized.registeredPresets[0].id, 'whale-companion');
assert.deepEqual(authorized.mountedPresets, ['whale-companion']);
assert.equal(authorized.approvalHandlers.length, 1);
assert.equal(authorized.agent.streamHandlers.length, 1);
assert.equal(authorized.policies.at(-1)?.policy, 'ask');
assert.match(authorized.agent.inputs[0], /用户喜欢先看结论/);

await call(authorized.routes, '/companion/chat', 'POST', chatBody);
assert.equal(authorized.agent.followupCount, 1);
const missingMessage = await call(authorized.routes, '/companion/chat', 'POST', { requestId: 'req-2' });
assert.equal(missingMessage.status, 400);
assert.equal(missingMessage.json.error, 'bad-request');
const badSchema = await call(authorized.routes, '/companion/chat', 'POST', { schemaVersion: 2, message: 'hi' });
assert.equal(badSchema.status, 400);
assert.equal(badSchema.json.error, 'schema-version');

// ---------------------------------------------------------------- SSE streaming

const streamCtx = createCtx({ peer: { id: 'test' } });
apply(streamCtx.ctx, { enabled: true, workspaceEnabled: false, statePath: streamCtx.statePath });
streamCtx.agent.stream = true;
streamCtx.agent.tools = [{ id: 'call-1', name: 'pwsh' }];
const streamRes = mockStreamResponse();
await streamCtx.routes.get('/companion/chat/stream').handler(
  request('POST', { requestId: 'stream-1', message: '你好' }),
  streamRes
);
const streamEvents = parseSse(streamRes.body);
const streamedText = streamEvents
  .filter((entry) => entry.event === 'delta')
  .map((entry) => JSON.parse(entry.data).text)
  .join('');
assert.equal(streamedText, '今天也要加油哦，我陪着你。');
const finalReply = JSON.parse(streamEvents.find((entry) => entry.event === 'reply').data);
assert.equal(finalReply.text, '今天也要加油哦，我陪着你。');
const toolEvents = streamEvents
  .filter((entry) => entry.event === 'tool')
  .map((entry) => JSON.parse(entry.data));
assert.deepEqual(
  toolEvents.map((tool) => [tool.phase, tool.name, tool.status ?? null]),
  [['call', 'pwsh', null], ['result', 'pwsh', 'completed']]
);

streamCtx.agent.tools = [];
streamCtx.agent.responseText = () => '第一句。\n第二句。\n[[meta]]{"emotion":"cute","action":"wave"}';
const taggedRes = mockStreamResponse();
await streamCtx.routes.get('/companion/chat/stream').handler(
  request('POST', { requestId: 'stream-2', message: '再说一句' }),
  taggedRes
);
const taggedEvents = parseSse(taggedRes.body);
const taggedText = taggedEvents
  .filter((entry) => entry.event === 'delta')
  .map((entry) => JSON.parse(entry.data).text)
  .join('');
assert.equal(taggedText, '第一句。\n第二句。');
const taggedReply = JSON.parse(taggedEvents.find((entry) => entry.event === 'reply').data);
assert.equal(taggedReply.text, '第一句。\n第二句。');
assert.equal(taggedReply.emotion, 'cute');
assert.equal(taggedReply.action, 'wave');
disposeAll(streamCtx);

// ---------------------------------------------------------------- tasks

const taskPost = await call(authorized.routes, '/companion/tasks', 'POST', {
  requestId: 'task-req-1',
  kind: 'command',
  title: '看看磁盘',
  instruction: '执行 df -h 并总结'
});
assert.equal(taskPost.status, 202);
const taskId = taskPost.json.task.id;
await new Promise((resolve) => setTimeout(resolve, 30));
let taskList = await call(authorized.routes, '/companion/tasks', 'GET');
assert.equal(taskList.json.tasks.find((task) => task.id === taskId).status, 'succeeded');

const duplicateTask = await call(authorized.routes, '/companion/tasks', 'POST', {
  requestId: 'task-req-1',
  instruction: '重复提交'
});
assert.equal(duplicateTask.status, 200);
assert.equal(duplicateTask.json.created, false);

authorized.agent.block = true;
const blocking = await call(authorized.routes, '/companion/tasks', 'POST', {
  title: '阻塞任务',
  instruction: '先别结束'
});
const queued = await call(authorized.routes, '/companion/tasks', 'POST', {
  title: '排队任务',
  instruction: '排队中'
});
assert.equal((await call(authorized.routes, '/companion/tasks/cancel', 'POST', { taskId: queued.json.task.id })).json.task.status, 'cancelled');
await new Promise((resolve) => setTimeout(resolve, 10));
const runningCancel = await call(authorized.routes, '/companion/tasks/cancel', 'POST', { taskId: blocking.json.task.id });
assert.equal(runningCancel.json.task.status, 'cancelled');
assert.ok(authorized.agent.cancelCount >= 1);
authorized.agent.block = false;
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal((await call(authorized.routes, '/companion/tasks/cancel', 'POST', { taskId: 'nope' })).status, 404);

// ---------------------------------------------------------------- approvals

const approvalCtx = createCtx({ peer: { id: 'test' } });
apply(approvalCtx.ctx, { enabled: true, workspaceEnabled: false, statePath: approvalCtx.statePath });
approvalCtx.agent.block = true;
const pendingChatPromise = call(approvalCtx.routes, '/companion/chat', 'POST', {
  requestId: 'approval-chat',
  message: '帮我做一件需要审批的事'
});
await waitFor(() => approvalCtx.approvalHandlers.length === 1);
const approvalOutcome = approvalCtx.approvalHandlers[0]({
  toolName: 'shell',
  reason: 'write outside workspace',
  signal: new AbortController().signal
});
await waitFor(async () => (await call(approvalCtx.routes, '/companion/approvals', 'GET')).json.pending === 1);
const pendingView = (await call(approvalCtx.routes, '/companion/approvals', 'GET')).json.approvals[0];
assert.equal(pendingView.toolName, 'shell');
const allowed = await call(approvalCtx.routes, '/companion/approvals', 'POST', {
  approvalId: pendingView.id,
  decision: 'allow'
});
assert.equal(allowed.json.approval.status, 'allowed');
assert.equal(await approvalOutcome, 'allowed-once');
assert.equal((await call(approvalCtx.routes, '/companion/approvals', 'POST', {
  approvalId: pendingView.id,
  decision: 'allow'
})).status, 404);
approvalCtx.agent.release();
assert.equal((await pendingChatPromise).status, 200);
assert.equal((await call(approvalCtx.routes, '/companion/approvals', 'GET')).json.pending, 0);
disposeAll(approvalCtx);

const taskApprovalCtx = createCtx({ peer: { id: 'test' } });
apply(taskApprovalCtx.ctx, { enabled: true, workspaceEnabled: false, statePath: taskApprovalCtx.statePath });
taskApprovalCtx.agent.block = true;
const waitingTaskPost = await call(taskApprovalCtx.routes, '/companion/tasks', 'POST', {
  title: '写文件',
  instruction: '在桌面写一个文件'
});
const waitingTaskId = waitingTaskPost.json.task.id;
await waitFor(() => taskApprovalCtx.approvalHandlers.length === 1);
const taskApprovalOutcome = taskApprovalCtx.approvalHandlers[0]({
  toolName: 'fs',
  reason: 'write file',
  signal: new AbortController().signal
});
await waitFor(async () => {
  const list = (await call(taskApprovalCtx.routes, '/companion/tasks', 'GET')).json.tasks;
  return list.find((task) => task.id === waitingTaskId)?.status === 'waiting-approval';
});
const waitingTask = (await call(taskApprovalCtx.routes, '/companion/tasks', 'GET')).json.tasks
  .find((task) => task.id === waitingTaskId);
const rejected = await call(taskApprovalCtx.routes, '/companion/approvals', 'POST', {
  approvalId: waitingTask.approval.id,
  decision: 'reject'
});
assert.equal(rejected.json.approval.status, 'rejected');
assert.equal(await taskApprovalOutcome, 'rejected');
await waitFor(async () => {
  const list = (await call(taskApprovalCtx.routes, '/companion/tasks', 'GET')).json.tasks;
  return list.find((task) => task.id === waitingTaskId)?.status === 'running';
});
taskApprovalCtx.agent.release();
await waitFor(async () => {
  const list = (await call(taskApprovalCtx.routes, '/companion/tasks', 'GET')).json.tasks;
  return list.find((task) => task.id === waitingTaskId)?.status === 'succeeded';
});
disposeAll(taskApprovalCtx);

// ApprovalBridge 单元行为
const bridgeFrames = [];
const bridge = new ApprovalBridge({
  events: { broadcast: (type, payload) => bridgeFrames.push({ type, payload }), count: () => 0 },
  options: { approvalPolicy: 'app', approvalTimeoutMs: 40 },
  log: () => {},
  getTaskId: () => null
});
assert.equal(await bridge.request({ toolName: 'timeout-tool', signal: new AbortController().signal }), 'rejected');
const cancelController = new AbortController();
const cancelledRequest = bridge.request({ toolName: 'cancel-tool', signal: cancelController.signal });
await new Promise((resolve) => setTimeout(resolve, 5));
cancelController.abort();
assert.equal(await cancelledRequest, 'cancelled');
const denyBridge = new ApprovalBridge({
  events: { broadcast: () => {}, count: () => 0 },
  options: { approvalPolicy: 'never', approvalTimeoutMs: 50 },
  log: () => {},
  getTaskId: () => null
});
assert.equal(await denyBridge.request({ toolName: 'never-tool' }), 'rejected');

// 审批历史恢复：pending → expired
const pendingBridge = new ApprovalBridge({
  events: { broadcast: () => {}, count: () => 0 },
  options: { approvalPolicy: 'app', approvalTimeoutMs: 5000 },
  log: () => {},
  getTaskId: () => null
});
const pendingPromise = pendingBridge.request({ toolName: 'restore-tool', signal: new AbortController().signal });
const savedApprovals = pendingBridge.toJSON();
assert.equal(savedApprovals.pending.length, 1);
const restoredBridge = new ApprovalBridge({
  events: { broadcast: () => {}, count: () => 0 },
  options: { approvalPolicy: 'app', approvalTimeoutMs: 5000 },
  log: () => {},
  getTaskId: () => null
});
restoredBridge.restore(savedApprovals);
assert.equal(restoredBridge.pendingCount(), 0);
assert.equal(restoredBridge.history(5)[0].status, 'expired');
pendingBridge.cancelAll();
await pendingPromise;

// ---------------------------------------------------------------- files

const uploadCtx = createCtx({ peer: { id: 'test' } });
const workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-whale-workspace-'));
apply(uploadCtx.ctx, {
  enabled: true,
  workspaceEnabled: true,
  workspacePath: workspaceDir,
  statePath: uploadCtx.statePath
});
const uploaded = await callRaw(
  uploadCtx.routes,
  '/companion/files',
  rawRequest('POST', Buffer.from('附件内容：今天要开心', 'utf8'), {
    'content-type': 'text/plain',
    'x-companion-filename': encodeURIComponent('笔记.txt')
  })
);
assert.equal(uploaded.status, 201);
assert.equal(uploaded.json.file.name, '笔记.txt');
assert.equal(uploaded.json.file.path, 'uploads/笔记.txt');
assert.ok(existsSync(path.join(workspaceDir, 'uploads', '笔记.txt')));
const fileId = uploaded.json.file.id;

const fileTask = await call(uploadCtx.routes, '/companion/tasks', 'POST', {
  kind: 'file',
  instruction: '读一下附件，用一句话总结',
  fileIds: [fileId]
});
assert.equal(fileTask.status, 202);
assert.equal(fileTask.json.task.files[0].id, fileId);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.match(uploadCtx.agent.inputs.at(-1), /【附件】/);
assert.match(uploadCtx.agent.inputs.at(-1), /uploads\/笔记\.txt/);
assert.equal((await call(uploadCtx.routes, '/companion/files', 'GET')).json.count, 1);
assert.equal((await call(uploadCtx.routes, '/companion/files/delete', 'POST', { fileId })).json.deleted, true);
assert.equal(existsSync(path.join(workspaceDir, 'uploads', '笔记.txt')), false);
disposeAll(uploadCtx);
rmSync(workspaceDir, { recursive: true, force: true });

// ---------------------------------------------------------------- proactive

const proactiveCtx = createCtx({ peer: { id: 'test' } });
apply(proactiveCtx.ctx, { enabled: true, workspaceEnabled: false, statePath: proactiveCtx.statePath });
const proactiveConfig = await call(proactiveCtx.routes, '/companion/config', 'POST', {
  settings: {
    proactive: {
      enabled: true,
      dailyLimit: 1,
      minIntervalMinutes: 60,
      quietStart: '00:00',
      quietEnd: '00:00'
    }
  }
});
assert.equal(proactiveConfig.json.settings.proactive.enabled, true);
const proactiveStatus = await call(proactiveCtx.routes, '/companion/proactive', 'GET');
assert.equal(proactiveStatus.json.clients, 0);
const proactiveTest = await call(proactiveCtx.routes, '/companion/proactive', 'POST', { action: 'test' });
assert.equal(proactiveTest.json.sent, true);
assert.equal(proactiveTest.json.reason, 'sent');
assert.equal(typeof proactiveTest.json.message.text, 'string');
disposeAll(proactiveCtx);

let fakeNow = new Date(2026, 9, 24, 10, 0, 0).getTime();
const schedulerFrames = [];
const scheduler = new ProactiveScheduler({
  events: { count: () => 1, broadcast: (type, payload) => schedulerFrames.push({ type, payload }) },
  options: {
    proactive: {
      enabled: true,
      mode: 'template',
      dailyLimit: 1,
      minIntervalMinutes: 120,
      quietStart: '00:00',
      quietEnd: '00:00',
      templates: ['你好 {userTitle}']
    }
  },
  getProfile: () => ({ name: '鲸鱼娘', userTitle: '主人' }),
  log: () => {},
  now: () => fakeNow
});
assert.equal(await scheduler.trigger('test'), true);
assert.equal(schedulerFrames[0].payload.message.text, '你好 主人');
assert.equal(await scheduler.trigger('test'), true);
fakeNow += 24 * 60 * 60 * 1000;
assert.equal(await scheduler.trigger('test'), true);
scheduler.stop();

const quietScheduler = new ProactiveScheduler({
  events: { count: () => 1, broadcast: () => {} },
  options: {
    proactive: {
      enabled: true,
      mode: 'template',
      dailyLimit: 3,
      minIntervalMinutes: 60,
      quietStart: '00:00',
      quietEnd: '23:59',
      templates: ['安静时段']
    }
  },
  getProfile: () => ({ name: '鲸鱼娘', userTitle: '主人' }),
  log: () => {},
  now: () => new Date(2026, 9, 24, 12, 0, 0).getTime()
});
assert.equal(await quietScheduler.tick(), false);
assert.equal(await quietScheduler.trigger('test'), true);
quietScheduler.stop();

const modelFrames = [];
let modelCalls = 0;
const modelScheduler = new ProactiveScheduler({
  events: { count: () => 1, broadcast: (type, payload) => modelFrames.push(payload) },
  options: {
    proactive: {
      enabled: true,
      mode: 'model',
      dailyLimit: 1,
      minIntervalMinutes: 60,
      quietStart: '00:00',
      quietEnd: '00:00',
      generationTimeoutMs: 1000,
      templates: ['模板兜底']
    }
  },
  getProfile: () => ({ name: '鲸鱼娘', userTitle: '主人' }),
  log: () => {},
  now: () => new Date(2026, 9, 24, 15, 0, 0).getTime(),
  generate: async () => {
    modelCalls += 1;
    return { text: '模型生成的关心' };
  }
});
assert.equal(await modelScheduler.trigger('test'), true);
assert.equal(modelCalls, 1);
assert.equal(modelFrames[0].message.text, '模型生成的关心');
assert.equal(modelFrames[0].message.source, 'model');
modelScheduler.stop();

// ---------------------------------------------------------------- persistence

const writeStatePath = path.join(os.tmpdir(), `dsh-whale-write-${randomUUID()}.json`);
const writeCtx = createCtx({ peer: { id: 'test' } });
apply(writeCtx.ctx, { enabled: true, workspaceEnabled: false, statePath: writeStatePath });
await call(writeCtx.routes, '/companion/tasks', 'POST', {
  requestId: 'persist-task',
  title: '持久化任务',
  instruction: '写进状态文件'
});
await new Promise((resolve) => setTimeout(resolve, 800));
const persisted = JSON.parse(readFileSync(writeStatePath, 'utf8'));
assert.equal(persisted.version, 1);
assert.ok(persisted.tasks.some((task) => task.title === '持久化任务'));
disposeAll(writeCtx);
rmSync(writeStatePath, { force: true });

const restorePath = path.join(os.tmpdir(), `dsh-whale-restore-${randomUUID()}.json`);
writeFileSync(restorePath, JSON.stringify({
  version: 1,
  savedAt: Date.now(),
  tasks: [{
    id: 't_restored',
    kind: 'chat',
    title: '被中断的任务',
    instruction: '不要真的执行',
    status: 'running',
    createdAt: Date.now() - 1000,
    startedAt: Date.now() - 900,
    finishedAt: null,
    result: null,
    emotion: null,
    error: null,
    approval: null,
    files: [],
    steps: [],
    requestId: 'restored-1',
    attempt: 1,
    resumeOnRestart: false,
    resumedAt: null
  }],
  files: [],
  approvals: {
    pending: [{ id: 'a_restored', toolName: 'shell', taskId: 't_restored', createdAt: Date.now() - 500, expiresAt: Date.now() + 1000 }],
    history: []
  },
  proactive: {
    day: '2000-01-01',
    sentToday: 3,
    lastSentAt: Date.now() - 1000,
    recent: [],
    feedback: { like: 1, dislike: 0, dismiss: 0 }
  }
}, null, 2), 'utf8');
const restoreCtx = createCtx({ peer: { id: 'test' } });
apply(restoreCtx.ctx, { enabled: true, workspaceEnabled: false, statePath: restorePath });
const restoredTask = (await call(restoreCtx.routes, '/companion/tasks', 'GET')).json.tasks
  .find((task) => task.id === 't_restored');
assert.equal(restoredTask.status, 'failed');
assert.equal(restoredTask.error.code, 'interrupted');
const restoredApprovals = await call(restoreCtx.routes, '/companion/approvals', 'GET');
assert.equal(restoredApprovals.json.pending, 0);
assert.equal(restoredApprovals.json.history[0].status, 'expired');
const restoredHealth = await call(restoreCtx.routes, '/companion/health', 'GET');
assert.equal(restoredHealth.json.proactive.sentToday, 0);
assert.equal(restoredHealth.json.proactive.feedback.like, 1);
disposeAll(restoreCtx);
rmSync(restorePath, { force: true });

const resumePath = path.join(os.tmpdir(), `dsh-whale-resume-${randomUUID()}.json`);
writeFileSync(resumePath, JSON.stringify({
  version: 1,
  savedAt: Date.now(),
  tasks: [{
    id: 't_resume',
    kind: 'chat',
    title: '续跑任务',
    instruction: '重启后继续这条指令',
    status: 'running',
    createdAt: Date.now() - 1000,
    startedAt: Date.now() - 900,
    finishedAt: null,
    result: null,
    emotion: null,
    error: null,
    approval: null,
    files: [],
    steps: [],
    requestId: 'resume-1',
    attempt: 1,
    resumeOnRestart: true,
    resumedAt: null,
    sessionId: 'sess-resume-1'
  }],
  files: [],
  approvals: { pending: [], history: [] },
  proactive: { day: '2000-01-01', sentToday: 0, lastSentAt: null, recent: [], feedback: { like: 0, dislike: 0, dismiss: 0 } }
}, null, 2), 'utf8');
const resumeCtx = createCtx({ peer: { id: 'test' } });
apply(resumeCtx.ctx, {
  enabled: true,
  workspaceEnabled: false,
  statePath: resumePath,
  taskResume: 'opt-in'
});
await waitFor(async () => {
  const list = (await call(resumeCtx.routes, '/companion/tasks', 'GET')).json.tasks;
  return list.find((task) => task.id === 't_resume')?.status === 'succeeded';
});
const resumedTask = (await call(resumeCtx.routes, '/companion/tasks', 'GET')).json.tasks
  .find((task) => task.id === 't_resume');
assert.equal(resumedTask.attempt, 2);
assert.ok(resumedTask.resumedAt !== null);
assert.deepEqual(resumeCtx.resumedSessions, ['sess-resume-1']);
assert.match(resumeCtx.agent.inputs.at(-1), /【继续任务】/);
assert.match(resumeCtx.agent.inputs.at(-1), /重启后继续这条指令/);
disposeAll(resumeCtx);
rmSync(resumePath, { force: true });

// resume 失败时回退为正常重跑（新 session + 原始指令）
const fallbackPath = path.join(os.tmpdir(), `dsh-whale-fallback-${randomUUID()}.json`);
writeFileSync(fallbackPath, JSON.stringify({
  version: 1,
  savedAt: Date.now(),
  tasks: [{
    id: 't_fallback',
    kind: 'chat',
    title: '回退任务',
    instruction: '回退后重新执行',
    status: 'running',
    createdAt: Date.now() - 1000,
    startedAt: Date.now() - 900,
    finishedAt: null,
    result: null,
    emotion: null,
    error: null,
    approval: null,
    files: [],
    steps: [],
    requestId: 'fallback-1',
    attempt: 1,
    resumeOnRestart: true,
    resumedAt: null,
    sessionId: 'sess-missing'
  }],
  files: [],
  approvals: { pending: [], history: [] },
  proactive: { day: '2000-01-01', sentToday: 0, lastSentAt: null, recent: [], feedback: { like: 0, dislike: 0, dismiss: 0 } }
}, null, 2), 'utf8');
const fallbackCtx = createCtx({ peer: { id: 'test' } });
fallbackCtx.services.agents.resume = async () => {
  throw new Error('session not found');
};
apply(fallbackCtx.ctx, {
  enabled: true,
  workspaceEnabled: false,
  statePath: fallbackPath,
  taskResume: 'opt-in'
});
await waitFor(async () => {
  const list = (await call(fallbackCtx.routes, '/companion/tasks', 'GET')).json.tasks;
  return list.find((task) => task.id === 't_fallback')?.status === 'succeeded';
});
assert.match(fallbackCtx.agent.inputs.at(-1), /【后台任务】/);
disposeAll(fallbackCtx);
rmSync(fallbackPath, { force: true });

// ---------------------------------------------------------------- auth / rotation

const disabled = createCtx({ peer: { id: 'test' } });
apply(disabled.ctx, { enabled: false, workspaceEnabled: false, statePath: disabled.statePath });
const disabledHealth = await call(disabled.routes, '/companion/health', 'GET');
assert.equal(disabledHealth.json.enabled, false);
assert.deepEqual(disabledHealth.json.capabilities, []);
assert.equal((await call(disabled.routes, '/companion/chat', 'POST', { message: 'hi' })).status, 409);

const denied = createCtx({ rejection: 401 });
apply(denied.ctx, { enabled: true, workspaceEnabled: false, statePath: denied.statePath });
assert.equal((await call(denied.routes, '/companion/health', 'GET')).status, 401);

const legacy = createCtx(undefined, { connection: { requestRejection: () => undefined } });
apply(legacy.ctx, { enabled: true, workspaceEnabled: false, statePath: legacy.statePath });
assert.equal((await call(legacy.routes, '/companion/health', 'GET')).status, 200);
const legacyDenied = createCtx(undefined, { connection: { requestRejection: () => 403 } });
apply(legacyDenied.ctx, { enabled: true, workspaceEnabled: false, statePath: legacyDenied.statePath });
assert.equal((await call(legacyDenied.routes, '/companion/health', 'GET')).status, 403);

const rotating = createCtx({ peer: { id: 'test' } });
apply(rotating.ctx, {
  enabled: true,
  workspaceEnabled: false,
  sessionMaxTurns: 1,
  statePath: rotating.statePath
});
assert.equal((await call(rotating.routes, '/companion/chat', 'POST', { message: '你好' })).status, 200);
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal((await call(rotating.routes, '/companion/health', 'GET')).json.session.sessionActive, false);
assert.equal(rotating.disposed.length, 1);
disposeAll(rotating);

// ---------------------------------------------------------------- fold / parse

const folded = foldTurnEvents([
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'tool/call', seq: 2, data: { callId: 'c1', name: 'shell' } },
  { type: 'tool/result', seq: 3, data: { message: { toolCallId: 'c1' } } },
  { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '完成' }] } } },
  { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } }
]);
assert.equal(folded.text, '完成');
assert.deepEqual(folded.steps, [{ name: 'shell', status: 'completed' }]);

const foldedUnpaired = foldTurnEvents([
  { type: 'tool/call', seq: 1, data: { callId: 'x1', name: 'pwsh' } },
  { type: 'tool/call', seq: 2, data: { callId: 'x2', name: 'pwsh' } },
  { type: 'tool/result', seq: 3, data: { message: { toolCallId: 'unknown' }, error: { code: 'denied' } } },
  { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '被拒了' }] } } }
]);
assert.deepEqual(foldedUnpaired.steps, [
  { name: 'pwsh', status: 'failed' },
  { name: 'pwsh', status: 'called' }
]);

const parsedTagged = parseModelReply('好呀，我来啦。\n[[meta]]{"emotion":"proud","action":"wave","growthSignals":[{"type":"chat","value":1}]}', {
  requestId: 'tag-1',
  fallbackEmotion: 'happy'
});
assert.equal(parsedTagged.text, '好呀，我来啦。');
assert.equal(parsedTagged.emotion, 'proud');
assert.equal(parsedTagged.action, 'wave');

const legacyJsonReply = parseModelReply('{"text":"旧格式","emotion":"cute","action":"tilt"}', {
  requestId: 'legacy-1',
  fallbackEmotion: 'happy'
});
assert.equal(legacyJsonReply.text, '旧格式');
assert.equal(legacyJsonReply.emotion, 'cute');

const plainReply = parseModelReply('就是一句普通的话。', {
  requestId: 'plain-1',
  fallbackEmotion: 'concerned'
});
assert.equal(plainReply.text, '就是一句普通的话。');
assert.equal(plainReply.emotion, 'concerned');

// ---------------------------------------------------------------- dispose

disposeAll(authorized);
assert.equal(authorized.routes.size, 0);
assert.equal(authorized.upgrades.size, 0);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(authorized.disposed.length, 1);

for (const context of [authorized, disabled, denied, legacy, legacyDenied]) {
  rmSync(context.statePath, { force: true });
}

console.log('PASS  dsh-whale-companion smoke');
