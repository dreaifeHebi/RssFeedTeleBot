# RSS Feed Telegram Bot (Cloudflare Workers 版)

[English](README.md) | 中文文档

一个监控 RSS 订阅源、X (Twitter) 用户和 YouTube 频道（通过 RSSHub），并将通知发送到 Telegram 聊天、Supergroup 和 Topic 的无服务器机器人。运行于 Cloudflare Workers，并使用 D1、KV 和 Cron Triggers。

## 功能特点

- **无服务器**: 运行在 Cloudflare Workers 上（无需 VPS）。
- **交互式管理**: 直接在 Telegram 中添加/删除订阅。
- **支持 Topic**: 支持 Telegram Supergroup 的 Topic（Threads）。
- **多订阅支持**: 同时监控多个 RSS/Atom 源。
- **选择性转发**: 将通知转发到另一个聊天，并可选择是否在源聊天中静音。
- **可靠投递**: D1 保存订阅、已处理的 Webhook ID，以及按目标拆分的 Outbox 投递任务。
- **安全运行**: Webhook 鉴权、管理命令授权、受限 Feed 拉取和 Telegram 失败重试。

## 前置要求

1. **Cloudflare 账号**: [注册地址](https://dash.cloudflare.com/sign-up)。
2. **Telegram Bot Token**: 通过 [@BotFather](https://t.me/BotFather) 获取。
3. **Node.js 20+** 和 npm，用于本地配置。
4. **GitHub 账号**: 仅在使用仓库自带部署工作流时需要。

## 设置指南

### 1. 安装依赖并创建存储

```bash
npm ci
npx wrangler kv namespace create DB
npx wrangler d1 create rss-feed-bot-db
```

把命令返回的 ID 写入 `wrangler.toml`：

- 使用 KV Namespace ID 替换 `TODO_REPLACE_WITH_YOUR_KV_ID` 和 `TODO_REPLACE_WITH_YOUR_KV_PREVIEW_ID`。正式环境和预览环境建议使用不同 Namespace，简单部署也可以使用同一个 ID。
- 使用 D1 数据库 UUID 替换 `TODO_REPLACE_WITH_YOUR_D1_ID`。不要修改 `DB` 和 `SQL` 绑定名，应用依赖这两个名称。

启动 Worker 前应用仓库中的 D1 迁移：

```bash
npm run db:migrate:remote
```

本地 D1 开发可使用 `npm run db:migrate:local`。

### 2. 配置 Worker 密钥和可选参数

以下两个密钥为必填项：

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

`TELEGRAM_WEBHOOK_SECRET` 长度必须为 1-256 个字符，并且只能包含字母、数字、`_` 和 `-`。它必须与后面注册 Telegram Webhook 时传入的 `secret_token` 完全一致。

可选 Worker 变量或密钥：

| 名称 | 用途 |
| --- | --- |
| `RSS_BASE_URL` | RSSHub 基础地址，默认为 `https://rsshub.app`，支持基础路径。 |
| `ADMIN_USER_IDS` | 允许执行管理命令的 Telegram 用户 ID，多个 ID 以逗号分隔；设置后即作为明确白名单。 |
| `TELEGRAM_BOT_USERNAME` | 不含 `@` 的机器人用户名，用于校验 `/add@my_bot` 形式的命令。 |
| `ALLOWED_FEED_HOSTS` | 允许的主机，以逗号分隔，支持精确主机或 `*.example.com`；使用 X/YouTube 路由时需包含 RSSHub 主机。 |
| `FEED_TIMEOUT_MS` | Feed 请求超时，默认 `10000`。 |
| `MAX_FEED_BYTES` | Feed 响应大小上限，默认 `1048576`。 |
| `MAX_ITEMS_PER_FEED` | 每个 Feed 每轮最多解析的条目数，默认 `20`。 |
| `MAX_FEEDS_PER_RUN` | 每轮定时任务最多抓取的不同 Feed 数，默认 `3`。 |
| `MAX_TELEGRAM_SENDS_PER_RUN` | 每轮定时任务最多处理的 Outbox 投递数，默认 `35`。 |
| `MAX_DELIVERY_ATTEMPTS` | Telegram 投递达到此次数后转为 dead，默认 `10`。 |
| `SENT_HISTORY_LIMIT` | 每个 Feed 最多保留的已见条目键数量，默认 `2000`。 |

最多三次重定向时，一个 Feed 可能消耗四次外部请求，因此默认预算为 `3 × 4 + 35 = 47` 次外部请求/轮，在 Workers Free 的 50 次上限内保留少量余量。调大任一上限前，请先核对当前 Cloudflare 套餐及 subrequest 限制。

可以在 **Workers & Pages > rss-feed-bot > Settings > Variables and Secrets** 中设置，也可以运行 `wrangler secret put <NAME>`。

### 3. 部署

#### GitHub Actions

在 **Settings > Secrets and variables > Actions** 中添加以下 Repository Secrets：

- `CLOUDFLARE_API_TOKEN`：允许编辑 Workers Scripts 和 D1 的账号级 Token。
- `CLOUDFLARE_ACCOUNT_ID`：目标 Cloudflare 账号。
- `TELEGRAM_BOT_TOKEN`：BotFather 提供的 Token。
- `TELEGRAM_WEBHOOK_SECRET`：与 Telegram `secret_token` 相同的值。
- `KV_ID`：生产 KV Namespace ID。
- `D1_ID`：生产 D1 数据库 UUID。

部署工作流会运行验证、应用远程 D1 迁移并部署 Worker。迁移先于 Worker 发布；后续 schema 变更必须保持向后兼容并采用 expand/contract。它仅在以下情况触发：

- 手动执行 `workflow_dispatch`；
- 推送匹配 `v*` 的 Tag；
- 合并 Pull Request 到 `master`。

普通推送到 `main` 或 `master` 不会触发该工作流。

#### 手动部署

替换 `wrangler.toml` 中的 ID 并完成 Wrangler 登录后，运行：

```bash
npm ci
npm test
npm run check
npm run db:migrate:remote
npm run deploy
```

如果尚未设置 Worker 必填密钥，请在部署后设置。以后只要 `migrations/` 中增加了迁移文件，都应在部署前先执行迁移。

### 4. 注册带鉴权的 Telegram Webhook

找到已部署的 Worker URL，然后使用与 `TELEGRAM_WEBHOOK_SECRET` 相同的密钥注册：

```bash
curl --request POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=https://rss-feed-bot.<YOUR_SUBDOMAIN>.workers.dev" \
  --data-urlencode "secret_token=<YOUR_TELEGRAM_WEBHOOK_SECRET>" \
  --data-urlencode 'allowed_updates=["message","callback_query"]'
```

Telegram 会把该值放入 `X-Telegram-Bot-Api-Secret-Token` 请求头；请求头缺失或不匹配时，Worker 会拒绝请求。

## 权限与 Feed URL 安全

- 管理命令包括 `/add`、`/del`、`/remove`、`/set_forward`、`/del_forward` 和 `/forward_to`。
- 设置 `ADMIN_USER_IDS` 后，只有白名单用户可以执行管理命令；该白名单也视为跨聊天转发配置的全局明确授权。
- 未设置白名单时，私聊仅允许会话所有者管理；群组中发送者必须是 Telegram 群主或管理员。`/set_forward` 或 `/forward_to` 指向不同聊天时，发送者还必须是目标聊天的管理员（同一聊天及本人私聊目标除外）。应将机器人设为群管理员，以便 `getChatMember` 可靠校验其他用户；校验失败时命令会被拒绝。
- Feed 校验会拒绝非 HTTP(S) 协议、内嵌凭据、localhost 和私有 IP 字面量。允许用户提交任意 URL 时，应配置 `ALLOWED_FEED_HOSTS`。
- RSS 订阅仅使用 hostname 作为安全展示名称；`/list` 和通知来源都不会展示 URL path、查询值、fragment 或内嵌凭据。
- 初始 URL 与每一跳重定向目标都会应用相同的主机白名单和私有字面量校验；应用层仍无法验证主机名的实际 DNS 解析结果，严格 SSRF 边界还需受控 DNS/出口策略。

## 使用方法

将机器人拉入你的群组或 Supergroup。

*   **添加订阅**:
    ```text
    /add rss <url>
    /add x <username>
    /add youtube <username>
    ```
    *示例:*
    *   `/add rss https://example.com/feed.xml`
    *   `/add x elonmusk`
    *   `/add youtube PewDiePie`

*   **移除订阅**:
    ```text
    /del #<subscription_id>
    /del <name>
    /del <type> <name>
    ```
    先使用 `/list` 获取订阅 ID，再优先使用 `/del #<subscription_id>`，精确删除当前 chat/thread 中的指定订阅。

    基于名称的旧格式会继续兼容，但仅在恰好匹配一条订阅时执行删除。存在重名时，机器人会拒绝删除并列出匹配的 ID；请改用 `/del #<subscription_id>` 重试。

    *示例:*
    *   `/del #42`（推荐；仅删除 ID 为 `42` 的订阅）
    *   `/del elonmusk`（仅当当前 chat/thread 中名称唯一时执行）
    *   `/del x elonmusk`（仅当恰好匹配一条 X 订阅时执行）
    *`<type>` 支持 `rss`、`x` 和 `youtube`。*

*   **列出订阅**:
    ```text
    /list
    ```
    *输出格式:* `#<subscription_id> [type] safe_name`（例如 `#42 [rss] example.com`）。RSS 的安全名称仅包含 hostname，不会展示 URL path 或内嵌凭据。

*   **转发设置**:
    配置将消息转发到另一个频道/群组。
    ```text
    /set_forward <target_chat_id> [target_thread_id] [only_forward] [scope]
    ```
    *   `target_thread_id`: 可选。转发到目标群组的指定 Topic。
    *   `only_forward`: 可选。`true` 表示不再发送到源群组，`false` 表示保留。
    *   `scope`: 可选。`topic` (默认) 或 `global`。
        *   `topic`: 仅适用于当前源 Topic。
        *   `global`: 适用于整个源群组（所有 Topic）。

    *示例:*
    *   `/set_forward -100123456789 123 true global` (全局转发到目标 Topic 123)
    *   `/set_forward -100123456789 456 false topic` (仅当前 Topic 转发到目标 Topic 456)
    
    移除配置:
    ```text
    /del_forward [scope]
    ```
    *   默认为 `topic`。使用 `/del_forward global` 移除全局配置。

*   **转发订阅 (批量复制)**:
    允许将当前会话的订阅复制到另一个会话（群组/频道）。
    ```text
    /forward_to <target_chat_id> [target_thread_id]
    ```

*   **获取会话信息**:
    ```text
    /id
    ```
    *返回当前的 Chat ID 和 Thread ID。*

*   **帮助**:
    ```text
    /help
    ```

## 架构与状态存储

- `index.js`：Worker 组合入口，负责 HTTP/Webhook 校验、Update 去重和定时事件。
- `src/commands.js`：命令解析、权限校验、订阅管理、转发配置和 Callback Session。
- `src/poller.js`：Feed 轮转、已见条目判断、转发目标解析、Outbox 入队和限额投递。
- `src/feeds.js`：URL 校验、受限 HTTP 拉取、RSS/Atom 解析、RSSHub URL 构造和条目指纹。
- `src/telegram.js`：安全的 HTML 渲染和结构化 Telegram API 结果，不在请求内休眠重试。
- `src/storage.js`：参数化 D1 访问、旧数据迁移、Webhook Claim、投递状态和保留期清理。

### 存储职责

- **D1 (`SQL`)** 保存 `subscriptions`、`processed_updates`、`operational_leases` 和 `deliveries`。Operational lease 会阻止重叠定时任务并发消费同一队列。每个条目/目标组合都有独立 Outbox 记录，因此 Telegram 部分投递失败时可以单独重试，不会丢失已成功目标。
- **KV (`DB`)** 保存有界的 Feed 已见历史、转发配置、短期转发 Session 和轮询游标。
- 应用 D1 迁移后，首次运行会自动把旧 KV `subscriptions` 数组复制到 D1。导入与迁移标记会一起提交，旧 KV 值会有意保留用于回滚/审计；确认 D1 数据正确后再手动删除。
- 投递语义为 at-least-once：若 Telegram 已接受消息、但 Worker 在 D1 标记 sent 前崩溃，后续重试可能再次投递同一消息。

### 运行流程

1. Telegram 发送带鉴权的 Webhook。`index.js` 先在 D1 Claim `update_id`，再分发命令或 Callback。
2. 定时任务每 15 分钟先获取 D1 operational lease，再轮转 Feed 顺序，每轮最多抓取 `MAX_FEEDS_PER_RUN` 个 Feed，并按选中数量推进游标。
3. Poller 每轮最多处理 `MAX_TELEGRAM_SENDS_PER_RUN` 条到期投递。成功目标标记为 sent；可重试错误会持久化退避直到 `MAX_DELIVERY_ATTEMPTS`，永久失败或耗尽重试则变为 dead；遇到 Telegram 429 时停止本轮投递。

## 许可证

ISC
