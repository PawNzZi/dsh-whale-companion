/**
 * 上传文件元数据。
 *
 * 字节保存在隐藏工作区的 `uploads/` 下，这里只维护元数据和淘汰策略；
 * 任务通过 fileId 引用文件，prompt 里只出现相对路径。
 */
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { CompanionError } from './errors.js';

/** 把用户文件名压成安全的单段文件名（保留中文和扩展名）。 */
export function sanitizeFilename(name) {
  const raw = typeof name === 'string' ? name : '';
  const base = path.basename(raw)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const safe = base.length > 0 ? base.slice(0, 120) : 'file.bin';
  return safe;
}

export class FileStore {
  constructor({ maxFiles = 100, onChange } = {}) {
    this.maxFiles = maxFiles;
    this.onChange = onChange;
    this.files = new Map();
    this.order = [];
  }

  restore(entries) {
    if (!Array.isArray(entries)) {
      return;
    }
    for (const raw of entries.slice(0, this.maxFiles)) {
      if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string') {
        continue;
      }
      if (typeof raw.relPath !== 'string' || typeof raw.absolutePath !== 'string') {
        continue;
      }
      const file = {
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : 'file.bin',
        bytes: Number.isFinite(raw.bytes) ? raw.bytes : 0,
        contentType: typeof raw.contentType === 'string' ? raw.contentType : 'application/octet-stream',
        relPath: raw.relPath,
        absolutePath: raw.absolutePath,
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
      };
      this.files.set(file.id, file);
      this.order.push(file.id);
    }
  }

  add(file) {
    this.files.set(file.id, file);
    this.order.push(file.id);
    this.#trim();
    this.onChange?.();
    return file;
  }

  get(id) {
    return this.files.get(id);
  }

  require(id) {
    const file = this.files.get(id);
    if (file === undefined) {
      throw new CompanionError('file-not-found', 'uploaded file not found or already removed', 404);
    }
    return file;
  }

  count() {
    return this.files.size;
  }

  list({ limit = 20 } = {}) {
    const safeLimit = Math.min(this.maxFiles, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const result = [];
    for (let index = this.order.length - 1; index >= 0 && result.length < safeLimit; index -= 1) {
      const file = this.files.get(this.order[index]);
      if (file !== undefined) {
        result.push(this.view(file));
      }
    }
    return result;
  }

  view(file) {
    return {
      id: file.id,
      name: file.name,
      bytes: file.bytes,
      contentType: file.contentType,
      path: file.relPath,
      createdAt: file.createdAt
    };
  }

  /** 删除元数据与磁盘文件；任务里已经保存的快照不受影响。 */
  remove(id) {
    const file = this.files.get(id);
    if (file === undefined) {
      return false;
    }
    this.files.delete(id);
    const index = this.order.indexOf(id);
    if (index >= 0) {
      this.order.splice(index, 1);
    }
    try {
      unlinkSync(file.absolutePath);
    } catch {
      // 文件可能已被用户删除
    }
    this.onChange?.();
    return true;
  }

  toJSON() {
    return this.order
      .map((id) => this.files.get(id))
      .filter((file) => file !== undefined)
      .map((file) => ({ ...file }));
  }

  #trim() {
    while (this.order.length > this.maxFiles) {
      const oldest = this.order.shift();
      const file = this.files.get(oldest);
      this.files.delete(oldest);
      if (file !== undefined) {
        try {
          unlinkSync(file.absolutePath);
        } catch {
          // 忽略
        }
      }
    }
  }
}
