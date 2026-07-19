# RSS Feed Telegram Bot (Cloudflare Workers Edition)

[中文文档](README_CN.md) | English

A serverless Telegram bot that monitors RSS feeds, X (Twitter) users, and YouTube channels (via RSSHub), then sends notifications to Telegram chats, supergroups, and topics. It runs on Cloudflare Workers with D1, KV, and Cron Triggers.

## Features

- **Serverless**: Runs on Cloudflare Workers (no VPS required).
- **Interactive Management**: Add/remove subscriptions directly from Telegram.
- **Topic Support**: Supports Telegram supergroup topics (threads).
- **Multi-Subscription**: Monitor multiple feeds.
- **Selective Forwarding**: Forward notifications to another chat, with option to mute source.
- **Durable Delivery**: D1 stores subscriptions, processed webhook IDs, and per-target outbox deliveries.
- **Safer Operations**: Authenticated webhooks, command authorization, bounded feed fetching, and retryable Telegram delivery.

## Prerequisites

1. **Cloudflare account**: [Sign up here](https://dash.cloudflare.com/sign-up).
2. **Telegram bot token**: Get one from [@BotFather](https://t.me/BotFather).
3. **Node.js 22.13+** and npm for local setup.
4. **GitHub account** only if you use the included deployment workflow.

## Setup Guide

### 1. Install dependencies and create storage

```bash
npm ci
npx wrangler kv namespace create DB
npx wrangler d1 create rss-feed-bot-db
```

Copy the returned IDs into `wrangler.toml`:

- Replace `TODO_REPLACE_WITH_YOUR_KV_ID` and `TODO_REPLACE_WITH_YOUR_KV_PREVIEW_ID` with the KV namespace ID. A separate preview namespace is recommended, but the same ID works for a simple setup.
- Replace `TODO_REPLACE_WITH_YOUR_D1_ID` with the D1 database UUID. Keep the binding names `DB` and `SQL`; the application expects them.

Apply the checked-in D1 migrations before starting the Worker:

```bash
npm run db:migrate:remote
```

For local D1 development, use `npm run db:migrate:local`.

### 2. Configure Worker secrets and optional settings

These two secrets are required:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

`TELEGRAM_WEBHOOK_SECRET` must be 1-256 characters using only letters, digits, `_`, and `-`. It must exactly match the `secret_token` passed to Telegram in the webhook step below.

Optional Worker variables or secrets:

| Name | Purpose |
| --- | --- |
| `RSS_BASE_URL` | RSSHub base URL; defaults to `https://rsshub.app`. A base path is supported. |
| `ADMIN_USER_IDS` | Comma-separated Telegram user IDs allowed to run management commands. When set, this is the explicit allowlist. |
| `TELEGRAM_BOT_USERNAME` | Bot username without `@`, used to validate commands such as `/add@my_bot`. |
| `ALLOWED_FEED_HOSTS` | Comma-separated exact hosts or wildcard entries such as `*.example.com`; include the RSSHub host when using X/YouTube routes. |
| `FEED_TIMEOUT_MS` | Feed request timeout; default `10000`. |
| `MAX_FEED_BYTES` | Maximum feed response size; default `1048576`. |
| `MAX_ITEMS_PER_FEED` | Maximum parsed items per feed and poll; default `20`. |
| `MAX_FEEDS_PER_RUN` | Maximum distinct feeds fetched per scheduled run; default `3`. |
| `MAX_TELEGRAM_SENDS_PER_RUN` | Maximum outbox sends per scheduled run; default `35`. |
| `MAX_DELIVERY_ATTEMPTS` | Maximum Telegram delivery attempts before an outbox row becomes dead; default `10`. |
| `SENT_HISTORY_LIMIT` | Maximum seen-item keys retained per feed; default `2000`. |

With up to three redirects, one feed can consume four external requests. The defaults therefore budget `3 × 4 + 35 = 47` external requests per scheduled run, leaving a small margin under the Workers Free limit of 50. Check the current Cloudflare plan and subrequest limits before increasing either cap.

You can set these in **Workers & Pages > rss-feed-bot > Settings > Variables and Secrets**, or with `wrangler secret put <NAME>`.

### 3. Deploy

#### GitHub Actions

Add these repository secrets under **Settings > Secrets and variables > Actions**:

- `CLOUDFLARE_API_TOKEN`: an account token allowed to edit Workers Scripts and D1.
- `CLOUDFLARE_ACCOUNT_ID`: the target Cloudflare account.
- `TELEGRAM_BOT_TOKEN`: the token from BotFather.
- `TELEGRAM_WEBHOOK_SECRET`: the same value used as Telegram's `secret_token`.
- `KV_ID`: the production KV namespace ID.
- `D1_ID`: the production D1 database UUID.

The deployment workflow runs its verification suite, applies remote D1 migrations, and deploys. Migrations run before the Worker is published; future schema changes must remain backward compatible and use an expand/contract rollout. It is triggered only by:

- a manual `workflow_dispatch` run;
- pushing a tag matching `v*`; or
- merging a pull request into `master`.

A normal push to `main` or `master` does not trigger this workflow.

#### Manual deployment

After replacing the IDs in `wrangler.toml` and authenticating Wrangler, run:

```bash
npm ci
npm test
npm run check
npm run db:migrate:remote
npm run deploy
```

Then set the required Worker secrets if you have not done so already. Run migrations before every deployment that introduces a new file under `migrations/`.

#### Workers observability and Telegram diagnostics

`wrangler.toml` explicitly enables persisted Workers Logs, invocation logs,
and uploaded source maps. Logs use 100% head sampling while the Telegram
egress failure is under investigation. The configuration takes effect only
after the next deployment.

Stream events during verification with:

```bash
npx wrangler tail rss-feed-bot --format json
```

Telegram failures are emitted as structured records. Useful fields include:

- `source` and `operation` (`sendMessage`, `getChatMember`, or `answerCallbackQuery`);
- `failureKind` and `failurePhase` (`fetch`, `redirect`, `response_body`, `response_parse`, or `response_validate`);
- `upstreamStatus`, hostname-only `redirectHost`, `durationMs`, timeout state, exception name/message, and safe cause details;
- `deliveryId`, `attempt`, `maxAttempts`, and `exhausted` for scheduled Outbox sends.

The diagnostic allowlist never logs the bot token, Bot API URL, redirect
location, chat/thread IDs, message payload, response body, or stack. Workers
Logs add invocation, version, and Cloudflare metadata, while source maps keep
uncaught runtime stacks readable.

Automatic Workers Traces are intentionally disabled. Cloudflare's automatic
`fetch` spans currently capture `url.full` and `url.path`, but Telegram
puts the bot token in the Bot API path. Do not enable traces until those
attributes can be redacted or the request is routed through a trusted
token-hiding proxy.

### 4. Register the authenticated Telegram webhook

Find the deployed Worker URL, then register it with the same secret stored as `TELEGRAM_WEBHOOK_SECRET`:

```bash
curl --request POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=https://rss-feed-bot.<YOUR_SUBDOMAIN>.workers.dev" \
  --data-urlencode "secret_token=<YOUR_TELEGRAM_WEBHOOK_SECRET>" \
  --data-urlencode 'allowed_updates=["message","callback_query"]'
```

Telegram will send this value in `X-Telegram-Bot-Api-Secret-Token`; requests without the matching header are rejected.

## Authorization and Feed URL Security

- Management commands are `/start`, `/menu`, `/add`, `/del`, `/remove`, `/set_forward`, `/del_forward`, and `/forward_to`. Menu callbacks and follow-up text input re-check the same authorization.
- If `ADMIN_USER_IDS` is set, only users in that allowlist may run management commands; the allowlist is also explicit global authorization for cross-chat forwarding changes.
- Without an allowlist, a private chat is managed only by its owner. In groups, the sender must be a Telegram creator or administrator. For `/set_forward` or `/forward_to` targeting a different chat, the sender must also administer the target chat (same-chat and self private-chat targets are exempt). Make the bot a group administrator so `getChatMember` can reliably verify other users; failed verification denies the command.
- Feed validation rejects non-HTTP(S) schemes, credentials, localhost, and private IP literals. `ALLOWED_FEED_HOSTS` should be set when users may submit arbitrary URLs.
- RSS subscriptions use a hostname-only safe display name; URL paths, query values, fragments, and embedded credentials are never shown in `/list` or notification source labels.
- The initial URL and every redirect target are checked against the same host allowlist and private-literal rules. The application still cannot verify hostname DNS resolution, so a strict SSRF boundary also needs controlled DNS/egress policy.

## Usage

Add the bot to your Group or Supergroup.

### Recommended: menu-first management

Send `/menu` to open the main menu. It lets you:

- choose RSS, X, or YouTube and reply with the URL/username;
- page through subscriptions in the current chat/topic and confirm deletions;
- manage forwarding targets, source delivery, and default-route inheritance per subscription, including an explicit source-only override;
- enter a target chat/topic and choose subscriptions to copy from a paginated list;
- view the current Chat ID, Topic ID, and help.

Input sessions expire after 10 minutes and menus after one hour. Both are bound
to the initiating user, chat, and topic. In groups, reply directly to the bot's
input prompt. Use `/cancel` to cancel the current input. RSS labels continue to
show only the hostname, never URL paths, query values, or credentials.

The commands below remain available as shortcuts.

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
    /del #<subscription_id>
    /del <name>
    /del <type> <name>
    ```
    Use `/list` to find the subscription ID, then prefer `/del #<subscription_id>` for an exact deletion in the current chat/thread.

    The name-based forms are retained for compatibility, but they delete only when exactly one subscription matches. If names are duplicated, the bot refuses the deletion and lists the matching IDs so you can retry with `/del #<subscription_id>`.

    *Examples:*
    *   `/del #42` (recommended; remove exactly subscription `42`)
    *   `/del elonmusk` (works only when the name is unique in the current chat/thread)
    *   `/del x elonmusk` (works only when one X subscription matches)
    *`<type>` supports `rss`, `x`, and `youtube`.*

*   **List Subscriptions**:
    ```text
    /list
    ```
    *Output format:* `#<subscription_id> [type] safe_name` (for example, `#42 [rss] example.com`). RSS safe names contain only the hostname; URL paths and embedded credentials are never displayed.

*   **Default Chat/Topic Message Forwarding**:
    Configure the default route for subscriptions in the current chat/topic.
    ```text
    /set_forward <target_chat_id> [target_thread_id] [only_forward] [scope]
    ```
    *   `target_thread_id`: Optional. Forward to a specific topic/thread in the target group.
    *   `only_forward`: Optional. `true` to stop sending to source, `false` to keep both.
    *   `scope`: Optional. `topic` (default) or `global`.
        *   `topic`: Applies only to the current source topic/thread.
        *   `global`: Applies to the entire source chat (all topics).

    *Example:*
    *   `/set_forward -100123456789 123 true global` (Global forward to target topic 123)
    *   `/set_forward -100123456789 456 false topic` (Topic forward to target topic 456)
    
    To remove:
    ```text
    /del_forward [scope]
    ```
    *   Default scope is `topic`. Use `/del_forward global` to remove global config.

    Subscriptions with independent rules are not changed by later
    `/set_forward` or `/del_forward` commands. Restore inheritance in that
    subscription's menu before it follows the default again.

*   **Per-subscription message forwarding (menu)**:
    Open `/menu`, choose **Message Forwarding**, then choose a subscription.
    Each subscription can have up to 10 independently removable target
    chats/topics, can keep or suppress its source delivery, and can return to
    the current topic/global default rule. **Source only (stop inheriting)**
    explicitly excludes the inherited default target for that subscription.

    A normal first customization starts from the subscription's effective
    legacy default route before applying the new target, preserving the old
    target and `only_forward` behavior. Choosing **Source only** intentionally
    stops inheritance and excludes that default target. The bot refuses to
    disable source delivery without a target, or to remove the final target
    while source delivery is disabled. Changes affect only future enqueueing;
    existing outbox deliveries are unchanged.

*   **Copy Subscriptions (not message forwarding)**:
    Allows copying subscriptions from the current chat to another chat.
    ```text
    /forward_to <target_chat_id> [target_thread_id]
    ```
    Large subscription lists are paginated; the source and copied subscriptions
    are managed independently afterward.

*   **Get Chat Info**:
    ```text
    /id
    ```
    *Returns the current Chat ID and Thread ID.*

*   **Help**:
    ```text
    /help
    ```

## Architecture and State

- `index.js`: Worker composition root for HTTP/webhook validation, update deduplication, and scheduled events.
- `src/commands.js`: command parsing, authorization, subscription management, forwarding configuration, and callback sessions.
- `src/poller.js`: feed rotation, seen-item detection, forward-target resolution, outbox enqueueing, and bounded delivery draining.
- `src/feeds.js`: URL validation, bounded HTTP fetches, RSS/Atom parsing, RSSHub URL construction, and item fingerprints.
- `src/telegram.js`: HTML-safe rendering and structured Telegram API results without in-request sleeping.
- `src/storage.js`: parameterized D1 access, legacy migration, webhook claims, delivery state, and retention cleanup.

### Storage ownership

- **D1 (`SQL`)** owns `subscriptions`, `subscription_routing_settings`, `subscription_forward_targets`, `processed_updates`, `operational_leases`, and `deliveries`. Per-subscription rules and targets are linked to stable subscription IDs. Each item/final-target pair has its own outbox row, so partial Telegram failures can be retried independently.
- **KV (`DB`)** stores bounded per-feed seen history, legacy chat/topic default forwarding configuration, short-lived menu/input/copy sessions, and the polling cursor.
- A legacy KV `subscriptions` array is copied into D1 automatically on the first invocation after migrations are applied. The import and migration marker are committed together, and the old KV value is intentionally retained for rollback/audit; remove it manually only after verifying D1.
- Delivery is at-least-once: if the Worker crashes after Telegram accepts a message but before D1 records it as sent, a later retry can deliver that message again.

### Runtime flow

1. Telegram sends an authenticated webhook. `index.js` claims its `update_id` in D1, then delegates the command or callback.
2. Every 15 minutes, the scheduled handler acquires the D1 operational lease, rotates feed order, and fetches up to `MAX_FEEDS_PER_RUN` feeds before advancing the cursor by the selected count.
3. The poller drains up to `MAX_TELEGRAM_SENDS_PER_RUN` due deliveries. Successful targets are marked sent; retryable errors use persisted backoff until `MAX_DELIVERY_ATTEMPTS`, permanent or exhausted failures become dead rows, and a Telegram 429 stops the current drain.

## License

ISC
