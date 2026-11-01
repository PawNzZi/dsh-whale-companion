/**
 * 鲸鱼娘专属 Agent 预设。
 *
 * 预设决定隐藏会话能看到哪些工具：
 *   - 时间上下文；
 *   - shell（Windows 用 pwsh，其它平台用 bash）；
 *   - 文件读写与搜索。
 *
 * 刻意不挂：子代理、工作流、计划模式、浏览器、skill、todo、goal。
 * 那些能力会让一个「桌面伙伴」变成一个完整的 coding agent，既增加误操作面，
 * 也让每轮 prompt 变大。需要时在 profile 里 override 这个预设即可。
 *
 * 0.2.x 通过 `agentPresets.register()` 在运行时注册；
 * 0.1.x 没有 register，只能退回内置的 standard 预设。
 */

export function companionPresetDefinition(id = 'whale-companion') {
  const windows = process.platform === 'win32';
  return {
    id,
    name: '鲸鱼娘',
    description: 'HDSH 鲸鱼娘：对话 + 电脑端任务执行（shell / 文件）',
    order: 50,
    plugins: [
      {
        id: 'time-context',
        name: '@deepseek-ai/dsh-time-context'
      },
      {
        id: 'tool-bash',
        name: '@deepseek-ai/dsh-tool-bash',
        disabled: windows
      },
      {
        id: 'tool-pwsh',
        name: '@deepseek-ai/dsh-tool-pwsh',
        disabled: !windows
      },
      {
        id: 'tool-fs',
        name: '@deepseek-ai/dsh-tool-fs'
      },
      {
        id: 'tool-fs-search',
        name: '@deepseek-ai/dsh-tool-fs-search',
        config: {
          sampleOverCapGlobResults: false
        }
      }
    ]
  };
}
