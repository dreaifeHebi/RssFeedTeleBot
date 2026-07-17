const DEFAULTS = Object.freeze({
  feedTimeoutMs: 10_000,
  maxFeedBytes: 1_048_576,
  maxItemsPerFeed: 20,
  maxFeedsPerRun: 3,
  maxTelegramSendsPerRun: 35,
  maxDeliveryAttempts: 10,
  sentHistoryLimit: 2_000
});

function requireString(env, key) {
  const value = String(env?.[key] ?? '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseBoundedInteger(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseCsv(value, normalizer = (entry) => entry) {
  return new Set(
    String(value ?? '')
      .split(',')
      .map((entry) => normalizer(entry.trim()))
      .filter(Boolean)
  );
}

export function loadConfig(env) {
  const telegramBotToken = requireString(env, 'TELEGRAM_BOT_TOKEN');
  const webhookSecret = requireString(env, 'TELEGRAM_WEBHOOK_SECRET');

  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must contain only A-Z, a-z, 0-9, _ or - and be at most 256 characters');
  }
  if (!env?.DB || typeof env.DB.get !== 'function' || typeof env.DB.put !== 'function') {
    throw new Error('Missing required KV binding: DB');
  }
  if (!env?.SQL || typeof env.SQL.prepare !== 'function') {
    throw new Error('Missing required D1 binding: SQL');
  }

  return Object.freeze({
    telegramBotToken,
    webhookSecret,
    rssBaseUrl: String(env.RSS_BASE_URL ?? '').trim(),
    botUsername: String(env.TELEGRAM_BOT_USERNAME ?? '').trim().replace(/^@/, '').toLowerCase(),
    adminUserIds: parseCsv(env.ADMIN_USER_IDS, (entry) => entry),
    allowedFeedHosts: parseCsv(env.ALLOWED_FEED_HOSTS, (entry) => entry.toLowerCase()),
    feedTimeoutMs: parseBoundedInteger(env.FEED_TIMEOUT_MS, DEFAULTS.feedTimeoutMs, 1_000, 30_000),
    maxFeedBytes: parseBoundedInteger(env.MAX_FEED_BYTES, DEFAULTS.maxFeedBytes, 65_536, 5_242_880),
    maxItemsPerFeed: parseBoundedInteger(env.MAX_ITEMS_PER_FEED, DEFAULTS.maxItemsPerFeed, 1, 100),
    maxFeedsPerRun: parseBoundedInteger(env.MAX_FEEDS_PER_RUN, DEFAULTS.maxFeedsPerRun, 1, 100),
    maxTelegramSendsPerRun: parseBoundedInteger(
      env.MAX_TELEGRAM_SENDS_PER_RUN,
      DEFAULTS.maxTelegramSendsPerRun,
      1,
      100
    ),
    maxDeliveryAttempts: parseBoundedInteger(env.MAX_DELIVERY_ATTEMPTS, DEFAULTS.maxDeliveryAttempts, 1, 100),
    sentHistoryLimit: parseBoundedInteger(env.SENT_HISTORY_LIMIT, DEFAULTS.sentHistoryLimit, 100, 10_000)
  });
}

export { DEFAULTS };
