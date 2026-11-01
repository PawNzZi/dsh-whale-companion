/**
 * 带 HTTP 语义的错误。
 *
 * App 依赖错误码区分「未开启 / 模型失败 / 任务失败 / 权限不足」，所以插件内部
 * 所有可预期失败都抛 CompanionError，路由层再映射成状态码。
 */
export class CompanionError extends Error {
  /**
   * @param {string} code 机器可读错误码
   * @param {string} message 面向用户/日志的说明
   * @param {number} [status] HTTP 状态码
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CompanionError';
    this.code = code;
    this.status = status;
  }
}

export function isCompanionError(error) {
  return error instanceof CompanionError;
}
