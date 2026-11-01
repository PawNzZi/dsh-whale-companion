/**
 * /companion/events 的事件中心。
 *
 * 插件只做「有连接就推送」：App 没连时不排队、不补发，保证语义简单。
 * 事件都是结构化 JSON，App 根据 type 决定刷新卡片/未读/任务列表。
 */
import { SCHEMA_VERSION } from './constants.js';

export class CompanionEvents {
  constructor({ log, version, heartbeatMs = 30_000 }) {
    this.log = log;
    this.version = version;
    this.heartbeatMs = heartbeatMs;
    this.clients = new Set();
    this.timer = null;
  }

  add(client) {
    this.clients.add(client);
    client.onclose = () => this.remove(client);
    client.onmessage = (raw) => this.#incoming(client, raw);
    client.sendJson({
      type: 'companion.hello',
      schemaVersion: SCHEMA_VERSION,
      version: this.version,
      time: Date.now(),
      clients: this.clients.size
    });
    this.#ensureHeartbeat();
    this.log(`event client connected (${this.clients.size})`);
  }

  remove(client) {
    if (this.clients.delete(client)) {
      this.log(`event client disconnected (${this.clients.size})`);
    }
    if (this.clients.size === 0) {
      this.#stopHeartbeat();
    }
  }

  /** 向所有在线 App 广播一个事件；type 形如 companion.task。 */
  broadcast(type, payload = {}) {
    if (this.clients.size === 0) {
      return;
    }
    const frame = {
      type,
      schemaVersion: SCHEMA_VERSION,
      time: Date.now(),
      ...payload
    };
    for (const client of this.clients) {
      try {
        client.sendJson(frame);
      } catch {
        // 单个连接的写入失败由心跳/close 回收
      }
    }
  }

  count() {
    return this.clients.size;
  }

  closeAll() {
    this.#stopHeartbeat();
    for (const client of this.clients) {
      try {
        client.close(1001, 'server shutting down');
      } catch {
        // 忽略
      }
    }
    this.clients.clear();
  }

  #incoming(client, raw) {
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    if (value.type === 'ping') {
      client.sendJson({ type: 'companion.pong', schemaVersion: SCHEMA_VERSION, time: Date.now() });
    }
  }

  #ensureHeartbeat() {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      for (const client of this.clients) {
        if (!client.alive) {
          client.terminate();
          this.remove(client);
          continue;
        }
        client.alive = false;
        try {
          client.ping();
        } catch {
          client.terminate();
          this.remove(client);
        }
      }
    }, this.heartbeatMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  #stopHeartbeat() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
