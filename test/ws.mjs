/**
 * /companion/events 的 WebSocket 集成测试：
 *   node test/ws.mjs
 *
 * 起一个真实的 http.Server，把插件注册的 upgrade / HTTP 路由接到 Node 的
 * request/upgrade 事件上，验证：
 *   1. 握手 101 + Sec-WebSocket-Accept；
 *   2. 连接后收到 companion.hello；
 *   3. 客户端 ping → companion.pong；
 *   4. 创建任务后收到 companion.task 推送；
 *   5. 未认证 upgrade 返回 401；
 *   6. dispose 后路由与连接都关闭。
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function createRoutedCtx() {
  const routes = new Map();
  const upgrades = new Map();
  const disposers = [];
  const state = { admission: { peer: { id: 'test' } } };
  const agent = {
    id: 'agent-ws',
    session: {
      seq: 0,
      snapshotEvents() {
        return [];
      }
    },
    followup() {},
    whenIdle() {
      return new Promise(() => {});
    },
    cancel() {}
  };
  const services = {
    agents: {
      async create(options) {
        await options.setup?.({ get: (name) => services[name] });
        return { agent, dispose: async () => {} };
      }
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    approval: { setPolicy: () => {} }
  };
  const ctx = {
    logger: { info: () => {} },
    connection: { admit: () => state.admission },
    webServer: {
      register(definition) {
        routes.set(definition.path, definition);
        return () => routes.delete(definition.path);
      },
      registerUpgrade(definition) {
        upgrades.set(definition.path, definition);
        return () => upgrades.delete(definition.path);
      }
    },
    get: (name) => services[name],
    effect(fn) {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    }
  };
  return { ctx, routes, upgrades, disposers, state, agent };
}

function parseFrames() {
  let buffer = Buffer.alloc(0);
  const messages = [];
  const waiters = [];
  return {
    messages,
    push(chunk) {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        const opcode = first & 0x0f;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = buffer.readUInt32BE(2) * 2 ** 32 + buffer.readUInt32BE(6);
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x1) {
          messages.push(JSON.parse(payload.toString('utf8')));
          for (const waiter of waiters.splice(0)) waiter();
        }
      }
    },
    async next(type, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = messages.find((message) => message.type === type);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
        await new Promise((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    }
  };
}

function maskedTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  assert.ok(payload.length < 126, 'test frame must stay short');
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

function upgrade(port, routePath) {
  const key = Buffer.from(String(Math.random())).toString('base64');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: routePath,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': key
      }
    });
    req.on('upgrade', (res, socket, head) => resolve({ res, socket, head, key }));
    req.on('response', (res) => resolve({ res, socket: null, head: null, key }));
    req.on('error', reject);
    req.end();
  });
}

function post(port, routePath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: routePath,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const { ctx, routes, upgrades, disposers, state } = createRoutedCtx();
const statePath = path.join(os.tmpdir(), `dsh-whale-ws-state-${randomUUID()}.json`);
apply(ctx, { enabled: true, workspaceEnabled: false, statePath });

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const route = routes.get(pathname);
  if (route === undefined) {
    res.writeHead(404);
    res.end();
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
});
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const route = upgrades.get(pathname);
  if (route === undefined) {
    socket.destroy();
    return;
  }
  Promise.resolve(route.handler(req, socket, head)).catch(() => socket.destroy());
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// 未认证 → 401
state.admission = { rejection: 401 };
const denied = await upgrade(port, '/companion/events');
assert.equal(denied.res.statusCode, 401);
assert.equal(denied.socket, null);

// 正常握手
state.admission = { peer: { id: 'test' } };
const connected = await upgrade(port, '/companion/events');
assert.equal(connected.res.statusCode, 101);
const expectedAccept = createHash('sha1').update(connected.key + GUID).digest('base64');
assert.equal(connected.res.headers['sec-websocket-accept'], expectedAccept);
assert.notEqual(connected.socket, null);

const frames = parseFrames();
connected.socket.on('data', (chunk) => frames.push(chunk));
if (connected.head && connected.head.length > 0) {
  frames.push(connected.head);
}

const hello = await frames.next('companion.hello');
assert.equal(hello.schemaVersion, 1);
assert.equal(hello.version, '0.8.0');

// ping / pong
connected.socket.write(maskedTextFrame(JSON.stringify({ type: 'ping' })));
const pong = await frames.next('companion.pong');
assert.equal(pong.schemaVersion, 1);

// 任务事件推送
const created = await post(port, '/companion/tasks', {
  kind: 'chat',
  instruction: '发一条会立刻完成的任务'
});
assert.equal(created.status, 202);
const pushed = await frames.next('companion.task');
assert.equal(pushed.task.id, created.json.task.id);

// dispose 关闭连接与路由
for (const dispose of disposers.reverse()) {
  if (typeof dispose === 'function') dispose();
}
assert.equal(routes.size, 0);
assert.equal(upgrades.size, 0);
await new Promise((resolve) => setTimeout(resolve, 50));
connected.socket.destroy();
server.close();
server.closeAllConnections?.();
rmSync(statePath, { force: true });

console.log('PASS  dsh-whale-companion websocket');
