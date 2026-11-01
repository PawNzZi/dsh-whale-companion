# hdsh-whale-companion

HDSH App 专属的「鲸鱼娘」插件，**无头运行在 DSH 里**。

它不提供桌面端 UI，也不注册桌面端入口。App 是唯一界面，负责角色动画、人格配置、记忆、养成数据和桌面卡片；插件负责对话运行时、任务执行和结构化事件。

完整产品设计见：[`../docs/WHALE_COMPANION.md`](../docs/WHALE_COMPANION.md)。

## 当前状态

已实现：

- Cordis 插件装配、路由 dispose；
- `ctx.connection.admit` 鉴权（HTTP 与 WebSocket upgrade）；
- `GET  /companion/health`；
- `GET  /companion/config`、`POST /companion/config`；
- `POST /companion/pet`；
- `POST /companion/chat`：人格 prompt 组装 + 隐藏 Agent 会话 + 结构化回复；
- `POST /companion/chat/stream`：SSE 流式对话，`delta` → `reply`（正文字符增量，不泄露 JSON/元数据）；
- `GET  /companion/tasks`、`POST /companion/tasks`、`POST /companion/tasks/cancel`；
- `GET  /companion/approvals`、`POST /companion/approvals`：高风险操作由 App 一次性放行/拒绝；
- `GET/POST /companion/files`、`POST /companion/files/delete`：上传附件、列出/删除文件；
- `GET/POST /companion/proactive`：主动消息状态、立即测试、反馈；
- **B站活动**：随机窗口内搜索/选片/读字幕，按鲸鱼娘人格生成分享文案并评论 `@` 主人，同时通过 `companion.bili` 推送到 App 对话；支持扫码登录、关键词、自动评论、每日次数与手动触发；
- `GET  /companion/events`：自带的零依赖 WebSocket 服务端，推送 `companion.message` / `companion.task` / `companion.approval` / `companion.proactive` / `companion.bili` / `companion.file` / `companion.interaction`；
- 专属 Agent 预设 `whale-companion`（0.2.x 运行时注册：shell + 文件工具；0.1.x 退回内置 `standard`）；
- 独立工作区（默认 `<用户目录>/WhaleCompanion`，标题「鲸鱼娘」）+ `uploads/` 附件目录；
- 主动消息调度：模板模式或模型模式，每天 3 条、最小间隔 2 小时、免打扰 22:30–08:00（App 可改），只在 App 连着 WS 时发；
- 任务、文件元数据、审批历史、主动消息计数持久化到 `<DSH_HOME>/whale-companion/state.json`；
- B站配置、分享历史与登录凭据分别持久化到 `<DSH_HOME>/whale-companion/bili.json`、`bili-state.json`、`bili-credentials.json`；
- 任务跨进程续跑（`taskResume: off/opt-in/all` + 任务级 `resumeOnRestart`；优先恢复同一隐藏 session，失败才回退重跑）；
- requestId 幂等、超时、队列上限、取消、session 轮换；
- 冒烟测试（`test/smoke.mjs`）与 WebSocket 集成测试（`test/ws.mjs`）。

尚未实现：

- App 侧审批 UI / 附件选择 / 卡片（属于 App，不在插件内）；
- 流式输出只给工具调用的 call/result 状态，不流 tool-call 参数增量。

> 人格配置、记忆和养成的长期真源始终是 App；插件持久化的只有任务/文件/审批/主动消息计数，重启后人格回到默认值，等待 App 重新下发。

## 架构

```text
App ── Companion API（Cookie 鉴权）──► hdsh-whale-companion
                                          │
                                          ├─ 人格 prompt 组装（systemPrompt section）
                                          ├─ 专属预设（shell / 文件工具）
                                          ├─ 隐藏 Agent（ctx.agents）
                                          ├─ 审批桥（approval/request → App）
                                          ├─ 任务队列（串行、可取消、可暂停）
                                          ├─ 附件存储（workspace/uploads）
                                          ├─ 主动消息调度（WS 在线才发）
                                          ├─ 状态持久化（state.json）
                                          └─ /companion/events（WebSocket 推送）
                                                     │
                                            隐藏工作区「鲸鱼娘」
```

关键点：

- 一个插件实例最多一个隐藏 Agent，chat 和 task 共用，串行执行；
- 每轮对话的上下文（状态 / 记忆 / 最近消息）都由 App 传入，插件不存长期记忆；
- 隐藏 Agent 的 system prompt 只放人格，心情、亲密度、记忆放在当轮 user 消息里；
- 流式对话从 `agent/assistant-stream` 的 text-delta 里增量提取正文，JSON/`[[meta]]` 不会露给 App；
- 专属预设只挂时间、shell、文件工具，不挂子代理/工作流/计划模式；
- 需要审批的操作转成 `companion.approval` 事件；App 不回答时超时按拒绝处理；
- 主动消息只在至少一个 App WebSocket 在线时发送，App 没连不排队、不补发；
- 主动消息可选模板或模型生成；模型生成只在隐藏 Agent 空闲时进行，失败退回模板；
- 任务/文件/审批/主动消息计数写入状态文件；人格与记忆不落盘；
- 重启后的任务续跑会先恢复同一隐藏 session，发送“继续任务”提示词；恢复失败才回退为新 session 重跑整条指令；
- session 轮数达到 `sessionMaxTurns` 后自动丢弃并重建，防止上下文无限增长；
- WebSocket 由插件自己实现握手和帧编解码，不引入 `ws` 依赖。

## DSH 版本兼容

`connection` 服务的鉴权入口在不同 DSH 版本里不一样，插件同时支持：

| DSH | 鉴权入口 | 插件处理 |
|---|---|---|
| 0.1.x（npm 全局 `dsh`） | `ctx.connection.requestRejection(req)` | 返回 `401/403` 即拒绝，`undefined` 即通过 |
| 0.2.x（桌面版内置） | `ctx.connection.admit(req)` | `{ peer }` 通过，`{ rejection }` 拒绝 |

两条路径都由 `lib/http.js` 的 `connectionAdmission()` 统一处理，HTTP 与 WebSocket upgrade 共用。

预设也有版本差异：

| DSH | 预设能力 | 插件行为 |
|---|---|---|
| 0.2.x | `agentPresets.register()` + `mount()` | 运行时注册 `whale-companion` 并挂载 |
| 0.1.x | 只有内置预设 | `whale-companion` 不可用，自动退回 `fallbackPreset`（默认 `standard`） |

审批桥在两个版本都可用：它注册在隐藏 Agent scope 的 `approval/request` waterfall 上，不依赖预设。

## 安装

插件已开源：<https://github.com/PawNzZi/hdsh-whale-companion>。纯 Node ESM，没有 `dependencies`、没有原生模块、没有构建步骤，克隆仓库后即可安装。

```bash
git clone https://github.com/PawNzZi/hdsh-whale-companion.git
```

### 桌面版 DSH

把本目录加入 `~/.dsh/profiles/desktop` 的依赖，或使用桌面版插件管理器安装本地插件。安装后确认 `package.json` 的 `dsh.profile.bundles` 里出现：

```json
"hdsh-whale-companion"
```

然后完全退出 DSH，再重新打开。

### CLI

```bash
dsh plugin --profile web add <本目录绝对路径>
dsh web
```

## 换电脑 / 开源安装

插件本身是纯 Node ESM，没有 `dependencies`、没有原生模块、没有构建步骤，也**没有硬编码任何绝对路径**：

| 依赖 | 处理方式 |
|---|---|
| 工作区目录 | `workspacePath` 留空时用 `<用户目录>/WhaleCompanion`（`USERPROFILE` / `HOME` / `os.homedir()`） |
| 附件目录 | 工作区下的 `uploads/`，随工作区走 |
| 状态文件 | `$DSH_HOME/whale-companion/state.json`，可用 `statePath` / `DSH_WHALE_STATE` 覆盖 |
| 模型 | 读 DSH 的默认模型（`agentDefaultModel.currentSelection()`），不写死 provider/model |
| 工具 | 0.2.x 运行时注册专属预设；0.1.x 退回内置 `standard` |
| 鉴权 | 同时支持 0.1.x `requestRejection` 与 0.2.x `admit` |
| 平台 | Windows 用 `tool-pwsh`，Linux/macOS 用 `tool-bash`（预设里按 `process.platform` 选择） |
| WebSocket | 插件自带实现，不依赖 `ws` 包 |

所以换一台电脑、换一个用户目录安装，插件代码不需要改。但“所有功能都可用”还取决于**运行环境**：

1. **必须是带 Web 服务的 DSH profile**（桌面版或 `dsh web`），插件注入 `webServer` + `connection`；
2. **DSH 必须配置了可用的默认模型**，否则 chat/tasks 返回 503 `model-unavailable`，health 仍然正常；
3. **任务执行需要 Agent 预设可用**：桌面版/Web 版默认都有；自定义极简 profile 若没有 `agentPresets`/工具包，chat 仍可用，但命令/文件任务会失败；
4. **App 侧功能不在插件里**：卡片、动画、记忆、亲密度、审批 UI、未读数都由 App 实现，只装插件不会出现鲸鱼娘界面；
5. **协议版本**：App 的 `schemaVersion` 必须是 1，`minAppVersion` 要匹配。

> 0.1.x 的 `dsh web` 可以使用 chat / tasks / files / approvals / proactive / events，但只能用内置 `standard` 预设的工具集；0.2.x 桌面版才会挂载更精简的 `whale-companion` 预设。

## 鉴权

所有 `/companion/*` 路由（包括 WebSocket upgrade）都必须在 handler 内调用 `ctx.connection.admit(request)`：

- 未认证返回 401；
- Host/Origin 不被信任返回 403；
- WebSocket 在握手前校验，失败直接写 HTTP 错误并关闭 socket。

App 使用现有 DSH Cookie 访问；经 `hdsh-remote-pair` 桥访问时 Host/Origin 检查可通过，但 Cookie/Peer 仍然必须校验。

## API

### `GET /companion/health`

```json
{
  "installed": true,
  "version": "0.8.0",
  "minAppVersion": "0.1.0",
  "enabled": true,
  "dshOnline": true,
  "schemaVersion": 1,
  "capabilities": ["health", "config", "pet", "chat", "task", "file", "approval", "proactive", "bili", "events", "memoryCandidate"],
  "sessionWorkspace": "鲸鱼娘",
  "agentPreset": "whale-companion",
  "workspace": { "id": "ws_...", "title": "鲸鱼娘", "ready": true },
  "session": { "sessionActive": true, "sessionId": "whale-companion-...", "turns": 3, "running": false, "queued": 0, "preset": "whale-companion", "model": { "provider": "deepseek", "model": "deepseek-chat" } },
  "approvals": 0,
  "files": 1,
  "proactive": { "enabled": true, "sentToday": 1, "dailyLimit": 3, "minIntervalMinutes": 120, "quietStart": "22:30", "quietEnd": "08:00", "quiet": false, "clients": 1, "lastSentAt": 1790000000000, "nextEligibleAt": 1790007200000, "feedback": { "like": 1, "dislike": 0, "dismiss": 0 } },
  "state": { "savedAt": 1790000000000 },
  "events": 1,
  "uptimeMs": 120000
}
```

App 用它区分：

- 404：插件未安装；
- 401：配对/Cookie 失效；
- 超时：DSH 离线；
- `enabled=false`：插件已安装但关闭；
- `version` 低于 `minAppVersion`：需要更新。

### B站活动

插件内置 `lib/bili.js`，不依赖独立的 `dsh-bili-*` 插件。

流程：

1. 在配置的随机时间窗口内选一个时刻；
2. 按关键词搜索 B 站视频，随机翻 1–2 页；
3. 按播放、发布时间、标题/简介过滤，选一条 7 天内没分享过的 BV；
4. 读取视频信息和官方字幕；
5. 用鲸鱼娘人格生成分享文案，发评论并 `@` 主人（默认开启）；
6. 通过 WebSocket 推送 `companion.bili`，App 对话显示 B站卡片。

即使评论失败，App 卡片仍会送达，并标注 `B站评论失败` / `仅App分享`。

配置项（App：设置 → B站）：

- 开关
- 随机时间窗口，默认 `20:00–24:00`
- 每天最多分享次数，默认 `1`
- 自动评论并 `@` 主人，默认开
- 搜索关键词
- `@` 的名字

接口：

```text
GET  /companion/bili/config
POST /companion/bili/config
POST /companion/bili/run       {"force": true}
GET  /companion/bili/status
POST /companion/bili/login/qr  {"action":"start|poll|cancel","sessionId":"..."}
```

数据：

```text
<DSH_HOME>/whale-companion/bili.json            配置与分享历史
<DSH_HOME>/whale-companion/bili-credentials.json B站 Cookie
<DSH_HOME>/whale-companion/bili-state.json       预留状态
```

注意：

- Cookie 等同于 B 站账号权限，只保存在本机，不返回 App、不写日志；
- 登录号就是发评论的号；想稳定收到 `@` 通知，建议用另一个 B 站号登录，并把主号昵称填到 `@` 的名字；
- 自动评论是公开行为，默认开启，请先确认账号能正常评论；
- 第一版只读搜索、视频信息、官方字幕，不包含弹幕、热评、抽帧、直播；
- 失败不会重试轰炸，失败的分享仍会进 App。

完整说明见 [WHALE_BILI.md](../docs/WHALE_BILI.md)。

### `GET/POST /companion/config`

GET 返回当前人格与运行设置。POST 支持两种写法：

```json
{ "profile": { "name": "小鲸", "userTitle": "主人", "personality": "genki" } }
```

```json
{ "settings": { "approvalPolicy": "app", "approvalTimeoutMs": 300000, "chatTimeoutMs": 120000, "maxQueue": 4 } }
```

人格字段白名单：`name`、`userTitle`、`personality`、`energy`、`clinginess`、`humor`、`verbosity`、`workMode`。
运行设置可改：`approvalPolicy`、`approvalTimeoutMs`、`chatTimeoutMs`、`taskTimeoutMs`、`maxQueue`、`sessionMaxTurns`、`workspaceEnabled`、`workspaceTitle`、`maxUploadBytes`、`proactive`。

主动消息可以局部更新，例如只开开关不会清掉其它字段：

```json
{ "settings": { "proactive": { "enabled": true, "dailyLimit": 3, "minIntervalMinutes": 120, "quietStart": "22:30", "quietEnd": "08:00" } } }
```

配置只保存在内存里，App 每次启动应重新下发；主动消息的当日计数与反馈会持久化。

### `POST /companion/pet`

```json
{ "action": "pet", "requestId": "uuid" }
```

返回建议动画：

```json
{
  "schemaVersion": 1,
  "requestId": "uuid",
  "accepted": true,
  "action": "pet",
  "mood": "happy",
  "emotion": "happy",
  "animation": "happy"
}
```

心情和亲密度由 App 本地决定，插件只确认互动并给动画建议。

### `POST /companion/chat`

请求（CompanionContext）：

```json
{
  "schemaVersion": 1,
  "requestId": "uuid",
  "profile": {
    "name": "鲸鱼娘",
    "userTitle": "主人",
    "personality": "gentle",
    "energy": "medium",
    "clinginess": "low",
    "humor": "medium",
    "verbosity": "short",
    "workMode": "companion"
  },
  "state": { "mood": "happy", "affinity": 120, "trust": 35, "level": 4, "moodReason": "task_completed" },
  "memory": [{ "id": "m1", "text": "用户喜欢先看结论", "kind": "preference", "confidence": 0.9 }],
  "recentMessages": [
    { "role": "user", "text": "帮我整理一下今天的任务" },
    { "role": "companion", "text": "好，我先看看。" }
  ],
  "message": "今天还有什么要做的？",
  "taskId": null
}
```

回复（CompanionReply）：

```json
{
  "schemaVersion": 1,
  "requestId": "uuid",
  "text": "还有两个任务，我帮你排一下。",
  "emotion": "happy",
  "action": "nod",
  "taskEvents": [{ "name": "shell", "status": "completed" }],
  "memoryCandidates": [{ "text": "用户今天有两个待办", "kind": "event", "confidence": 0.7 }],
  "growthSignals": [{ "type": "chat", "value": 1 }],
  "proactiveHint": null
}
```

约束：

- `emotion` 只能取 `idle/happy/angry/cute/coquettish/concerned/sleepy/working/thinking/proud`；
- `action` 只能取 `none/nod/shake/wave/tilt/hop/stretch/doze/ponder/pat`；
- `taskEvents` 只给工具名和状态，不含参数或输出，避免泄露路径/命令；
- `memoryCandidates` 最多 3 条，是否写入由 App 决定；
- `growthSignals` 最多 2 条，数值含义由 App 决定；
- 同一个 `requestId` 重试会直接返回缓存回复，不会重复消耗模型调用；
- 模型内部输出是「正文 + [[meta]] 元数据」，插件解析后仍然只返回上面的 CompanionReply；
- 兼容旧版整段 JSON 输出与纯文本输出。

### `POST /companion/chat/stream`（SSE）

同样的 CompanionContext，返回 `text/event-stream`：

```text
event: delta
data: {"requestId":"uuid","text":"主人好呀，"}

event: tool
data: {"requestId":"uuid","phase":"call","callId":"call_...","name":"pwsh"}

event: tool
data: {"requestId":"uuid","phase":"result","callId":"call_...","name":"pwsh","status":"completed"}

event: delta
data: {"requestId":"uuid","text":"我是鲸鱼娘。"}

event: reply
data: {"schemaVersion":1,"requestId":"uuid","text":"主人好呀，我是鲸鱼娘。","emotion":"happy",...}
```

- `delta.text` 是**正文增量**，不是 JSON、不含 `[[meta]]`；
- `event: tool` 是工具调用进度：`phase=call` 表示开始调用，`phase=result` 带 `status=completed|failed`；
- 结束时发 `event: reply`，内容与普通 `/companion/chat` 的响应完全一致；
- 失败时发 `event: error`：`{"code":"timeout|model-error|...","message":"..."}`，HTTP 状态已是 200；
- 客户端断开连接会中止本轮模型调用（节省 token）；
- 与普通 chat 共用 requestId 缓存：流式请求成功后，用同一个 requestId 调普通 chat 会直接拿到缓存；
- 每 15 秒发一次 `: ping` 注释帧，防止代理断开空闲连接。

### 任务

`POST /companion/tasks`：

```json
{
  "requestId": "uuid",
  "kind": "file",
  "title": "看附件",
  "instruction": "读一下附件，用一句话总结",
  "fileIds": ["f_..."],
  "resumeOnRestart": true
}
```

- `kind`：`chat` / `file` / `command`（只影响提示词，执行位置始终是电脑端 DSH）；
- `instruction` 必填；
- `fileIds` 可选，最多 5 个，来自 `POST /companion/files`；prompt 里会带相对路径；
- `resumeOnRestart` 可选：DSH 重启后是否重新排队执行（配合全局 `taskResume`）；
- 返回 `202`，`task.status` 初始为 `queued`；
- 同一个 `requestId` 重复提交返回已有任务（`200`，`created: false`）。

`GET /companion/tasks?limit=20&status=running`：

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "t_...",
      "kind": "command",
      "title": "看看磁盘",
      "status": "succeeded",
      "instruction": "执行 df -h 并总结",
      "createdAt": 1790000000000,
      "startedAt": 1790000000100,
      "finishedAt": 1790000005000,
      "result": "磁盘还有 120G。",
      "emotion": "happy",
      "approval": null,
      "files": [{ "id": "f_...", "name": "笔记.txt", "bytes": 45, "path": "uploads/笔记.txt", "contentType": "text/plain" }],
      "attempt": 1,
      "resumeOnRestart": true,
      "resumedAt": null,
      "sessionId": "whale-companion-...",
      "error": null,
      "steps": [{ "name": "read", "status": "completed" }],
      "requestId": "uuid"
    }
  ],
  "active": 0,
  "events": 1
}
```

`POST /companion/tasks/cancel`：

```json
{ "taskId": "t_..." }
```

- 排队中的任务立即变成 `cancelled`；
- 运行中的任务立即标记 `cancelled`，并 `agent.cancel()` 中止当前 turn；
- 等待审批的任务会连同审批请求一起取消；
- 未知任务返回 404。

任务状态：`queued` → `running` ⇄ `waiting-approval` → `succeeded` / `failed` / `cancelled`。
`waiting-approval` 表示任务停在某个高风险操作上，`task.approval` 里是待回答的审批视图。
任务元数据持久化，最近 50 条；DSH 重启时：

- `taskResume: 'off'`：未完成任务变成 `failed`，`error.code = "interrupted"`；
- `taskResume: 'opt-in'`（默认）：只有 `resumeOnRestart: true` 的任务重新排队，其余同上；
- `taskResume: 'all'`：所有未完成任务都重新排队。

**同一 session 续跑**：

- 任务启动时记录隐藏 session 的 `sessionId`；重启后先 `ctx.agents.resume(sessionId)`，恢复同一会话的完整历史；
- 成功恢复时发送「继续任务」提示词，让模型从中断处继续，**不会从头重跑原始指令**；
- 恢复失败（session 不存在/校验失败/没有持久化）时，自动回退为新 session + 原始指令重跑，并在日志记录原因；
- 重新排队 = `attempt + 1`、`resumedAt` 更新、清空上次结果/步骤；`sessionId` 保持不变；
- 命令类任务如果本身不幂等，续跑仍可能产生重复副作用；高风险操作会重新走审批。

> 任务视图里的 `sessionId` 可以用来核验它确实回到了同一个隐藏会话。

### `GET/POST /companion/files`

上传附件（原始字节，不是 multipart）：

```text
POST /companion/files
content-type: text/plain
x-companion-filename: %E7%AC%94%E8%AE%B0.txt
<文件字节>
```

- `x-companion-filename` 用 `encodeURIComponent` 编码；也可以用 `?name=`；
- 文件写到隐藏工作区的 `uploads/`，返回 `201`：

```json
{
  "schemaVersion": 1,
  "file": { "id": "f_...", "name": "笔记.txt", "bytes": 45, "contentType": "text/plain", "path": "uploads/笔记.txt", "createdAt": 1790000000000 }
}
```

- `GET /companion/files?limit=20`：列出文件；
- `POST /companion/files/delete`：`{ "fileId": "f_..." }`，删除元数据与磁盘文件；
- 单文件上限 `maxUploadBytes`（默认 20MB），最多保留 `maxFiles`（默认 100）个；
- 文件名会去掉路径分隔符和控制字符，不能逃出 `uploads/`。

### `GET/POST /companion/proactive`

`GET` 返回调度状态（和 health 里的 `proactive` 相同，另带 `recent`）。

`POST` 支持两种 action：

```json
{ "action": "test" }
```

立即发一条（忽略免打扰/最小间隔，仍受每日上限约束，要求至少一个 WS 客户端在线）：

```json
{ "action": "feedback", "messageId": "p_...", "feedback": "like" }
```

`feedback` 取 `like` / `dislike` / `dismiss`，只做计数与记录，不推进养成数值。

调度规则：默认每天 3 条、最小间隔 2 小时、免打扰 22:30–08:00；没有 WS 客户端时不生成、不排队、不补发。

生成模式：

- `proactive.mode: "template"`（默认）：本地模板按时段生成，不消耗 token；
- `proactive.mode: "model"`：用隐藏 Agent 生成一句关心，`generationTimeoutMs` 默认 60 秒；只在 Agent 空闲且没有待审批时生成，失败自动退回模板；
- 事件里的 `message.source` 会标 `template` 或 `model`，`importance` 目前固定 `normal`。

### `GET/POST /companion/approvals`

高风险操作到达时，插件广播 `companion.approval`（`status: "pending"`），并把它留在待回答列表里：

```text
GET /companion/approvals
```

```json
{
  "schemaVersion": 1,
  "approvals": [
    {
      "id": "a_...",
      "toolName": "pwsh",
      "callId": "...",
      "reason": "escalate sandbox to danger-full-access: ...",
      "taskId": "t_...",
      "createdAt": 1790000000000,
      "expiresAt": 1790000300000,
      "status": "pending"
    }
  ],
  "pending": 1
}
```

App 回答：

```json
POST /companion/approvals
{ "approvalId": "a_...", "decision": "allow", "requestId": "uuid" }
```

- `decision`：`allow` / `approve` 或 `reject` / `deny`；
- 只放行这一次（`allowed-once`），没有「永久允许」；
- 重复回答同一个审批返回 404 `approval-not-found`；
- 超时（`approvalTimeoutMs`）或 turn 被取消时按拒绝/取消处理；
- 审批回答后，等待中的任务从 `waiting-approval` 回到 `running`。

`GET` 还会返回最近的 `history`（最多 10 条，新的在前）。DSH 重启时，没回答的审批会从 `pending` 转成 `expired` 放进历史，不再可回答。

审批视图不包含工具参数/命令原文，只给工具名、原因、关联任务 id。

### `GET /companion/events`（WebSocket）

普通 HTTP GET 返回 `426 upgrade-required`。升级成功后插件先发一帧：

```json
{ "type": "companion.hello", "schemaVersion": 1, "version": "0.6.0", "time": 1790000000000, "clients": 1 }
```

之后推送：

- `companion.message`：`{ "reply": CompanionReply }`；
- `companion.task`：`{ "task": TaskView }`；
- `companion.approval`：`{ "approval": ApprovalView }`（`status`: `pending` / `allowed` / `rejected` / `expired` / `cancelled`）；
- `companion.proactive`：`{ "message": { "id", "text", "importance", "reason", "createdAt" }, "status": { "sentToday", "dailyLimit" } }`；
- `companion.file`：`{ "file": FileView, "count": 1 }`；
- `companion.interaction`：`{ "action": "pet", "emotion": "happy" }`；
- `companion.pong`：客户端发 `{"type":"ping"}` 时的心跳回应。

服务端每 `eventHeartbeatMs` 发一次 ping；连续一个周期没有 pong 就断开。App 没连时事件不排队、不补发；待审批请求可以用 `GET /companion/approvals` 补查。

## 错误码

| HTTP | `error` | 含义 |
|---|---|---|
| 400 | `bad-request` | JSON 非法、缺少字段 |
| 400 | `schema-version` | `schemaVersion` 不是 1 |
| 400 | `unsupported-action` | pet 的动作不支持 |
| 401 | `unauthorized` | 未认证 / Cookie 失效 |
| 403 | `forbidden` | Host/Origin 不受信任 |
| 404 | `not-found` | 任务不存在 |
| 404 | `approval-not-found` | 审批不存在或已回答 |
| 404 | `file-not-found` | 附件不存在或已删除 |
| 409 | `disabled` | 插件已关闭 |
| 409 | `cancelled` | 本轮对话/任务被取消 |
| 409 | `workspace-unavailable` | 上传需要可用的隐藏工作区 |
| 413 | `payload-too-large` | 请求体/上传超限 |
| 426 | `upgrade-required` | events 需要 WebSocket |
| 429 | `busy` | 队列已满 |
| 502 | `model-error` | 模型失败或返回空回复 |
| 503 | `agent-unavailable` / `model-unavailable` | 没有 Agent 运行时或没配置默认模型 |
| 504 | `timeout` | 模型超时 |

## 配置

`cordis.patch.yml` 已带完整示例。字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后 health 仍可读，其余接口返回 409 |
| `minAppVersion` | `0.1.0` | health 返回给 App 的最低版本 |
| `agentPreset` | `whale-companion` | 专属预设 id；0.2.x 运行时注册并挂载 |
| `fallbackPreset` | `standard` | 专属预设不可用时退回的预设（0.1.x 用这个） |
| `approvalPolicy` | `app` | `app`：审批交给 App；`never`：高风险操作直接拒绝 |
| `approvalTimeoutMs` | `300000` | App 多久不回答按拒绝处理 |
| `chatTimeoutMs` | `120000` | 单轮对话超时（有待审批时会自动延长） |
| `taskTimeoutMs` | `600000` | 单个任务超时 |
| `maxQueue` | `4` | 排队 + 执行的上限 |
| `sessionMaxTurns` | `40` | 隐藏 session 轮换阈值，`0` 关闭轮换 |
| `promptOrder` | `5000` | 人格 prompt section 的排序 |
| `workspaceEnabled` | `true` | 是否创建独立工作区 |
| `workspacePath` | `''` | 留空时用 `<用户目录>/WhaleCompanion` |
| `workspaceTitle` | `鲸鱼娘` | 工作区标题 |
| `eventHeartbeatMs` | `30000` | WebSocket 心跳间隔 |
| `maxUploadBytes` | `20971520` | 单个上传文件上限（20MB） |
| `maxFiles` | `100` | 保留的附件数量上限 |
| `statePath` | `''` | 状态文件；留空用 `<DSH_HOME>/whale-companion/state.json` |
| `taskResume` | `opt-in` | 重启后任务续跑：`off` / `opt-in` / `all` |
| `proactive.enabled` | `false` | 主动消息总开关（App 通过 config 打开） |
| `proactive.mode` | `template` | `template` 本地模板 / `model` 隐藏 Agent 生成 |
| `proactive.dailyLimit` | `3` | 每天上限（0~5） |
| `proactive.minIntervalMinutes` | `120` | 最小间隔（分钟） |
| `proactive.quietStart` / `quietEnd` | `22:30` / `08:00` | 免打扰时段 |
| `proactive.generationTimeoutMs` | `60000` | 模型生成超时 |
| `proactive.templates` | `[]` | 自定义文案（最多 10 条，留空用内置按时段模板） |

## 持久化

状态文件默认 `$DSH_HOME/whale-companion/state.json`，可用 `statePath` 或环境变量 `DSH_WHALE_STATE` 覆盖。

保存内容：

- 任务元数据（最近 50 条；按 `taskResume` 策略重启后重排或标记 `failed` / `interrupted`）；
- 附件元数据（文件字节在 `workspace/uploads/`）；
- 审批历史（最多 20 条；重启时未回答的审批转为 `expired`）；
- 主动消息当日计数、上次发送时间、最近消息与反馈计数。

不保存：人格配置、长期记忆、亲密度/等级（这些真源在 App）。写入采用「临时文件 + rename」，最多延迟 500ms 落盘，插件卸载时同步 flush。

## 开发

```bash
node --check lib/index.js
npm test        # smoke + websocket
```

测试不启动 DSH、不调用模型：用假的 `ctx`、`Agent` 和真实的 `http.Server` 覆盖路由、鉴权、幂等、排队、取消与 WebSocket 帧。

## 已验证

- `npm test` 全部通过（路由、鉴权、幂等、排队、取消、预设注册/挂载、审批 pending/allow/reject/timeout/cancel、任务 `waiting-approval`、文件上传/附件任务、主动消息每日上限/免打扰/模型模式、SSE 流式、状态持久化/中断恢复/任务续跑、WebSocket 帧）；
- 独立 `dsh web` 实例（npm 全局 `dsh` 0.1.5-rc.1）用真实 Cookie 验证：
  - `GET /companion/health` 返回 200，带 workspace、session、preset、approvals、files、proactive 信息；
  - `POST /companion/chat` 走真实模型（`deepseek-official/deepseek-flash`），返回结构化回复；
  - **SSE 流式**：`/companion/chat/stream` 收到 19 个 `delta`，拼接结果与 `reply.text` 完全一致，未泄露 `[[meta]]`/JSON；
  - **真实工具调用**：让鲸鱼娘执行 `Get-Date`，返回 `taskEvents` 与真实时间输出；
  - 专属预设 `whale-companion` 在 0.1.x 不可用，自动退回 `standard` 并成功挂载；
  - 相同 `requestId` 重试命中缓存（78ms），未重复调用模型；
  - `POST /companion/tasks` 创建任务并成功返回真实结果，`tasks/cancel` 能中止运行中的 turn；
  - **审批闭环**：跨工作区写文件触发 pending approval；任务期间 `waiting-approval`；`reject` 后文件未创建；`allow` 后文件创建成功（测试文件已清理）；
  - **附件任务**：上传 `笔记.txt` 后创建 `kind=file` + `fileIds` 任务，模型调用 `read` 读取 `uploads/笔记.txt` 并返回真实摘要；
  - **主动消息模型模式**：`mode=model` 时通过 WS 收到 `source:"model"` 的生成文案（约 1.1 秒），反馈 `like` 被记录；
  - **崩溃恢复**：等待审批时强杀进程，重启后任务状态与审批历史正确落盘；普通任务为 `failed/interrupted`、审批 `expired`；
  - **SSE 工具进度**：流式对话里收到 `event: tool` 的 `call`/`result`，`callId` 与 `name=pwsh` 正确配对；
  - **任务续跑（同 session）**：带 `resumeOnRestart:true` 的任务重启后日志出现 `hidden agent resumed`，`attempt=2`、`sessionId` 与重启前一致，发送“继续任务”而不是重跑原始指令；重新触发审批，拒绝后正常完成；
  - `/companion/events` 握手 101，收到 `companion.hello` 与 `companion.interaction`；
- 桌面版 DSH（0.2.1-rc.3）的 `admit` 路径由单元测试覆盖；0.2.x 的 `agentPresets.register()` 路径由 mock 覆盖，待桌面版重启后做实机复验。

desktop profile 已安装本插件；修改代码后需要重新安装并完全重启 DSH 才会生效。

## 相关链接

- 官网：<https://hdsh.lingyikz.cn/>
- HDSH 下载（HarmonyOS NEXT · 华为应用市场）：<https://appgallery.huawei.com/app/detail?id=cn.lingyikz.hdsh&channelId=SHARE&source=appshare>
- 插件源码：<https://github.com/PawNzZi/hdsh-whale-companion>
- 问题反馈：<https://github.com/PawNzZi/hdsh-whale-companion/issues>
- 同系列插件：[`hdsh-remote-pair`](https://github.com/PawNzZi/hdsh-remote-pair) · [`hdsh-tavern`](https://github.com/PawNzZi/hdsh-tavern)

App 侧对应 `CompanionController.pluginRepo()` / `pluginHomepage()`，已指向本仓库与官网（设置 → 插件页展示仓库地址）。

## 许可

MIT。App 本身闭源，本插件开源。
