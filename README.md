# RSS Feed Telegram Bot (Cloudflare Workers Edition)

[中文文档](README_CN.md) | English

A serverless Telegram bot that monitors RSS feeds, X (Twitter) users, and YouTube channels (via RSSHub) and sends notifications to Telegram chats, supergroups, and topics. Run entirely on Cloudflare Workers (Free Tier compatible).

## Features

- **Serverless**: Runs on Cloudflare Workers (no VPS required).
- **Interactive Management**: Add/remove subscriptions directly from Telegram.
- **Topic Support**: Fully supports Telegram Supergroup Topics (Threads).
- **Multi-Subscription**: Monitor multiple feeds.
- **Selective Forwarding**: Forward notifications to another chat, with option to mute source.
- **Cost Efficient**: Uses Cloudflare KV for state and Cron Triggers for scheduling.

## Prerequisites

1.  **Cloudflare Account**: [Sign up here](https://dash.cloudflare.com/sign-up).
2.  **Telegram Bot Token**: Get one from [@BotFather](https://t.me/BotFather).
3.  **GitHub Account**: For deployment via GitHub Actions.

## Setup Guide

### 1. Cloudflare Configuration

1.  **Create a KV Namespace**:
    *   Go to **Cloudflare Dashboard** > **Workers & Pages** > **KV**.
    *   Create a namespace named `RSS_BOT_KV`.
    *   Copy the **ID** of the namespace you just created.

2.  **Update Configuration (Optional for GitHub Actions)**:
    *   **If using GitHub Actions (Recommended)**: You can skip this step. The workflow will automatically inject the `KV_ID` from your repository secrets.
    *   **If deploying manually**: Open `wrangler.toml` and replace `TODO_REPLACE_WITH_YOUR_KV_ID` with your actual KV ID.
    *   (Optional) You can leave `preview_id` as is or set it to the same ID for testing.

### 2. Deployment

#### Option A: GitHub Actions (Recommended)

1.  Fork or push this repository to GitHub.
2.  Go to **Settings** > **Secrets and variables** > **Actions**.
3.  Add the following **Repository Secrets**:
    *   `CLOUDFLARE_API_TOKEN`: Create via [User Profile > API Tokens](https://dash.cloudflare.com/profile/api-tokens) (Template: *Edit Cloudflare Workers*).
    *   `CLOUDFLARE_ACCOUNT_ID`: Found on the right sidebar of your Workers dashboard.
    *   `TELEGRAM_BOT_TOKEN`: Your Telegram Bot Token.
    *   `KV_ID`: The ID of your `RSS_BOT_KV` namespace.
    *   `RSS_BASE_URL`: (Optional) Custom RSSHub base URL (defaults to `https://rsshub.app`). Supports host-only or base path (e.g. `https://rsshub.app` or `https://your-rsshub.example.com/proxy`). Legacy full-route values (like `/youtube/user`) are auto-normalized.
4.  Push to the `main` branch. The Action will automatically deploy your worker.

#### Option B: Manual Deployment

```bash
npm install
npx wrangler deploy
```

### 3. Environment Secrets

After deployment, configure the secrets in Cloudflare:

1.  Go to **Cloudflare Dashboard** > **Workers & Pages** > **Overview** > Select `rss-feed-bot`.
2.  Go to **Settings** > **Variables and Secrets**.
3.  Add the following secrets:
    *   `TELEGRAM_BOT_TOKEN`: Your Telegram Bot Token.
    *   (Optional) `RSS_BASE_URL`: Defaults to `https://rsshub.app`. Supports host-only or base path. Legacy full-route values (like `/youtube/user`) are auto-normalized.

### 4. Setup Webhook (Crucial!)

For the bot to reply to commands, you must tell Telegram where your Worker is located.

1.  Find your Worker URL (e.g., `https://rss-feed-bot.your-subdomain.workers.dev`).
2.  Run this command in your browser or terminal:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>"
```

*Replace `<YOUR_BOT_TOKEN>` and `<YOUR_WORKER_URL>` with your actual values.*

## Usage

Add the bot to your Group or Supergroup.

*   **Add Subscription**:
    ```text
    /add rss <url>
    /add x <username>
    /add youtube <username>
    ```
    *Example:*
    *   `/add rss https://example.com/feed.xml`
    *   `/add x elonmusk`
    *   `/add youtube PewDiePie`

*   **Remove Subscription**:
    ```text
    /del <name>
    /del <type> <name>
    ```
    *Example:*
    *   `/del elonmusk` (remove all subscriptions named `elonmusk` in current chat/thread)
    *   `/del x elonmusk` (remove only X subscription)
    *   `/del youtube elonmusk` (remove only YouTube subscription)
    *`<type>` supports `rss`, `x`, `youtube`.*

*   **List Subscriptions**:
    ```text
    /list
    ```
    *Output format:* `- [type] channel_name` (e.g. `- [x] elonmusk`)

*   **Forwarding Settings**:
    Configure message forwarding to another channel/group.
    ```text
    /set_forward <target_chat_id> [only_forward: true/false]
    ```
    *Example: `/set_forward -100123456789 true` (Sends ONLY to target)*
    
    To remove:
    ```text
    /del_forward
    ```

*   **Forward Subscriptions (Bulk Copy)**:
    Allows copying subscriptions from the current chat to another chat.
    ```text
    /forward_to <target_chat_id> [target_thread_id]
    ```

*   **Get Chat Info**:
    ```text
    /id
    ```
    *Returns the current Chat ID and Thread ID.*

*   **Help**:
    ```text
    /help
    ```

## How it Works

1.  **Interactive**: When you send a command, Telegram pushes the update to the Worker (Webhook), which updates the subscription list in KV.
2.  **Scheduled**: Every 15 minutes (configurable in `wrangler.toml`), the Worker wakes up, checks RSS feeds for all subscriptions, and sends alerts for new updates.

## License

ISC
