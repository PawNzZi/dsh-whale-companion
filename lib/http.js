/**
 * HTTP 工具：鉴权、方法检查、请求体读取与 JSON 响应。
 *
 * host-webserver 本身不做统一鉴权，所有 /companion/* 路由都必须经过 admit()。
 */
import { CompanionError } from './errors.js';

export function methodOf(req) {
  return (req.method ?? 'GET').toUpperCase();
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

export function sendError(res, status, error, message) {
  sendJson(res, status, { error, message });
}

export function methodNotAllowed(req, res, allow) {
  res.writeHead(405, { allow });
  res.end();
}

/**
 * 校验 DSH 的连接鉴权。
 *
 * 不同 DSH 版本的 `connection` 服务暴露的鉴权入口不同：
 *   - 0.2.x：`admit(request)` → `{ peer }` | `{ rejection }`
 *   - 0.1.x：`requestRejection(request)` → `401 | 403 | undefined`
 * 两种都支持，避免插件只能在某一个版本上跑。
 *
 * @returns {{ ok: true } | { ok: false, status: number, reason: string }}
 */
export function connectionAdmission(ctx, req) {
  const connection = ctx.connection;
  try {
    if (typeof connection?.admit === 'function') {
      const admission = connection.admit(req);
      if (admission === undefined || admission === null || typeof admission !== 'object') {
        return { ok: false, status: 401, reason: 'admit returned no admission' };
      }
      if ('rejection' in admission) {
        return {
          ok: false,
          status: admission.rejection === 403 ? 403 : 401,
          reason: `admit rejected: ${String(admission.rejection)}`
        };
      }
      if ('peer' in admission) {
        return { ok: true };
      }
      return { ok: false, status: 401, reason: `unknown admission shape: ${Object.keys(admission).join(',')}` };
    }
    if (typeof connection?.requestRejection === 'function') {
      const rejection = connection.requestRejection(req);
      if (rejection === undefined) {
        return { ok: true };
      }
      return {
        ok: false,
        status: rejection === 403 ? 403 : 401,
        reason: `requestRejection: ${String(rejection)}`
      };
    }
    return { ok: false, status: 401, reason: 'connection service exposes no admission method' };
  } catch (error) {
    return { ok: false, status: 401, reason: `admission threw: ${error?.message ?? error}` };
  }
}

/**
 * 校验 HTTP 请求；失败时已经写出 401/403。
 * @returns {boolean} 已通过时 true
 */
export function admit(ctx, req, res) {
  const verdict = connectionAdmission(ctx, req);
  if (verdict.ok) {
    return true;
  }
  debugAdmission(verdict.reason);
  sendError(
    res,
    verdict.status,
    verdict.status === 403 ? 'forbidden' : 'unauthorized',
    'DSH authentication required'
  );
  return false;
}

/** 只在显式开启调试时输出鉴权细节，避免正常日志泄露 Cookie/Peer。 */
function debugAdmission(message) {
  if (process.env.DSH_WHALE_DEBUG === '1') {
    console.info(`[dsh-whale-companion] ${message}`);
  }
}

export function queryOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export function readBody(req, limit) {
  return readRawBody(req, limit).then((buffer) => buffer.toString('utf8'));
}

/** 二进制上传用；超限抛 413 CompanionError。 */
export function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > limit) {
        finish(reject, new CompanionError('payload-too-large', 'request body is too large', 413));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', (error) => finish(reject, error));
  });
}

export async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (raw.trim().length === 0) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CompanionError('bad-request', 'invalid json body', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CompanionError('bad-request', 'a JSON object body is required', 400);
  }
  return parsed;
}
