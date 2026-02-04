# YouTube Live Telegram Bot (Cloudflare Workers Edition)

[中文文档](README_CN.md) | English

A serverless Telegram bot that monitors YouTube channels for live streams and sends notifications to Telegram chats, supergroups, and topics. Run entirely on Cloudflare Workers (Free Tier compatible).

## Features

- **Serverless**: Runs on Cloudflare Workers (no VPS required).
- **Interactive Management**: Add/remove channels directly from Telegram.
- **Topic Support**: Fully supports Telegram Supergroup Topics (Threads).
- **Multi-Subscription**: Monitor multiple YouTube channels.
- **Cost Efficient**: Uses Cloudflare KV for state and Cron Triggers for scheduling.

## Prerequisites

1.  **Cloudflare Account**: [Sign up here](https://dash.cloudflare.com/sign-up).
2.  **Telegram Bot Token**: Get one from [@BotFather](https://t.me/BotFather).
3.  **GitHub Account**: For deployment via GitHub Actions.

## Setup Guide

### 1. Cloudflare Configuration

1.  **Create a KV Namespace**:
    *   Go to **Cloudflare Dashboard** > **Workers & Pages** > **KV**.
    *   Create a namespace named `YOUTUBE_BOT_KV`.
    *   Copy the **ID** of the namespace you just created.

2.  **Update Configuration**:
    *   Open `wrangler.toml` in this repository.
    *   Replace `TODO_REPLACE_WITH_YOUR_KV_ID` with your actual KV ID.
    *   (Optional) You can leave `preview_id` as is or set it to the same ID for testing.

### 2. Deployment

#### Option A: GitHub Actions (Recommended)

1.  Fork or push this repository to GitHub.
2.  Go to **Settings** > **Secrets and variables** > **Actions**.
3.  Add the following **Repository Secrets**:
    *   `CLOUDFLARE_API_TOKEN`: Create via [User Profile > API Tokens](https://dash.cloudflare.com/profile/api-tokens) (Template: *Edit Cloudflare Workers*).
    *   `CLOUDFLARE_ACCOUNT_ID`: Found on the right sidebar of your Workers dashboard.
4.  Push to the `main` branch. The Action will automatically deploy your worker.

#### Option B: Manual Deployment

```bash
npm install
npx wrangler deploy
```

### 3. Environment Secrets

After deployment, configure the secrets in Cloudflare:

1.  Go to **Cloudflare Dashboard** > **Workers & Pages** > **Overview** > Select `youtube-live-bot`.
2.  Go to **Settings** > **Variables and Secrets**.
3.  Add the following secrets:
    *   `TELEGRAM_BOT_TOKEN`: Your Telegram Bot Token (e.g., `123456:ABC-DEF...`).
    *   (Optional) `RSS_BASE_URL`: Defaults to `https://rss.dreaife.tokyo/youtube/live/`.

### 4. Setup Webhook (Crucial!)

For the bot to reply to commands, you must tell Telegram where your Worker is located.

1.  Find your Worker URL (e.g., `https://youtube-live-bot.your-subdomain.workers.dev`).
2.  Run this command in your browser or terminal:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>"
```

*Replace `<YOUR_BOT_TOKEN>` and `<YOUR_WORKER_URL>` with your actual values.*

## Usage

Add the bot to your Group or Supergroup.

*   **Add Subscription**:
    ```text
    /add <channel_id_or_name>
    ```
    *Example: `/add weathernews`*
    *If sent in a specific Topic, notifications will be sent to that Topic.*

*   **Remove Subscription**:
    ```text
    /del <channel_id_or_name>
    ```

*   **List Subscriptions**:
    ```text
    /list
    ```

## How it Works

1.  **Interactive**: When you send a command, Telegram pushes the update to the Worker (Webhook), which updates the subscription list in KV.
2.  **Scheduled**: Every 15 minutes (configurable in `wrangler.toml`), the Worker wakes up, checks RSS feeds for all subscriptions, and sends alerts for new streams.

## License

ISC
