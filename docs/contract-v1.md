# 互联约定 v1

> 状态：冻结（2026-11-10）
> 这份文件是三个仓库之间的约定，**以本文件为准**。要改必须升版本号，并写在本仓库 CHANGELOG 里。
> 上游代码：https://github.com/liguobao/ds-harness-remote （MIT，本仓库 `upstream` 远程跟踪它）
> 本仓库同时放服务器和设备侧插件 `@dsh-mesh/plugin`。电脑仓库 `dsh-orb-cordis` 与手机仓库 `dsh-orb-android` 只依赖发布出来的插件包。

## 3. 「填入即互联」流程

### 3.1 用户视角

1. 管理员经 SSH 隧道打开管理页，点「添加设备」，填备注（例如「书房 Mac」）。
2. 管理页显示一条配对串和对应二维码，30 分钟内有效，只能用一次。
3. 在设备上打开互联设置：
   - 电脑：DSH 设置 → 「互联」板块；
   - 手机：dsh-orb-android App → 「互联」页（可扫码）。
4. 粘贴配对串，本机名称可以不填（默认 `Mac1` / `Windows1` / `Phone1`），点「连接」。
5. 15 秒内显示「已连接 · 本机名 Mac1」和其他设备列表；Mesh 窗口与手机互联页里出现其他设备。

整个过程不改配置文件、不重启 DSH 或手机引擎。

### 3.2 插件内部做什么

`POST /.dsh-mesh/v1/pair { pairing, name? }`，按顺序执行，任何一步失败就停下，返回该步的错误：

| 步 | 动作 | 失败时的 `error` |
|---|---|---|
| 0 | 本机已配对到**另一台**服务器 → 直接拒绝 | `already_paired` |
| 1 | 解析配对串（4.1） | `bad_pairing` |
| 2 | 用配对串里的指纹固定证书，请求 `GET https://<地址>/health` | `unreachable`、`fingerprint_mismatch` |
| 3 | 比较 `/health` 返回的 `meshApi` 与本机插件支持的版本 | `server_incompatible` |
| 4 | 生成本机 Host、Client 两个身份（已有则复用），调 `register-with-code`；成功后**立即**把地址、指纹、token 和 `pending: true` 写入 `state.json` | `code_invalid`、`code_used`、`code_expired`、`rate_limited` |
| 5 | 调 `register-owned-role` 注册 Client 身份，挂到同一节点 | `register_failed` |
| 6 | 填了 `name` 就改名 | `name_taken`（不算失败：返回成功，附 `warning`） |
| 7 | 在进程内按新配置重建 Host 与 Client 运行时（参照上游 `replaceServer`，`index.ts:365-380`），启动连接，拉取对端列表；清掉 `pending` | `connect_failed` |

- 成功：HTTP 200，`{ ok: true, node: { nodeId, name, platform }, peers: MeshNode[], warning? }`。
- 失败：HTTP 4xx/5xx，`{ error, message, step }`。与其他接口的错误格式一致（4.3），只多一个 `step`。`message` 是给用户看的中文/英文句子（下表）。
- 每一步都有超时，整体不超过 15 秒。
- **第 4 步之后中断**（崩溃、断网）：`state.json` 里是 `pending: true`，用户再点「连接」时跳过第 4 步，从第 5 步续做，不再消耗配对码。
- **被管理员撤销后重新配对同一台服务器**：旧身份的 token 已失效，第 4 步收到 401 时丢弃旧身份、重新生成再注册。
- 退出互联（`POST /unpair`）会撤销本机两个身份，清掉 `state.json` 和身份目录。
- 配对码只在这一次请求里用，不落盘。

| `error` | HTTP | 给用户的提示 |
|---|---|---|
| `already_paired` | 409 | 本机已加入另一台服务器（<地址>）的互联，请先退出 |
| `bad_pairing` | 400 | 配对串格式不对，请从管理页重新复制 |
| `unreachable` | 502 | 连不上服务器 <地址>，请检查网络或服务器是否在运行 |
| `fingerprint_mismatch` | 502 | 服务器证书和配对串里的指纹不一致，可能连错了服务器，已停止连接 |
| `server_incompatible` | 409 | 服务器版本（meshApi <n>）和本机互联插件（meshApi <m>）不兼容，请先升级 |
| `code_invalid` / `code_used` / `code_expired` | 400 / 409 / 410 | 配对码无效 / 已被使用 / 已过期，请在管理页重新生成 |
| `rate_limited` | 429 | 尝试次数过多，请 1 分钟后再试 |
| `register_failed` | 502 | 服务器拒绝了本机的注册（<服务器原因>），请重新生成配对码再试 |
| `connect_failed` | 502 | 已配对，但暂时连不上中继，会自动重试 |
| `name_taken`（warning） | 200 | 名称「<名称>」已被占用，暂用 <默认名>，可在设置里再改 |

`<地址>` 取自配对串，不写死。服务端 `register-with-code` 对应返回：码不存在 400、已用 409、过期 410、限流 429。

### 3.3 唯一的数据来源

- 服务器地址、证书指纹、节点身份都只由 `@dsh-mesh/plugin` 保存，目录是 `os.homedir()/.dsh/dsh-mesh/`。不要写死路径：手机在 PRoot 下是 `/root/.dsh/dsh-mesh/`，但 dsh-Go 还有直接 glibc 启动模式（`DshProcess.kt:83`），家目录可能不同。
- 电脑设置页和手机互联页**不另存**这些值，显示时都读 `GET /.dsh-mesh/v1/status`。
- 手机仓库要保证 App 升级、引擎重装时这个目录不丢。已核实 dsh-Go 升级引擎时保留 `/root`（`RuntimeInstaller.kt:199-231`）；换启动模式时要再确认。

---

## 4. 跨仓库约定 v1

下面这些**从现在起冻结**，三个仓库都照它并行开发。之后要改，必须升版本号并在本仓库 CHANGELOG 里写明。

### 4.1 配对串

```
dshmesh://YOUR_SERVER_IP:443/pair?v=1&code=TESTPAIR&fp=Qm9n...（43 字符）
```

| 字段 | 说明 |
|---|---|
| 主机与端口 | 公网 IP 或域名；端口省略时为 443 |
| `v` | 配对串格式版本，现在是 `1` |
| `code` | 8 位配对码，大写字母数字，不含 `0/O`、`1/I` |
| `fp` | 服务器证书公钥（SPKI）的 SHA-256，base64url 编码，不带填充 |

- 管理页同时给出二维码，内容就是这条串。手机互联页可以复用 dsh-Go 现有的 ML Kit 扫码。
- 两个设置界面都要提供「手动填写」：地址、配对码、指纹三栏，拼成同一条串后调 `pair`。
- 指纹固定的是**公钥**，不是整张证书。服务器换证书时沿用同一把私钥，指纹不变，设备不用重新配对。

### 4.2 插件接入方式

消费方只写这几行，不配置连接细节：

```yaml
# 应用级（电脑：cordis.patch.yml 的 app-level 行；手机：dsh-go-bridge overlay）
- id: dsh-mesh
  name: '@dsh-mesh/plugin'
  config:
    platform: android            # 只有手机填。不填时用 process.platform（电脑一份 patch 同时服务 Mac 与 Windows）；手机的 PRoot 里它是 linux，必须覆盖
    incomingPreset: standard     # 其他设备派来的任务用哪个 preset
    remoteToolGuard: ['mcp__phone__*']   # 只有手机填：远程发起的会话默认不能调这些工具
    receiveDir: /sdcard/Download/DSH-Go/mesh   # 结果文件默认落点；用户在 /prefs 里改过就以 /prefs 为准；不可写时退回插件自己的目录
    mock: false                  # 开发用，见第 5 节

# preset 内（电脑：preset-computer-use；手机：orb-phone，A5 起）
- id: tool-device-agent
  name: '@dsh-mesh/plugin/device-agent'
```

`@dsh-mesh/plugin` 自己保证以下几点，消费方不用、也不能改：

- 设备同时是 Host 和 Client；
- 只用 Relay；
- **不向任何 preset 注入 `remote_*` 工具**；
- 不开远程终端；
- 不在官方 DSH 侧栏加入口。

这几条是锁定行为。两种做法在 B0 后选定：插件内部直接实例化 Host 运行时，不加载上游插件的 DSH 入口；或者加载上游入口但写死这些配置。

### 4.3 本机接口 `/.dsh-mesh/v1/*`

挂在本机 DSH 的 web 服务上：电脑是 DSH 本机端口，手机是 `127.0.0.1:3080`。鉴权与 dsh-orb-cordis 的 `/.dsh-orb/*` 相同，走 `ctx.connection.admit` / `isAuthenticated`。

- **电脑设置页**运行在 DSH 网页里，本来就带着会话 cookie。
- **helper 窗口**用自己的令牌访问 `orb-host`，不直接调这些接口，由 `orb-host` 在进程内转调同一套服务（4.4）。
- **手机 Flutter 互联页**现在没有现成的鉴权：dsh-Go 的运行令牌只用来换会话 cookie（`island_gate.dart:150`，令牌在 `runtime_bridge.dart:186`），Dart 侧没有给本机引擎发请求的 HTTP 客户端。手机仓库要先做一个：用 `GET /?token=<运行令牌>` 换 cookie，存进 Dart 的 cookie jar，之后所有 `/.dsh-mesh/v1/*` 请求都带上；引擎重启、令牌变化时重新换。这是手机入网的第 0 步（见 dsh-orb-android 的 `docs/v0-phone-orb.md`）。
- **增量通道**：见下面「长轮询默认、SSE 只当优化」一条；路径与事件形状不因传输方式变化。

| 方法 | 路径 | 用途 | 谁用 |
|---|---|---|---|
| GET | `/status` | `{ paired, server: { url, fp }, node, connection: 'unpaired' \| 'connecting' \| 'connected' \| 'offline', peersOnline, peersTotal }` | 两端设置页 |
| POST | `/pair` | 第 3.2 节 | 两端设置页 |
| POST | `/unpair` | 退出互联 | 两端设置页 |
| POST | `/name` | `{ name }` 改本机名 | 两端设置页 |
| GET / PUT | `/prefs` | `{ allowIncoming, allowedCallers, allowGuardedTools, receiveDir }`；`allowGuardedTools` 在手机上显示为「允许其他设备操作本机屏幕」 | 两端设置页 |
| GET | `/nodes` | `MeshNode[]`（第 7 节） | 树、设置页 |
| GET | `/tree` | 设备 → 工作区 → 会话 的快照 | 树 |
| GET | `/events?since=<cursor>` | 节点上下线、树变化、交互出现/撤下、任务状态；`{ items, cursor }`，长轮询最多挂 25 秒 | 树、卡片 |
| GET | `/sessions/:nodeId/:sessionId/page` | 历史分页 | 会话视图 |
| GET | `/sessions/:nodeId/:sessionId/stream?since=<cursor>` | 实时事件；`{ items, cursor }`，同样长轮询 | 会话视图 |
| POST | `/sessions/:nodeId/:sessionId/prompt` | `{ text, attachments? }`；**仅任务会话**，否则 `session_not_remote_controllable` | 会话视图 |
| POST | `/sessions/:nodeId/:sessionId/cancel` | 停止这一轮；仅任务会话，否则同上 | 会话视图 |
| GET | `/interactions` | 未决审批/提问（`MeshInteraction[]`） | 卡片 |
| POST | `/interactions/:eventId/answer` | `MeshInteractionAnswer` | 卡片 |
| GET | `/tasks` | `DeviceTask[]`（含回传文件与进度） | 任务卡、附件区 |

- **会话事件不重新定义**：`stream` 与 `page` 里的每一帧，就是 DSH `session/follow` / `session/page` 的原始事件，外面包一层 `{ nodeId, sessionId, seq, event }`；长轮询的 `items` 就是这些帧的数组，`cursor` 取最大 `seq`。电脑的 `transcript-model.js` 和手机的 `ui/chat` 本来就解析 DSH 事件，各自直接渲染。
- **`cursor` 语义**：按节点内单调递增的 `seq` 记账，不按时间戳；断线重连或进程重启后先重建基线（`/tree` + `/sessions/…/page`），再用上一次的 `cursor` 续拉。`cursor` 落后太多时返回 `{ items: [], cursor: <最新>, reset: true }`，消费方重建基线。
- **增量通道默认长轮询，SSE 只当优化**：`ctx.webServer.register` 给的是原始 `res`，DSH web 层是否压缩/缓冲/空闲超时未验证，所以 v0 用定长响应的长轮询（最多挂 25 秒，有新事件立即返回）。B0 验证通过后可在同一路径加 `Accept: text/event-stream` 分支，**事件 JSON 形状不变**。
- **错误格式统一**：`{ error: string, message: string }`，`message` 可直接展示。
- **会话接口的拒绝码**：对**非任务会话**调 `prompt` / `cancel` 返回 `session_not_remote_controllable`（403）。v0 只允许对 `device_agent` 派出的任务会话输入（决策 P2）。
- **审批可答者**：发起任务设备 + 目标设备本机；第三台打开会话只显示卡片、按钮置灰。这是 UI 策略，协议层不强制（决策 P3）。
- **契约测试**：`dsh-mesh/tests/contract/` 用固定数据跑每个接口的请求与响应形状，真实模式和假数据模式都要通过。消费方若发现响应与文档不符，就去 `dsh-mesh` 提 issue，不在自己仓库里打补丁兼容。

### 4.4 进程内服务

同一个插件还在应用级 `provide('mesh', MeshService)`，方法与 4.3 一一对应，类型从 `@dsh-mesh/plugin/types` 导出。dsh-orb-cordis 的 `orb-host` 用它给 helper 的 Mesh 窗口转发；手机仓库用不到。

### 4.5 模型工具

- `device_agent` / `device_agent_status` / `device_agent_stop` 的参数与返回值以第 6 节为准，属于约定 v1。
- persona 由消费方写：电脑仓库写在 `preset-computer-use`，手机仓库写在 `orb-phone`。工具名或返回字段变了，两边 persona 都要跟着改，所以也属于冻结范围。

### 4.6 版本兼容

| 版本号 | 在哪 | 规则 |
|---|---|---|
| `meshApi` | 服务器 `/health`、插件常量 | 服务器与插件不一致时，配对与连接都返回 `server_incompatible`；v0 期间服务器和插件同版本部署 |
| `/.dsh-mesh/v1` | 本机接口路径 | 只加字段不升版本；删字段或改含义开 `v2`，`v1` 保留一个版本 |
| 配对串 `v` | 配对串 | 同上 |

## 5. 假数据模式

`mock: true` 时本机接口全部可用，供电脑和手机在没有服务器时开发界面。真实模式和假数据模式都要过 `tests/contract/`。

- 返回 3 个假节点，每个节点 2 个工作区、若干会话；其中 1 个节点每 60 秒上下线一次。
- `/events` 与 `/stream` 按固定脚本产生一轮对话，中间触发一次审批；长轮询按 `since` 分批返回，界面看到的是同一批帧。
- `pair` 按配对码返回固定结果：`TESTPAIR` 成功；`BADCODE1` → `code_invalid`；`USEDCODE` → `code_used`；`OLDCODE1` → `code_expired`；`SLOWDOWN` → `rate_limited`；`NAMETAKE` → 成功并带 `name_taken` 警告；地址填 `unreachable.test` → `unreachable`；指纹填 43 个 `A` → `fingerprint_mismatch`。


## 6. `device_agent`：跨设备派任务

行为参照 dsh-orb-cordis 里的 `code_agent`（`packages/computer-use/src/code-agent.ts`），实现放在本仓库：

| `code_agent` | `device_agent` |
|---|---|
| `sessionController.create({ agentPreset: 'desktop' })` | 目标节点上远程 `session/create`（`standard` preset） |
| `sessionController.prompt({ mode: 'queue' })` | 远程 `session/prompt` |
| `watchCodeAgentCompletion`（本机 `whenIdle()`） | 订阅目标会话的 `session/follow`，盯 `turn/start` → `turn/end` |
| `followup(createUserMessage(...))` | 同样的 followup，正文标明来源设备与回传文件的本机路径 |
| `code_agent_status` / `_stop` | 本机任务表 + 远程 `session/cancel` |

**工具签名（草案）**：

```
device_agent({
  device: string,          // 设备名或 nodeId；必填
  task: string,            // 任务描述；必填
  workspace?: string,      // 目标工作区名或 id；'new' 表示新建任务目录
  session_id?: string,     // 继续已有远程会话（重试也走这里）
  attachments?: string[],  // 本机绝对路径，先上传再 prompt
})
→ { accepted: true, created, device, session_id, task_id }
→ { accepted: false, reason: 'offline', device, last_seen_at }      // 不建会话
→ { accepted: false, reason: 'needs_workspace', workspaces: [...] } // 模型应询问用户

device_agent_status({ device?: string })
→ { count, tasks: [{ device, session_id, task_id, task, status, files }] }

device_agent_stop({ device: string, session_id: string })
→ { accepted }
```

**派发规则**：

- **先查在线**：目标的 `RemoteHandle` 未连接，或服务端 presence 为离线，就返回 `offline`，不建会话。
- **工作区**：没给 `workspace` 时返回目标的工作区列表，由模型调 `ask_user` 让用户选；用户说「新建」才用 `'new'`（落在目标 `~/.dsh/mesh-tasks/<taskId>/`）。
- **去重**：`task_id` 由发起端生成，写进远程会话标题与首条消息。断线重连后先在目标 `session/list` 里按 `task_id` 查，查到就接着跟，不重复创建。
- **派发后断线**：任务显示「状态未知」，重连后对账；不假装完成。
- **重试**：失败后用同一个 `session_id` 再发一条消息。

**结果文件回传**：

1. 派发时在任务正文里约定：交付文件放到工作区下的 `.mesh-out/<taskId>/`。
2. 目标这一轮结束后，发起端用 `workspaceFiles/list` 列这个目录（白名单内）。
3. 逐个用下载原语取回，落到 `~/Downloads/dsh-mesh/<设备名>/<taskId>/`（fork 时把落点改成参数）。
4. 记入 mesh 任务表的 `files`（名称、大小、来源设备、本机路径、状态）。这些是**任务附件**，不是 DSH 原生会话附件：在 Mesh UI 的任务卡与附件区显示，悬浮球的完成通知里写本机路径。

**文件传输要补的**：

- 进度：fork 的分块循环加进度回调，上抛到 Mesh UI。
- 失败：整份重试（现有实现失败即清理临时文件，不支持续传）。
- 上限：现有上传经中继 20 MiB、下载 50 MiB。v0 对用户统一按 20 MB 提示，并做成可配置。

**`code_agent` 里有一半的 API 在远程场景不存在**：

| `code_agent` 用的 | 远程替代 |
|---|---|
| `ctx.get('agents').get(id)` / `agent.whenIdle()` | 订阅远程 `session/follow` |
| `agent.followup(...)` | 只能 followup **本机**的调用方（派发它的那颗球） |
| `code.ctx.on('approval/request')` | 走远程交互通道（4.6） |
| `agent.session.deriveMessages()` | 远程 `session/page` 或 `follow` 的记录 |
| `attachUnattendedCodeAgent(code)` | **绝对不能对远程用**，会把用户该批的审批全部放行 |

**completion 的处理**：

- 不能只看 `running === false`：排队期间可能还是 false。要盯住 `turn/start` → `turn/end`（参考 `code-agent-completion.ts` 的 `waitUntilIntervalStarts`）。
- 断线重连后重新订阅，用 `sessionId + turnId` 去重，不重复发完成通知。
- 用户手动停止与自然结束要区分，通知文案不同（参考本地版 `lastTurnEndedUserAborted`）。


## 7. 数据类型（三个仓库共享）

> 这些类型由 `@dsh-mesh/plugin/types` 导出，属于 18 第 4 节约定 v1 的一部分；本机接口与配对串见 18。

### 7.1 节点与设备身份

```ts
MeshNode {
  nodeId: string            // 兑换配对码时生成
  name: string              // Mac1 / 书房 Mac
  platform: 'darwin' | 'win32' | 'android' | 'linux'
  hostDeviceId: string      // Host 身份
  clientDeviceId?: string   // Client 身份
  online: boolean
  lastSeenAt?: number
  harnessVersion?: string
  appVersion?: string
}

DeviceDescriptor {          // 每个身份一份（沿用 ds-harness-remote）
  deviceId: string
  role: 'host' | 'client'
  identityKey: string       // 公钥（base64）
  nodeId: string            // v0 新增
}
```

### 7.2 会话状态（树里显示用）

```
'idle' | 'running' | 'waiting-approval' | 'waiting-question' | 'failed' | 'unknown'
```

> `offline` 是设备级状态。离线设备下的会话显示为 `unknown` + 上次已知状态。

### 7.3 交互（审批/提问）

```ts
MeshInteraction {           // 由目标节点 $events 流上的事件映射而来
  nodeId: string            // 目标节点
  sessionId: string
  eventId: string
  clientId: string          // 收到事件的那条流；应答必须原路返回
  kind: 'approval' | 'question'
  toolName?: string
  reason?: string
  originNodeId?: string     // 派发这条任务的节点（来自任务表），决定在哪弹卡；v0 的审批只出现在任务会话里，因此一定有值
  createdAt: number
}

MeshInteractionAnswer {
  eventId: string
  outcome: 'allowed-once' | 'rejected'   // 审批
  answers?: unknown                      // 提问，按 userQuestions/answer 的格式
  answeredBy: string                     // nodeId
}
```

### 7.4 任务派发

```ts
DeviceTask {
  taskId: string
  originNodeId: string
  targetNodeId: string
  sessionId: string
  workspaceId?: string
  status: 'running' | 'waiting-input' | 'done' | 'failed' | 'cancelled' | 'unknown'
  files: Array<{
    name: string
    size: number
    direction: 'out' | 'in'      // out = 发给目标；in = 回传本机
    localPath?: string
    state: 'transferring' | 'done' | 'failed'
    progress?: number            // 0–1
  }>
  createdAt: number
  updatedAt: number
}
```
