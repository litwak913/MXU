# MXU 内置 Web 服务鉴权设计方案

本文档描述 MXU 内置 Web 服务（axum，默认 `127.0.0.1:12701`）的鉴权设计，目标是在保留远程控制能力的前提下，阻断未授权访问与「被作为跳板植入木马」的风险。

> 状态：设计稿。实现按 §10 分期推进，接口细节以本文档为准；落地时若与本设计产生偏差，应回写本文档。

## 1. 背景与现状

MXU 通过内置 axum 服务同时服务 WebUI 静态资源与 HTTP/WebSocket API，供浏览器客户端（本机 / 局域网 / 公网反代）访问，与 Tauri `invoke` 构成同一套后端状态的双通道。

当前实现（`src-tauri/src/web_server.rs`）**没有任何鉴权**，且 CORS 使用 `allow_origin(Any)`。结合 MaaFramework 的能力，这意味着任意能访问该端口的客户端都可以在宿主机上落地任意代码。

### 1.1 暴露的高危端点

| 端点 | 危害 |
| ------ | ------ |
| `PUT/POST /api/config` | 写任意 `settings` / 实例配置，可注入 `agent.child_exec` |
| `POST /api/maa/instances/:id/tasks/start` | `agent_configs[].child_exec` + `child_args` 直接 spawn 任意可执行文件（`maa_agent.rs` 的 `resolve_child_exec_path`） |
| `POST /api/maa/instances/:id/resource/load` | 加载任意路径资源；配合 `mxu_actions.rs` 的 custom action（`MXU_LAUNCH`、关机/重启等）执行 |
| `POST /api/maa/instances/:id/click`、`GET .../screenshot` | 控制目标设备，可作为远控跳板 |
| `POST /api/system/restart-as-admin` | 诱导 UAC 提权 |
| `GET /api/local-file?path=` | 读取 exe 目录内文件（已有穿越防护，但仍泄露） |
| `GET /api/interface` | 泄露 `basePath` / `dataPath` 绝对路径 |
| `GET /api/ws` | 实时获取日志、截图、状态事件 |

### 1.2 攻击路径

1. **同机恶意网页 / DNS Rebinding**：`allow_origin(Any)` 允许任意站点 `fetch('http://127.0.0.1:12701/api/config')` 并**读取响应**，随后写入带恶意 `child_exec` 的配置并启动任务。回环绑定无法阻止。
2. **CSRF**：`POST .../tasks/stop` 这类无 body 端点属于「简单请求」，跨站表单即可触发；GET 端点可被 `<img>` / `fetch` 直接打。
3. **局域网**：`allowLanAccess=true` 时绑定 `0.0.0.0`，同网任意设备可直连。
4. **WS 校验不足**：`is_same_origin_ws_request` 仅在 release 生效，且对无 `Origin` 请求「保守兼容」，无法阻止脚本客户端。

结论：**回环不等于可信**（浏览器就在回环上），**CORS `Any` 等于给同机网页发放钥匙**。这是本设计的两个核心出发点。

## 2. 设计目标与原则

- **默认拒绝**：除健康检查与认证入口外，所有 `/api/*` 必须鉴权。
- **回环不等于可信**：即使仅监听 `127.0.0.1` 也要求凭证。
- **最小权限**：读（状态/截图/日志）与控制（任务/配置/Agent）分离。
- **凭证不落明文**：磁盘只存哈希；常量时间比较；配对/登录限流。
- **桌面端零感知**：桌面应用自动携带设备令牌，用户无需操作。
- **远程端一次配对**：一次性配对码换取持久会话。
- **纵深防御**：鉴权之外，对危险端点与路径再设一道闸，不能只靠单点。

## 3. 架构总览

```text
                         ┌──────────────────────────────┐
  桌面 WebView ──invoke──▶ get_web_auth_token（设备令牌）
       │                 └──────────────┬───────────────┘
       │ fetch: Authorization: Bearer   │
       ▼                                ▼
  ┌─────────────────────────────────────────────────────┐
  │              axum /api  (127.0.0.1:12701)            │
  │                                                      │
  │  Host/Origin 校验 ──▶ 鉴权中间件 ──▶ 角色校验 ──▶ handler │
  │        │                  │              │            │
  │        │            设备令牌 / 会话     viewer/operator │
  │        │                  │                           │
  │  public 子路由 ──────────┘                            │
  │  (heartbeat / auth/pair / auth/status)                │
  └─────────────────────────────────────────────────────┘
       ▲
       │ Set-Cookie: mxu_session=...（配对码交换）
  远程浏览器（局域网 / 公网反代）
```

认证信息解析优先级：`Authorization: Bearer <token>` → `Cookie: mxu_session=<id>`。

## 4. 凭证与会话模型

### 4.1 持久化文件

路径 `${data_dir}/auth.json`，Unix `0600`，Windows 限制为当前用户 ACL。**只存哈希，不落明文。**

```jsonc
{
  "version": 1,
  "deviceTokenHash": "<sha256>",        // 桌面设备令牌哈希
  "sessions": [
    {
      "idHash": "<sha256>",             // Cookie 值的哈希
      "role": "viewer",                 // "viewer" | "operator"
      "label": "Chrome on Xiaomi",      // 由 UA 解析出的可读名
      "peerIp": "192.168.1.23",         // 仅供展示
      "createdAt": 1750000000,
      "lastSeenAt": 1750000000,
      "expiresAt": 1752592000           // 30 天，滑动续期
    }
  ]
}
```

### 4.2 设备令牌（Desktop Device Token）

- 首次运行生成 256-bit 随机值（base64url），磁盘只存 `SHA-256`。
- 桌面端通过 Tauri `invoke('get_web_auth_token')` 取明文（`invoke` 仅本应用 WebView 可调用），内存持有。
- 所有 HTTP 请求携带 `Authorization: Bearer <token>`；WebSocket 用子协议传递（见 §7）。
- 设置页提供「重新生成令牌」，旧令牌立即失效。
- 桌面设备令牌默认授予 `operator`（可在设置中降为 `viewer`）。

### 4.3 浏览器会话（Session）

- 通过配对码交换得到，服务端下发：

  ```http
  Set-Cookie: mxu_session=<32B random base64url>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000
  ```

  HTTPS（含反代 `X-Forwarded-Proto: https`）时追加 `Secure`。
- 服务端只存 `SHA-256(session)`，附角色、时间戳、UA、来源 IP。
- 默认 30 天滑动过期；持久化到 `auth.json`，**应用重启后浏览器保持登录**。
- 桌面端可查看在线设备列表并单独吊销。

### 4.4 配对码（Pairing Code）

- 桌面设置页点击「生成配对码」，显示 8 位 Crockford Base32（40 bit），**TTL 300 秒、一次性、失败 5 次即作废**。
- 生成时由桌面端选定角色（只读 / 可控制），角色绑定在码内，远程端不能自行提权。
- 比较使用 `subtle` 常量时间比较。
- `/api/auth/pair` 独立限流：单 IP 5 次/分钟，全局 20 次/分钟。

### 4.5 配对流程

```text
桌面设置页            远程浏览器                     后端
   │  生成配对码           │                            │
   │──────────────────────┼───────────────────────────▶│ 写入 PairingCode(role, ttl, attempts)
   │  展示 8 位码           │                            │
   │                       │ 打开 WebUI                  │
   │                       │──GET /api/auth/status──────▶│ 401（无有效会话）
   │                       │◀─ 401 ─────────────────────│
   │                       │ 显示配对界面                 │
   │                       │──POST /api/auth/pair────────▶│ 校验码 + 限流
   │                       │◀─ 200 + Set-Cookie ────────│ 生成会话
   │                       │ 正常使用 WebUI               │
```

## 5. 端点权限矩阵

| 分类 | 端点 | 要求 |
| ------ | ------ | ------ |
| public | `GET /api/heartbeat`、`POST /api/auth/pair`、`GET /api/auth/status` | 仅 Host/Origin 校验 |
| viewer | `GET /api/interface`、`GET /api/config`、`GET /api/background-image`、`GET /api/maa/state`、`GET /api/maa/initialized`、`GET /api/maa/devices`、`GET /api/maa/windows`、`GET /api/maa/wlroots-sockets`、`GET /api/maa/gamescope-instances`、`GET /api/maa/instances/:id/screenshot`、`GET /api/logs`、`GET /api/system/is-elevated` | viewer 或 operator |
| operator | `PUT/POST /api/config`、`PUT/DELETE /api/maa/instances/:id`、`POST /api/maa/instances/:id/connect`、`.../resource/load`、`.../tasks/run`、`.../tasks/start`、`.../tasks/stop`、`.../tasks/:task_id/pipeline`、`.../agent/stop`、`.../click`、`.../screenshot/subscribe`、`.../screenshot/unsubscribe`、`POST/DELETE /api/logs/:id` | 仅 operator |
| local-only | `POST /api/system/restart-as-admin`、`GET /api/local-file` | operator **且** 真实来源为回环（见 §6.3） |
| WebSocket | `GET /api/ws` | viewer/operator，按角色可选过滤事件 |

**CSRF 第二道防线**：所有非 public 的浏览器请求额外要求自定义头 `X-Requested-With: MXU`。跨站请求无法在不触发预检的情况下携带该头，而预检受 Origin 白名单限制。

## 6. 网络层校验

### 6.1 CORS 收紧

不再使用 `allow_origin(Any)`。白名单仅保留：

- `tauri://localhost`
- `http://tauri.localhost`、`https://tauri.localhost`
- dev 模式的 `http://localhost:1420`

浏览器 WebUI 由后端自身托管，属同源，无需 CORS 头。此项直接消除「同机网页读取响应」的路径。

### 6.2 Host 校验（防 DNS Rebinding）

允许集合 = `{127.0.0.1, localhost, [::1], 本机局域网 IP} ∪ allowedHosts ∪ （信任代理时的 X-Forwarded-Host）`。

`allowedHosts` 默认空，由用户在设置中显式登记公网域名。

### 6.3 反向代理与真实来源

新增设置项：

```jsonc
"settings": {
  "trustedProxies": ["10.0.0.0/8", "172.16.0.0/12"],  // 默认空 = 不信任任何代理头
  "allowedHosts": ["mxu.example.com"],                 // 默认空
  "publicAccess": false                                // 显式确认已暴露公网
}
```

- **仅当** socket 来源 IP 落在 `trustedProxies` 内，才采信 `X-Forwarded-For`（取最右侧非信任跳）、`X-Forwarded-Proto`、`X-Forwarded-Host`；否则一律使用 socket 地址。
- 伪造 `X-Forwarded-For: 127.0.0.1` 是绕过 local-only 限制的关键风险，上述约束必须严格执行。
- `Secure` Cookie 由 `X-Forwarded-Proto` 决定。
- `publicAccess=true` 时，设置页显示醒目警告，并要求操作员配对码必须由桌面端生成。

> 公网暴露必须由外部反向代理终止 TLS。本设计不内置 TLS。

## 7. WebSocket 鉴权

- **浏览器**：Cookie 随握手自动携带，在 `handle_ws_upgrade` 内完成会话校验，替换现有宽松的 `is_same_origin_ws_request`。
- **桌面端**：`new WebSocket(url, ['mxu.token.<token>'])`，服务端读取 `Sec-WebSocket-Protocol`，避免令牌出现在 URL 或访问日志。
- 维护 `connectionId → sessionId` 映射；会话吊销或过期时主动关闭对应连接并发送 close 帧。
- 仍保留 Host/Origin 校验。

## 8. 纵深防御

即使攻击者已取得 `operator`，也应限制爆炸半径：

- **Agent `child_exec` 白名单**：仅允许位于 `base_path` / `maafw_dir` 内，或 `interface.json` 中声明的 agent；拒绝任意绝对路径（当前逻辑允许绝对路径，等价于任意执行）。
- **`resource/load` 路径**：限制在 `base_path` 内。
- **配置写入校验**：`PUT /api/config` 对 `agent` / `resource` 字段执行与上两条相同的路径校验，否则改配置即可绕过。
- **`local-file` 收窄**：限制为图标、翻译、描述等资源类型。
- **`restart-as-admin`**：强制来源为回环，远程一律 403。

## 9. 审计与限流

- **审计日志**记录：配对成功/失败、登录、令牌重生成、危险操作（`tasks/start`、`agent/start`、`resource/load`、配置写入、`restart-as-admin`）的时间、IP、UA、角色与结果。
- 对所有 401/403 做 per-IP 节流，防止在线爆破与端口探测。
- 限流键在信任代理模式下使用真实来源 IP（§6.3）。

## 10. 实现清单与分期

### 10.1 涉及文件

| 文件 | 改动 |
| ------ | ------ |
| `src-tauri/src/auth.rs`（新增） | `AuthState` / 令牌与会话存储 / 配对 / 限流 / 审计 / axum 中间件 |
| `src-tauri/src/web_server.rs` | `/api/*` 挂鉴权中间件；public 子路由拆分；CORS / Host / Origin 收紧；WS 鉴权；local-only 端点限制 |
| `src-tauri/src/lib.rs` | 启动时初始化 `AuthState`（读取 `auth.json`）并传入 `start_web_server` |
| `src-tauri/src/commands/auth.rs`（新增） | `get_web_auth_token`、`auth_list_sessions`、`auth_revoke_session`、`auth_generate_pairing_code` |
| `src-tauri/src/commands/app_config.rs` | `auth.json` 读写与权限（0600 / ACL） |
| `src-tauri/src/commands/maa_agent.rs` | `child_exec` 白名单校验 |
| `src-tauri/src/commands/maa_core.rs` | resource 路径白名单校验 |
| `src/utils/backendApi.ts` | 注入 `Authorization` / `credentials: 'include'` / `X-Requested-With`；401 抛专用错误 |
| `src/services/wsService.ts` | 桌面端使用子协议传令牌；浏览器依赖 Cookie |
| `src/services/interfaceLoader.ts` | 401 时进入配对流程，不回退静态文件 |
| 新增配对视图 + 设置页「Web 访问」区块 | 状态、URL、生成配对码、在线设备列表与吊销、反代配置、公网警告 |
| `src/i18n/locales/*.ts` | 同步 `zh-CN` / `zh-TW` / `en-US` / `ja-JP` / `ko-KR` |
| `src-tauri/Cargo.toml` | 新增 `rand`、`subtle`、`axum-extra`（`cookie` feature）；`sha2` 已有 |

### 10.2 分期

| 阶段 | 内容 |
| ------ | ------ |
| **P0** 阻断 RCE | 设备令牌 + `/api/*` 鉴权中间件 + CORS/Origin/Host 收紧 + WS 鉴权 + `child_exec`/resource 路径白名单 |
| **P1** 远程可用 | 配对码与会话持久化、角色选择、在线设备管理与吊销、审计日志、配对/设置 UI 与 5 语言 |
| **P2** 部署加固 | `trustedProxies` / `allowedHosts` / `publicAccess`、反代真实来源、viewer 事件过滤、限流键修正 |

### 10.3 验证要点

- 同机恶意页面无法读取 `/api/*` 响应，且跨站请求返回 403。
- 无凭证访问任意非 public 端点返回 401。
- viewer 会话调用 operator 端点返回 403。
- 伪造 `X-Forwarded-For: 127.0.0.1` 在未配置 `trustedProxies` 时无法访问 local-only 端点。
- `child_exec` 指向白名单外路径时启动任务失败。
- 应用重启后浏览器会话仍有效；吊销后立即失效且 WS 断开。

## 11. 取舍与残余风险

- **明文 LAN**：局域网默认 HTTP，Cookie/令牌可能被同网嗅探。P0 建议仅在受信内网开启 LAN；公网必须由外部反代终止 TLS。
- **桌面设备令牌泄露**：interface 内容的 Markdown/富文本渲染理论存在 XSS 风险。但该项目内容本就可执行 custom action，收益极低，不作为本设计目标。
- **宿主机已失陷**：任何应用层鉴权均无效，本设计只解决「未授权远程 / 同机网页利用 Web 服务」这一类问题。
