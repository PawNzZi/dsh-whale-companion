/**
 * 隐藏工作区：给鲸鱼娘的会话一个稳定的电脑端目录。
 *
 * 目录不存在时会创建；如果当前 profile 挂载了 workspaceRegistry，还会把它
 * 注册成一个名为「鲸鱼娘」的工作区（桌面端可见，App 负责在列表里过滤）。
 */
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function defaultWorkspacePath() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, 'WhaleCompanion');
}

/**
 * @param {object} input
 * @param {import('@deepseek-ai/cordis').Context} input.ctx
 * @param {object} input.options
 * @param {(message: string) => void} input.log
 */
export function createWorkspaceResolver({ ctx, options, log }) {
  let resolved = null;
  let pending = null;

  async function resolve() {
    if (!options.workspaceEnabled) {
      return null;
    }
    if (resolved !== null) {
      return resolved;
    }
    if (pending !== null) {
      return pending;
    }
    pending = (async () => {
      try {
        const target = path.resolve(options.workspacePath || defaultWorkspacePath());
        await mkdir(target, { recursive: true });
        const registry = ctx.get('workspaceRegistry');
        let id = null;
        if (registry && typeof registry.create === 'function') {
          const workspace = await registry.create(target, options.workspaceTitle);
          id = workspace?.id ?? null;
        }
        resolved = { path: target, id, title: options.workspaceTitle };
        log(`workspace ready: ${target}${id === null ? '' : ` (${id})`}`);
        return resolved;
      } catch (error) {
        log(`warning: workspace unavailable: ${error?.message ?? error}`);
        return { path: null, id: null, title: options.workspaceTitle };
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  function info() {
    return resolved;
  }

  return { resolve, info };
}
