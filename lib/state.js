/**
 * 插件状态持久化。
 *
 * 只保存「重启后还有意义」的运行时状态：
 *   - 任务（最近 50 条，执行中的会在重启后标记 interrupted）；
 *   - 上传文件元数据（文件本身在工作区 uploads/ 里）；
 *   - 审批历史（待审批在重启后转为 expired，不再可回答）；
 *   - 主动消息计数与反馈（避免重启后立刻重复打扰）。
 *
 * 人格、记忆、养成数据仍然只存在 App，不落这里。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SAVE_DEBOUNCE_MS = 500;

export function defaultStatePath() {
  if (typeof process.env.DSH_WHALE_STATE === 'string' && process.env.DSH_WHALE_STATE.trim().length > 0) {
    return path.resolve(process.env.DSH_WHALE_STATE.trim());
  }
  const home = process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
  return path.join(home, 'whale-companion', 'state.json');
}

export class StateStore {
  /**
   * @param {{file: string, log: (message: string) => void}} input
   */
  constructor({ file, log }) {
    this.file = file;
    this.log = log;
    this.timer = null;
    this.lastSavedAt = null;
  }

  /** 同步读取；损坏/不存在都当成空状态，不阻塞插件启动。 */
  load() {
    try {
      if (!existsSync(this.file)) {
        return null;
      }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) {
        this.log(`warning: ignoring incompatible state file: ${this.file}`);
        return null;
      }
      return parsed;
    } catch (error) {
      this.log(`warning: cannot read state file ${this.file}: ${error?.message ?? error}`);
      return null;
    }
  }

  schedule(getState) {
    if (this.timer !== null) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush(getState);
    }, SAVE_DEBOUNCE_MS);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /** 同步落盘：先写临时文件再 rename，避免进程中断留下半截 JSON。 */
  flush(getState) {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      const state = { version: 1, ...getState(), savedAt: Date.now() };
      const directory = path.dirname(this.file);
      mkdirSync(directory, { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
      renameSync(temporary, this.file);
      this.lastSavedAt = state.savedAt;
      return true;
    } catch (error) {
      this.log(`warning: cannot persist state to ${this.file}: ${error?.message ?? error}`);
      return false;
    }
  }

  info() {
    return { file: this.file, lastSavedAt: this.lastSavedAt };
  }
}
