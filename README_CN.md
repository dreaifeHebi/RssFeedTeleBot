# RSS Feed Telegram Bot (Cloudflare Workers 版)

[English](README.md) | 中文文档

一个监控 RSS 订阅源、X (Twitter) 用户和 YouTube 频道（通过 RSSHub），并将通知发送到 Telegram 聊天、Supergroup 和 Topic 的无服务器机器人。完全运行在 Cloudflare Workers 上（兼容免费套餐）。

## 功能特点

- **无服务器**: 运行在 Cloudflare Workers 上（无需 VPS）。
- **交互式管理**: 直接在 Telegram 中添加/删除订阅。
- **支持 Topic**: 完美支持 Telegram Supergroup 的 Topic（Threads）功能。
- **多订阅支持**: 同时监控多个 RSS/Atom 源。
- **选择性转发**: 将通知转发到另一个聊天，并可选择是否在源聊天中静音。
- **成本高效**: 使用 Cloudflare KV 存储状态，使用 Cron Triggers 进行定时检查。

## 前置要求

1.  **Cloudflare 账号**: [注册地址](https://dash.cloudflare.com/sign-up)。
2.  **Telegram Bot Token**: 通过 [@BotFather](https://t.me/BotFather) 获取。
3.  **GitHub 账号**: 用于通过 GitHub Actions 进行部署。

## 设置指南

### 1. Cloudflare 配置

1.  **创建 KV Namespace**:
    *   进入 **Cloudflare Dashboard** > **Workers & Pages** > **KV**。
    *   创建一个名为 `RSS_BOT_KV` 的命名空间。
    *   复制刚刚创建的 **ID**。

2.  **更新配置文件 (GitHub Actions 用户可选)**:
    *   **如果使用 GitHub Actions (推荐)**: 你可以跳过此步骤。工作流会自动从仓库密钥中注入 `KV_ID`。
    *   **如果手动部署**: 打开 `wrangler.toml` 并将 `TODO_REPLACE_WITH_YOUR_KV_ID` 替换为你的实际 KV ID。
    *   (可选) `preview_id` 可以保持原样，或者设置为相同的 ID 用于测试。

### 2. 部署

#### 方案 A: GitHub Actions (推荐)

1.  Fork 或推送此仓库到 GitHub。
2.  进入 **Settings** > **Secrets and variables** > **Actions**。
3.  添加以下 **Repository Secrets**:
    *   `CLOUDFLARE_API_TOKEN`: 通过 [用户资料 > API Tokens](https://dash.cloudflare.com/profile/api-tokens) 创建 (模板选择: *Edit Cloudflare Workers*)。
    *   `CLOUDFLARE_ACCOUNT_ID`: 在 Workers 面板的右侧边栏可以找到。
    *   `TELEGRAM_BOT_TOKEN`: 你的 Telegram Bot Token。
    *   `KV_ID`: 你的 `RSS_BOT_KV` 命名空间 ID。
    *   `RSS_BASE_URL`: (可选) 自定义的 RSS Base URL (默认为 `https://rsshub.app`)。
4.  推送到 `main` 分支。Action 将会自动部署你的 Worker。

#### 方案 B: 手动部署

```bash
npm install
npx wrangler deploy
```

### 3. 环境变量设置

部署完成后，需要在 Cloudflare 中配置密钥：

1.  进入 **Cloudflare Dashboard** > **Workers & Pages** > **Overview** > 选择 `rss-feed-bot`。
2.  进入 **Settings** > **Variables and Secrets**。
3.  添加以下密钥 (Secret):
    *   `TELEGRAM_BOT_TOKEN`: 你的 Telegram Bot Token。
    *   (可选) `RSS_BASE_URL`: 默认为 `https://rsshub.app`。

### 4. 设置 Webhook (关键步骤!)

为了让机器人能回复指令，你必须告诉 Telegram 你的 Worker 地址在哪里。

1.  找到你的 Worker URL (例如: `https://rss-feed-bot.your-subdomain.workers.dev`)。
2.  在浏览器或终端中运行以下命令：

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>"
```

*请将 `<YOUR_BOT_TOKEN>` 和 `<YOUR_WORKER_URL>` 替换为你的实际值。*

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
    /del <name>
    /del <type> <name>
    ```
    *示例:*
    *   `/del elonmusk`（删除当前 chat/thread 下同名订阅）
    *   `/del x elonmusk`（仅删除 X 订阅）
    *   `/del youtube elonmusk`（仅删除 YouTube 订阅）
    *`<type>` 支持 `rss`、`x`、`youtube`。*

*   **列出订阅**:
    ```text
    /list
    ```
    *输出格式:* `- [type] channel_name`（例如 `- [x] elonmusk`）

*   **转发设置**:
    配置将消息转发到另一个频道/群组。
    ```text
    /set_forward <target_chat_id> [only_forward: true/false]
    ```
    *示例: `/set_forward -100123456789 true` (仅发送到目标聊天)*
    
    移除配置:
    ```text
    /del_forward
    ```

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

## 工作原理

1.  **交互模式**: 当你发送指令时，Telegram 将更新推送给 Worker (Webhook)，Worker 更新 KV 中的订阅列表。
2.  **定时检查**: 每15分钟（可在 `wrangler.toml` 中配置），Worker 会唤醒一次，检查所有订阅的 RSS 源，并为新的更新发送通知。

## 许可证

ISC
