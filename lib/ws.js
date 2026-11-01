/**
 * 零依赖的 WebSocket 服务端（RFC 6455 的最小子集）。
 *
 * 插件不引入 `ws` 依赖：DSH 的 webServer 只负责把 upgrade 交给我们，
 * 握手、帧编解码、ping/pong、close 都由这里完成。只支持服务端推送
 * 文本帧和客户端发来的少量控制帧，足够 /companion/events 使用。
 */
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 1024 * 1024;

const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  426: 'Upgrade Required'
};

/** 在握手前拒绝 upgrade：直接写一段 HTTP 响应并关闭 socket。 */
export function rejectUpgrade(socket, status = 401, message = '') {
  const reason = STATUS_TEXT[status] ?? 'Error';
  const body = message.length > 0 ? message : reason;
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        'connection: close\r\n' +
        'content-type: text/plain; charset=utf-8\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        '\r\n' +
        body
    );
  } catch {
    // socket 可能已经断开
  }
  socket.destroy();
}

export function isWebSocketUpgrade(req) {
  const upgrade = String(req.headers?.upgrade ?? '').toLowerCase();
  if (upgrade !== 'websocket') {
    return false;
  }
  const key = req.headers?.['sec-websocket-key'];
  return typeof key === 'string' && key.trim().length > 0;
}

/**
 * 完成握手并返回一个客户端对象。失败时返回 null（socket 已被拒绝或销毁）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 */
export function acceptWebSocket(req, socket, head) {
  if (!isWebSocketUpgrade(req)) {
    rejectUpgrade(socket, 400, 'websocket upgrade required');
    return null;
  }
  const version = String(req.headers['sec-websocket-version'] ?? '13');
  if (version !== '13') {
    rejectUpgrade(socket, 426, 'unsupported websocket version');
    return null;
  }
  const key = String(req.headers['sec-websocket-key']).trim();
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  try {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'upgrade: websocket\r\n' +
        'connection: Upgrade\r\n' +
        `sec-websocket-accept: ${accept}\r\n` +
        '\r\n'
    );
  } catch {
    socket.destroy();
    return null;
  }
  if (typeof socket.setNoDelay === 'function') {
    socket.setNoDelay(true);
  }
  if (typeof socket.setKeepAlive === 'function') {
    socket.setKeepAlive(true, 30_000);
  }
  return new WebSocketClient(socket, head);
}

export class WebSocketClient {
  constructor(socket, head) {
    this.socket = socket;
    this.closed = false;
    this.alive = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.onmessage = null;
    this.onclose = null;

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#markClosed());
    socket.on('error', () => this.#markClosed());
    if (head && head.length > 0) {
      this.#onData(head);
    }
  }

  sendText(text) {
    this.#writeFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  sendJson(value) {
    this.sendText(JSON.stringify(value));
  }

  ping() {
    this.#writeFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) {
      return;
    }
    const reasonBuffer = Buffer.from(reason, 'utf8').subarray(0, 120);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.#writeFrame(0x8, payload);
    try {
      this.socket.end();
    } catch {
      // 忽略
    }
    this.#markClosed();
  }

  terminate() {
    try {
      this.socket.destroy();
    } catch {
      // 忽略
    }
    this.#markClosed();
  }

  #markClosed() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    try {
      this.onclose?.();
    } catch {
      // 监听器异常不影响其他连接
    }
  }

  #writeFrame(opcode, payload) {
    if (this.closed) {
      return;
    }
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
      header.writeUInt32BE(length >>> 0, 6);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.#markClosed();
    }
  }

  #onData(chunk) {
    if (this.closed) {
      return;
    }
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    while (!this.closed) {
      if (this.buffer.length < 2) {
        return;
      }
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        length = high * 2 ** 32 + low;
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) {
        this.close(1009, 'frame too large');
        return;
      }
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + length) {
        return;
      }
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (mask !== null) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      this.buffer = this.buffer.subarray(offset + length);
      this.#onFrame(fin, opcode, payload, masked);
    }
  }

  #onFrame(fin, opcode, payload, masked) {
    switch (opcode) {
      case 0x0: {
        if (this.fragmentOpcode === 0) {
          this.close(1002, 'unexpected continuation frame');
          return;
        }
        this.fragments.push(payload);
        if (fin) {
          const combined = Buffer.concat(this.fragments);
          const type = this.fragmentOpcode;
          this.fragments = [];
          this.fragmentOpcode = 0;
          this.#deliver(type, combined);
        }
        return;
      }
      case 0x1:
      case 0x2: {
        if (this.fragmentOpcode !== 0) {
          this.close(1002, 'interleaved data frame');
          return;
        }
        if (fin) {
          this.#deliver(opcode, payload);
          return;
        }
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        return;
      }
      case 0x8:
        this.close(1000, '');
        return;
      case 0x9:
        this.#writeFrame(0xa, payload);
        return;
      case 0xa:
        this.alive = true;
        return;
      default:
        this.close(1002, `unsupported opcode ${opcode}`);
        return;
    }
  }

  #deliver(opcode, payload) {
    if (opcode !== 0x1) {
      return;
    }
    if (!payload || payload.length === 0) {
      return;
    }
    try {
      this.onmessage?.(payload.toString('utf8'));
    } catch {
      // 监听器异常不影响连接
    }
  }
}
