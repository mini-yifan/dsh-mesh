# 账号模式（托管部署）

这份文档记录 `DSH_MESH_MODE=account` 的设计与运维要点。个人模式（默认）不受影响，
仍然是 v0 的单租户行为：管理员口令 + 配对码，没有任何账号接口。

## 1. 两种模式共用一个镜像

| | 个人模式（`personal`，默认） | 账号模式（`account`） |
| --- | --- | --- |
| 信任域 | 一个部署 = 一个信任域 | 一个账号 = 一个信任域 |
| 进入方式 | 管理员口令 + 一次性配对码 | 邮箱验证码登录网页，再授权设备 |
| 网页 | 管理页，仅 `127.0.0.1` + SSH 隧道 | 公网门户：登录、设备列表、添加设备 |
| 设备发现 | 管理员手动加 | 网页「添加设备」生成配对串 |
| 邮件服务 | 不需要 | 必须配置（或先用 `console` 试） |
| 账号接口 | **完全不挂载** | 挂载 |
| 存储 | `state.json` | `state.json` + `accounts.sqlite3` |

模式由 `DSH_MESH_MODE` 决定。个人模式不实例化账号路由，因此 `/api/v1/auth/email/*`、
`/api/v1/portal/*`、`/api/v1/link/*` 在个人模式下是 404——这是 v0 的既有约束，
不是遗漏。

## 2. 设备如何入网（方案 A：设备授权轮询）

「互联」设置里打开开关后：

```
插件                          浏览器                        服务器
 │                              │                             │
 ├─ 1. POST /api/v1/link/start ─────────────────────────────► │
 │     {publicKey, deviceName, platform}                      │  存 nonce 的摘要
 │ ◄── {linkId, nonce, approveUrl} ──────────────────────────┤
 │                              │                             │
 ├─ 2. 打开 approveUrl ────────►│                             │
 │                              ├─ 输入邮箱 → 收验证码 ──────► │
 │                              ├─ 登录（首次即注册）─────────► │
 │                              ├─ POST /link/approve ───────► │  绑定为 acceptor 的设备
 │                              │                             │  签发 device token
 │                              │                             │
 ├─ 3. 轮询 POST /link/collect ►│                             │
 │     {linkId, nonce}          │                             │  校验 nonce 摘要
 │ ◄── {accessToken, ...} ──────┴─────────────────────────────┤  一次性返回
```

三条安全约束：

1. **nonce 不出本机。** 浏览器只拿到 `linkId`，所以泄漏的授权 URL 无法冒领凭证。
2. **授权必须登录。** `approve` 要求有效会话，且账号从 cookie 推导，从不信任请求体。
3. **凭证只取一次。** `collect` 在同一个事务里读走 token 并清空该行。

## 3. 数据模型

SQLite（`node:sqlite`，Node 22.5+ 内置，无外部依赖）：

| 表 | 内容 | 敏感字段处理 |
| --- | --- | --- |
| `accounts` | account_id / email / 时间戳 | 邮箱**明文**存（账号标识，UI 要展示） |
| `challenges` | 验证码挑战 | 只存 `HMAC_SHA256(pepper, challengeId:code)` |
| `web_sessions` | 网页会话 | 只存 `SHA256(cookie)` |
| `send_events` | 发送限流窗口 | 邮箱/IP 都存 `SHA256` |
| `device_links` | 设备授权握手 | 只存 `SHA256(nonce)`；token 取出后立即清空 |

设备与节点仍写在 `state.json`，但每条记录带 `owner` 字段（`hash(accountId)`），
所有查询强制按该字段过滤。v2 的老文件在加载时自动把这些记录归给当时的单租户。

### 邮箱为什么明文存

它是账号标识：登录后要显示 `已登录：x***x@example.com`，运营也要能处理申诉。
这是一个显式取舍，记录在隐私说明里。相对的，验证码、会话、nonce 全部只存摘要，
即使数据库泄漏也无法直接重放登录。

### 为什么验证码要加 pepper

6 位数字只有 100 万种可能。如果像持久化系统那样存裸 SHA256，拿到附件的人能在
秒级穷举。用服务端密钥做 HMAC 后，没有 pepper 就无法离线爆破；再叠加 5 次尝试上限
和原子消费，在线爆破也不可行。

## 4. 限流

单进程 SQLite 窗口计数，按不同维度组合：

| 维度 | 默认 |
| --- | --- |
| 同邮箱冷却 | 60 秒 |
| 同邮箱每日 | 5 封 |
| 同 IP 每小时 | 10 次 |
| 同 IP 每日 | 30 次 |
| 验证码有效期 | 10 分钟 |
| 同码最多试错 | 5 次 |
| 授权链接有效期 | 10 分钟 |

被拒绝的请求**不消耗配额**：先检查全部窗口，全部通过才记录。

## 5. 部署

```bash
cd deploy
cp server.env.example server.env
# 至少改这些：
#   DSH_MESH_MODE=account
#   DSH_SERVER_PUBLIC_URL=https://你的域名
#   DSH_MESH_ACCOUNT_PEPPER=<32 字符以上随机值>
#   DSH_MESH_MAIL_TRANSPORT=smtp
#   DSH_MESH_MAIL_REGION=cn-hangzhou
#   DSH_MESH_SMTP_USERNAME=login@你的发信域名
#   DSH_MESH_SMTP_PASSWORD=<控制台设的 SMTP 密码>
#   DSH_SERVER_TRUSTED_PROXY_IPS=172.16.0.0/12
sed -i '' 's/mesh.example.com/你的域名/' Caddyfile.account
docker compose -f compose.account.yaml up -d --build
```

生成 pepper：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Caddy 自动申请并续期证书——这就是为什么账号模式把 `DSH_SERVER_CERT_FINGERPRINT`
留空：客户端走系统 CA 校验，证书续期后不需要任何设备重新配对。

### TLS 的两种策略

| 场景 | 指纹 | 行为 |
| --- | --- | --- |
| 托管服务 / 正式证书 | 空 | 用系统 CA 库校验 |
| 自建 / 自签证书 | SPKI SHA-256 | 固定公钥，忽略 CA 链 |

改动在 `packages/plugin/src/pinned-tls.ts`：空指纹时 `createPinnedFetch` 直接返回
平台 `fetch`，`createPinnedWebSocketFactory` 直接返回普通 WebSocket。

## 6. 本地试跑（不发真邮件）

```bash
cd apps/server
pnpm build
DSH_SERVER_PORT=8080 \
DSH_MESH_MODE=account \
DSH_MESH_ACCOUNT_PEPPER=local-dev-pepper-at-least-32-characters \
DSH_MESH_ACCOUNT_DB=/tmp/accounts.sqlite3 \
DSH_MESH_MAIL_TRANSPORT=console \
DSH_SERVER_PUBLIC_URL=http://localhost:8080 \
DSH_SERVER_DATA_FILE=/tmp/state.json \
node dist/main.js
```

浏览器打开 `http://localhost:8080`，输入任意邮箱，验证码会打印在终端里。

## 7. 已知限制

1. **单进程。** 限流和「验证码只能用一次」依赖单实例的 SQLite 事务。
   多副本部署需要把这些表换成共享存储（Postgres/Redis），当前不支持。
2. **邮箱明文。** 见 §3。
3. **没有 CAPTCHA。** 公开部署前建议在反向代理层加风控，否则发送量会被刷。
4. **没有邮件退订/退信处理。** 硬退信会持续消耗发送配额，运营时需要盯发信日志。
5. **不支持一个邮箱多账号 / 团队共享。** 一个邮箱 = 一个人的信任域，与 14 号
   PRD 的 D8 一致。

## 8. 测试覆盖

`apps/server/tests/accounts.test.ts` 有 26 个用例，重点覆盖隔离与失效路径：

- 首次验证自动建号、再次验证不重复建号
- 大小写/空格归一化
- 错误码不建会话、验证码只能用一次、验证码绑定邮箱
- 新码作废旧码、试错锁定、冷却、临时邮箱拦截
- 邮件服务故障返回 502 而非 500
- **不泄漏邮箱是否已注册**（已知/未知地址的响应结构一致）
- 授权链接：无会话拒绝、nonce 校验、只能取一次、不能二次授权
- **多账号隔离**：各看各的设备；跨账号按 id 读/撤销返回 404
- 配对码按账号隔离，跨账号撤销返回 404
- client 设备只能枚举本账号的 host
- 撤销设备后原 token 立即失效
- 伪造 cookie 被拒

跑法：

```bash
cd apps/server && pnpm test
```

## 9. 一次真实部署的笔记

2026-11 首次账号模式上线时记下的东西。具体的主机、域名和路径已换成占位符：它们是运营方的环境，
不属于这份源码。留下的都是可复用的部分——规格下限、构建陷阱、验证命令的形状。

### 环境

| 项 | 取值 |
| --- | --- |
| 服务器 | 一台轻量应用服务器，2 GB 内存以内、x86_64 |
| 规格 | 1 GB 内存 + 4 GB swap，40 GB 磁盘（必须扩 swap，见下） |
| 源码 | 任意目录，例如 `/opt/dsh-mesh` |
| 域名 | `<your-domain>` 与 `www.<your-domain>` 的 A 记录指向服务器 |
| TLS | Let's Encrypt，Caddy 自动签发与续期 |
| 反代 | Caddy 2.8，80 + 443 |
| 应用 | `DSH_MESH_MODE=account`，容器内 8080 |

### 关键操作

```bash
# 1. 备份数据卷 + 证书 + 配置
STAMP=$(date +%Y%m%d-%H%M%S); BK=~/.dsh-mesh/backup-$STAMP
docker run --rm -v deploy_server-data:/data -v "$BK":/backup alpine cp -a /data/. /backup/server-data/
cp -a deploy/{server.env,certs,Caddyfile,compose.yaml} "$BK/"

# 2. 扩 swap，防止构建 OOM（小内存机器跑 pnpm + tsc + vite 不够）
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

# 3. 构建并启动
cd <install-dir>/deploy
docker compose -f compose.account.yaml build
docker compose -f compose.account.yaml up -d
```

### 踩过的三个坑

1. **`DSH_SERVER_TRUSTED_PROXY_IPS` 原本不接受 CIDR。**
   容器部署时反代地址由 Docker 分配，写不出单个 IP，只能给 `172.16.0.0/12`。
   已改成支持 CIDR（`normalizeTrustedProxyIps` + `isTrustedProxy`），并保留去重语义。

2. **旧 compose 只发布 443，没有 80。**
   ACME HTTP-01 挑战需要 80，否则 Caddy 无法签证书。
   `compose.account.yaml` 已同时发布 `80:80` 和 `443:443`。

3. **轻量应用服务器的防火墙在独立标签页，不是「安全组」。**
   路径：控制台 → 服务器 → 防火墙 → 添加规则（TCP 80/443，0.0.0.0/0）。

### 验证结果

```
$ curl https://<your-domain>/health
{"status":"ok","meshApi":1,"mode":"account"}

$ curl https://<your-domain>/api/v1/account/config
{"mode":"account","serverUrl":"https://<your-domain>","mail":{"transport":"smtp",...}}

$ openssl s_client -connect <your-domain>:443
subject=CN = <your-domain>
issuer=C = US, O = Let's Encrypt, CN = <intermediate>
```

真实邮件链路已验证：`POST /api/v1/auth/email/send` → 邮件服务商 SMTP →
目标邮箱收到验证码；挑战写入 `<data-dir>/accounts.sqlite3`，默认 10 分钟有效。

### 运维要点

`<host>` 是 `~/.ssh/config` 里的主机别名，`<install-dir>` 是源码目录（例如 `/opt/dsh-mesh`）。

```bash
# 查看状态
cd <install-dir>/deploy && docker compose -f compose.account.yaml ps
docker logs -f deploy-server-1

# 更新代码后重建
tar czf /tmp/src.tgz --exclude=node_modules --exclude=dist --exclude=.git .
scp /tmp/src.tgz <host>:/tmp/ && ssh <host> 'cd <install-dir> && tar xzf /tmp/src.tgz'
ssh <host> 'cd <install-dir>/deploy && docker compose -f compose.account.yaml up -d --build'

# 备份账号数据库（WAL 模式，必须先停容器）
ssh <host> 'cd <install-dir>/deploy && docker compose -f compose.account.yaml stop server'
ssh <host> 'docker run --rm -v deploy_server-data:/data -v /root/backup:/b alpine cp -a /data/. /b/'
ssh <host> 'cd <install-dir>/deploy && docker compose -f compose.account.yaml start server'
```

### 回滚到 v0

```bash
cd <old-install-dir>/deploy && docker compose up -d
# 证书与指纹在 ~/.dsh-mesh/backup-<stamp>/
```
