import {
  acquireOperationalLease,
  enqueueDeliveries,
  ensureLegacySubscriptionsMigrated,
  listPendingDeliveries,
  listSubscriptions,
  markDeliveryRetry,
  markDeliverySent,
  pruneOperationalState,
  releaseOperationalLease
} from './storage.js';
import {
  buildItemFingerprint,
  fetchFeed,
  normalizeUrlForDedup,
  simpleHash
} from './feeds.js';
import { renderFeedMessage, sendTelegramMessage } from './telegram.js';

const POLL_CURSOR_KEY = 'poll_cursor';
const SENT_HISTORY_PREFIX = 'sent_guids:';
const POLL_RUN_LEASE_NAME = 'rss-poller';
const POLL_RUN_LEASE_SECONDS = 20 * 60;
const INITIAL_RETRY_DELAY_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 60 * 60;

const DEFAULT_DEPENDENCIES = Object.freeze({
  ensureLegacySubscriptionsMigrated,
  acquireOperationalLease,
  listSubscriptions,
  fetchFeed,
  buildItemFingerprint,
  normalizeUrlForDedup,
  simpleHash,
  renderFeedMessage,
  enqueueDeliveries,
  listPendingDeliveries,
  sendTelegramMessage,
  markDeliverySent,
  markDeliveryRetry,
  pruneOperationalState,
  releaseOperationalLease,
  createRunLeaseToken,
  hashFeedUrl: sha256Hex,
  hashItemIdentity: sha256Hex,
  fetchFn: globalThis.fetch,
  logger: console
});

/**
 * Poll distinct feeds, persist one delivery per resolved Telegram target, then
 * drain a bounded portion of the durable delivery queue.
 */
export async function runScheduled(env, config, overrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  validateInputs(env, config, dependencies);

  const stats = createStats();
  const leaseToken = dependencies.createRunLeaseToken();
  const acquired = await dependencies.acquireOperationalLease(
    env,
    POLL_RUN_LEASE_NAME,
    {
      leaseToken,
      leaseSeconds: POLL_RUN_LEASE_SECONDS
    }
  );
  if (!acquired) {
    stats.skipped = true;
    stats.skipReason = 'lease-held';
    return stats;
  }

  try {
    stats.migratedSubscriptions = await dependencies.ensureLegacySubscriptionsMigrated(env);

    const subscriptions = await dependencies.listSubscriptions(env);
    stats.subscriptions = subscriptions.length;
    const groupedFeeds = groupSubscriptionsByUrl(subscriptions);
    stats.feeds = groupedFeeds.length;

    const { feeds: orderedFeeds, startIndex } = await rotateFeeds(env.DB, groupedFeeds);
    const maxFeedsPerRun = positiveInteger(
      config.maxFeedsPerRun,
      'config.maxFeedsPerRun'
    );
    const selectedFeeds = orderedFeeds.slice(0, maxFeedsPerRun);
    stats.feedsSelected = selectedFeeds.length;
    const forwardConfigCache = new Map();

    for (const [rssUrl, subscribers] of selectedFeeds) {
      try {
        await pollFeed({
          env,
          config,
          dependencies,
          stats,
          rssUrl,
          subscribers,
          forwardConfigCache
        });
        stats.feedsSucceeded += 1;
      } catch (error) {
        stats.feedsFailed += 1;
        recordError(stats, dependencies.logger, 'feed', error, rssUrl);
      }
    }

    await advancePollCursor(
      env.DB,
      groupedFeeds.length,
      startIndex,
      selectedFeeds.length
    );
    await drainDeliveryQueue(env, config, dependencies, stats);

    try {
      const cleanup = await dependencies.pruneOperationalState(env);
      stats.prunedOperationalRows = Number(cleanup?.total) || 0;
    } catch (error) {
      recordError(stats, dependencies.logger, 'cleanup', error, null);
    }

    return stats;
  } finally {
    try {
      const released = await dependencies.releaseOperationalLease(
        env,
        POLL_RUN_LEASE_NAME,
        { leaseToken }
      );
      if (!released) {
        recordError(
          stats,
          dependencies.logger,
          'lease-release',
          new Error('Scheduled run lease ownership was lost'),
          null
        );
      }
    } catch (error) {
      recordError(stats, dependencies.logger, 'lease-release', error, null);
    }
  }
}

async function pollFeed({
  env,
  config,
  dependencies,
  stats,
  rssUrl,
  subscribers,
  forwardConfigCache
}) {
  const feedKey = await dependencies.hashFeedUrl(rssUrl);
  const sentKey = `${SENT_HISTORY_PREFIX}${feedKey}`;
  const history = await loadSentHistory(env.DB, sentKey, dependencies.logger);
  const feed = await dependencies.fetchFeed(rssUrl, {
    fetchFn: dependencies.fetchFn,
    ...(config.allowedFeedHosts?.size > 0
      ? { allowedHosts: config.allowedFeedHosts }
      : {}),
    timeoutMs: config.feedTimeoutMs,
    maxBytes: config.maxFeedBytes,
    maxItems: config.maxItemsPerFeed
  });
  const uniqueSubscribers = deduplicateSubscribers(subscribers);
  const targets = await resolveTargets(
    env.DB,
    uniqueSubscribers,
    forwardConfigCache,
    dependencies.logger
  );
  const sourceName = chooseSafeSourceName(
    uniqueSubscribers[0]?.channelName,
    feed?.title,
    rssUrl
  );
  let historyChanged = false;

  for (const item of Array.isArray(feed?.items) ? feed.items : []) {
    stats.itemsChecked += 1;
    try {
      const identity = await buildIdentity(item, dependencies);
      if (!identity || hasSeenIdentity(history, identity) || targets.length === 0) {
        continue;
      }

      stats.itemsNew += 1;
      const message = dependencies.renderFeedMessage(item, sourceName);
      const inserted = await dependencies.enqueueDeliveries(env, {
        feedKey,
        itemKey: identity.canonicalKey,
        message,
        targets
      });
      stats.deliveriesEnqueued += inserted;

      // D1 uniqueness makes this safe if an earlier run enqueued the item but
      // crashed before updating the KV history.
      for (const alias of identity.persistedAliases) {
        history.add(alias);
      }
      historyChanged = true;
    } catch (error) {
      stats.itemsFailed += 1;
      recordError(stats, dependencies.logger, 'item', error, rssUrl);
    }
  }

  if (historyChanged) {
    const limit = positiveInteger(config.sentHistoryLimit, 'config.sentHistoryLimit');
    await env.DB.put(sentKey, JSON.stringify(Array.from(history).slice(-limit)));
  }
}

async function drainDeliveryQueue(env, config, dependencies, stats) {
  const limit = positiveInteger(
    config.maxTelegramSendsPerRun,
    'config.maxTelegramSendsPerRun'
  );
  const maxAttempts = positiveInteger(
    config.maxDeliveryAttempts,
    'config.maxDeliveryAttempts'
  );
  const deliveries = await dependencies.listPendingDeliveries(env, limit);

  for (const delivery of deliveries) {
    stats.deliveriesProcessed += 1;
    let result;
    try {
      result = await dependencies.sendTelegramMessage(
        config.telegramBotToken,
        delivery.chatId,
        delivery.threadId,
        delivery.message,
        null,
        { fetchFn: dependencies.fetchFn }
      );
    } catch (error) {
      result = {
        ok: false,
        status: 0,
        retryable: true,
        permanent: false,
        retryAfterSeconds: 0,
        error: errorMessage(error)
      };
    }

    if (result?.ok) {
      await dependencies.markDeliverySent(env, delivery.id);
      stats.deliveriesSent += 1;
      continue;
    }

    const attemptsAfterFailure = Math.max(0, Number(delivery.attempts) || 0) + 1;
    const exhausted =
      Boolean(result?.retryable) &&
      !Boolean(result?.permanent) &&
      attemptsAfterFailure >= maxAttempts;
    const permanent =
      Boolean(result?.permanent) ||
      !Boolean(result?.retryable) ||
      exhausted;
    const retryAfterSeconds = permanent
      ? 0
      : positiveRetryDelay(result?.retryAfterSeconds, delivery.attempts);
    const baseError =
      result?.error ||
      `Telegram delivery failed with status ${Number(result?.status) || 0}`;
    await dependencies.markDeliveryRetry(env, delivery.id, {
      error: exhausted
        ? `${baseError} (delivery attempts exhausted at ${maxAttempts})`
        : baseError,
      retryAfterSeconds,
      permanent
    });

    if (permanent) {
      stats.deliveriesDead += 1;
    } else {
      stats.deliveriesRetried += 1;
    }

    if (Number(result?.status) === 429) {
      stats.rateLimited = true;
      break;
    }
  }
}

async function buildIdentity(item, dependencies) {
  const canonicalMaterial = buildCanonicalIdentityMaterial(
    item,
    dependencies.normalizeUrlForDedup
  );
  if (!canonicalMaterial) {
    return null;
  }

  const canonicalDigest = String(
    await dependencies.hashItemIdentity(canonicalMaterial)
  ).trim();
  if (!canonicalDigest) {
    throw new Error("Canonical item identity hash must not be empty");
  }

  const fingerprint = dependencies.buildItemFingerprint(item);
  const id = String(item?.guid ?? item?.id ?? "").trim();
  const link = String(item?.link ?? "").trim();
  const normalizedLink = dependencies.normalizeUrlForDedup(link);
  const legacyFingerprint = buildLegacyFingerprint(item, dependencies.simpleHash);
  const canonicalKey = `sha256:${canonicalDigest}`;
  const aliases = new Set([canonicalKey]);
  const persistedAliases = new Set();

  // Read former 32-bit identities for migration compatibility, but never
  // persist them for new items or use them as D1 delivery uniqueness keys.
  if (fingerprint) {
    aliases.add(`fp:${fingerprint}`);
  }
  if (legacyFingerprint) {
    aliases.add(`fp:${legacyFingerprint}`);
  }
  if (id) {
    aliases.add(id);
    aliases.add(`id:${id}`);
    persistedAliases.add(`id:${id}`);
  }
  if (link) {
    aliases.add(link);
    aliases.add(`link:${link}`);
  }
  if (normalizedLink) {
    aliases.add(normalizedLink);
    aliases.add(`link:${normalizedLink}`);
    persistedAliases.add(`link:${normalizedLink}`);
  }

  // Keep the canonical key last so a tight history cap retains the strongest
  // current identity after stable link and GUID aliases.
  persistedAliases.add(canonicalKey);
  return { canonicalKey, aliases, persistedAliases };
}

function buildCanonicalIdentityMaterial(item, normalizeUrl) {
  const guid = normalizeCanonicalText(item?.guid ?? item?.id);
  if (guid) {
    return `guid:${guid}`;
  }

  const link = normalizeUrl(item?.link);
  if (link) {
    return `link:${link}`;
  }

  const title = normalizeCanonicalText(item?.title).toLowerCase();
  const pubDate = normalizeCanonicalText(item?.pubDate).toLowerCase();
  return title || pubDate ? `fallback:${title}|${pubDate}` : "";
}

function normalizeCanonicalText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function hasSeenIdentity(history, identity) {
  for (const alias of identity.aliases) {
    if (history.has(alias)) {
      return true;
    }
  }
  return false;
}

// Mirrors the fingerprint from the original monolithic Worker so existing
// `fp:*` KV values remain useful after the migration.
function buildLegacyFingerprint(item, hash) {
  const title = String(item?.title ?? '').trim().toLowerCase();
  const id = String(item?.id ?? item?.guid ?? '').trim().toLowerCase();
  const normalizedLink = normalizeLegacyUrl(item?.link);
  const pubDate = String(item?.pubDate ?? '').trim().toLowerCase();
  if (!title && !id && !normalizedLink && !pubDate) {
    return '';
  }
  const base = title || normalizedLink
    ? `${title}|${normalizedLink}`
    : `${id}|${pubDate}`;
  return hash(base);
}

function normalizeLegacyUrl(rawUrl) {
  const value = String(rawUrl ?? '').trim();
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value);
    const droppedParameters = new Set([
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'utm_name',
      'utm_id',
      'fbclid',
      'gclid',
      'igshid',
      'spm',
      'from'
    ]);
    for (const key of [...url.searchParams.keys()]) {
      if (droppedParameters.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.hash = '';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const query = url.searchParams.toString();
    return `${url.origin.toLowerCase()}${path}${query ? `?${query}` : ''}`;
  } catch {
    return value.toLowerCase();
  }
}

function groupSubscriptionsByUrl(subscriptions) {
  const grouped = new Map();
  for (const subscription of subscriptions) {
    const rssUrl = String(subscription?.rssUrl ?? '').trim();
    if (!rssUrl) {
      continue;
    }
    if (!grouped.has(rssUrl)) {
      grouped.set(rssUrl, []);
    }
    grouped.get(rssUrl).push(subscription);
  }
  return [...grouped.entries()];
}

function deduplicateSubscribers(subscribers) {
  const unique = new Map();
  for (const subscription of subscribers) {
    const chatId = String(subscription?.chatId ?? '').trim();
    const threadId = normalizeThreadId(subscription?.threadId);
    if (!chatId) {
      continue;
    }
    const key = `${chatId}\u0000${threadId ?? ''}`;
    if (!unique.has(key)) {
      unique.set(key, { ...subscription, chatId, threadId });
    }
  }
  return [...unique.values()];
}

async function resolveTargets(kv, subscribers, cache, logger) {
  const targets = new Map();
  for (const subscription of subscribers) {
    const originalTarget = {
      chatId: subscription.chatId,
      threadId: subscription.threadId
    };
    const hasThread = subscription.threadId !== null;
    let forwardConfig = null;

    if (hasThread) {
      const topicKey = `forward_config:${subscription.chatId}:${subscription.threadId}`;
      forwardConfig = normalizeForwardConfig(
        await readForwardConfig(kv, topicKey, cache, logger)
      );
    }

    if (!forwardConfig) {
      const globalKey = `forward_config:${subscription.chatId}`;
      const candidate = normalizeForwardConfig(
        await readForwardConfig(kv, globalKey, cache, logger)
      );
      if (candidate && (!hasThread || candidate.isGlobal)) {
        forwardConfig = candidate;
      }
    }

    if (forwardConfig) {
      addUniqueTarget(targets, {
        chatId: forwardConfig.targetChatId,
        threadId: forwardConfig.targetThreadId
      });
      if (!forwardConfig.onlyForward) {
        addUniqueTarget(targets, originalTarget);
      }
    } else {
      addUniqueTarget(targets, originalTarget);
    }
  }
  return [...targets.values()];
}

async function readForwardConfig(kv, key, cache, logger) {
  if (cache.has(key)) {
    return cache.get(key);
  }
  const raw = await kv.get(key);
  if (!raw) {
    cache.set(key, null);
    return null;
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    cache.set(key, parsed);
    return parsed;
  } catch (error) {
    log(logger, 'warn', `Ignoring invalid forwarding config at ${key}: ${errorMessage(error)}`);
    cache.set(key, null);
    return null;
  }
}

function normalizeForwardConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const targetChatId = String(value.targetChatId ?? value.target_chat_id ?? '').trim();
  if (!targetChatId) {
    return null;
  }
  return {
    targetChatId,
    targetThreadId: normalizeThreadId(value.targetThreadId ?? value.target_thread_id),
    onlyForward: value.onlyForward === true,
    isGlobal: value.isGlobal === true
  };
}

function addUniqueTarget(targets, target) {
  const chatId = String(target?.chatId ?? '').trim();
  if (!chatId) {
    return;
  }
  const threadId = normalizeThreadId(target?.threadId);
  const key = `${chatId}\u0000${threadId ?? ''}`;
  if (!targets.has(key)) {
    targets.set(key, { chatId, threadId });
  }
}

function normalizeThreadId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

async function loadSentHistory(kv, key, logger) {
  const raw = await kv.get(key);
  if (!raw) {
    return new Set();
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) {
      throw new TypeError('history must be an array');
    }
    return new Set(parsed.map((entry) => String(entry)).filter(Boolean));
  } catch (error) {
    log(logger, 'warn', `Ignoring invalid sent history at ${key}: ${errorMessage(error)}`);
    return new Set();
  }
}

async function rotateFeeds(kv, groupedFeeds) {
  if (groupedFeeds.length === 0) {
    return { feeds: [], startIndex: 0 };
  }
  const rawCursor = await kv.get(POLL_CURSOR_KEY);
  const parsedCursor = Number.parseInt(String(rawCursor ?? '0'), 10);
  const startIndex = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0
    ? parsedCursor % groupedFeeds.length
    : 0;
  return {
    feeds: [...groupedFeeds.slice(startIndex), ...groupedFeeds.slice(0, startIndex)],
    startIndex
  };
}

async function advancePollCursor(kv, feedCount, startIndex, selectedCount) {
  if (feedCount > 0 && selectedCount > 0) {
    await kv.put(
      POLL_CURSOR_KEY,
      String((startIndex + Math.min(selectedCount, feedCount)) % feedCount)
    );
  }
}

function positiveRetryDelay(retryAfterSeconds, attempts) {
  const explicitDelay = Number(retryAfterSeconds);
  if (Number.isFinite(explicitDelay) && explicitDelay > 0) {
    return Math.ceil(explicitDelay);
  }
  const exponent = Math.min(10, Math.max(0, Number(attempts) || 0));
  return Math.min(
    MAX_RETRY_DELAY_SECONDS,
    INITIAL_RETRY_DELAY_SECONDS * (2 ** exponent)
  );
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}

function validateInputs(env, config, dependencies) {
  if (!env?.DB || typeof env.DB.get !== 'function' || typeof env.DB.put !== 'function') {
    throw new TypeError('env.DB KV binding is required');
  }
  if (!config || typeof config !== 'object') {
    throw new TypeError('config is required');
  }
  if (!String(config.telegramBotToken ?? '').trim()) {
    throw new TypeError('config.telegramBotToken is required');
  }
  const requiredFunctions = [
    'acquireOperationalLease',
    'releaseOperationalLease',
    'createRunLeaseToken',
    'ensureLegacySubscriptionsMigrated',
    'listSubscriptions',
    'fetchFeed',
    'buildItemFingerprint',
    'normalizeUrlForDedup',
    'simpleHash',
    'renderFeedMessage',
    'enqueueDeliveries',
    'listPendingDeliveries',
    'sendTelegramMessage',
    'markDeliverySent',
    'markDeliveryRetry',
    'pruneOperationalState',
    "hashFeedUrl",
    "hashItemIdentity"
  ];
  for (const name of requiredFunctions) {
    if (typeof dependencies[name] !== 'function') {
      throw new TypeError(`${name} dependency must be a function`);
    }
  }
}

function createStats() {
  return {
    migratedSubscriptions: 0,
    subscriptions: 0,
    feeds: 0,
    feedsSelected: 0,
    feedsSucceeded: 0,
    feedsFailed: 0,
    itemsChecked: 0,
    itemsNew: 0,
    itemsFailed: 0,
    deliveriesEnqueued: 0,
    deliveriesProcessed: 0,
    deliveriesSent: 0,
    deliveriesRetried: 0,
    deliveriesDead: 0,
    prunedOperationalRows: 0,
    rateLimited: false,
    skipped: false,
    skipReason: null,
    errors: []
  };
}

function recordError(stats, logger, stage, error, rssUrl) {
  const safeRssUrl = safeFeedLabel(rssUrl);
  const rawRssUrl = rssUrl === null || rssUrl === undefined
    ? ''
    : String(rssUrl);
  let message = errorMessage(error);
  if (rawRssUrl && message.includes(rawRssUrl)) {
    message = message.split(rawRssUrl).join(safeRssUrl);
  }
  message = message.slice(0, 1_000);
  stats.errors.push({ stage, rssUrl: safeRssUrl, message });
  log(
    logger,
    'error',
    `${stage} failure for ${safeRssUrl ?? 'scheduled task'}: ${message}`
  );
}

function chooseSafeSourceName(subscriptionName, feedTitle, rssUrl) {
  const configuredName = String(subscriptionName ?? "").trim();
  if (isSafeSourceName(configuredName, rssUrl)) {
    return configuredName;
  }

  const parsedTitle = String(feedTitle ?? "").trim();
  if (isSafeSourceName(parsedTitle, rssUrl)) {
    return parsedTitle;
  }

  return safeFeedHostname(rssUrl);
}

function isSafeSourceName(value, rssUrl) {
  if (!value || value === String(rssUrl ?? "").trim()) {
    return false;
  }
  return !value.includes("/") &&
    !value.includes("\\") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

function safeFeedHostname(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) {
      return url.hostname.slice(0, 253);
    }
  } catch {
    // Fall through to a fixed label that cannot contain user-controlled data.
  }
  return "RSS feed";
}

function safeFeedLabel(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value) {
    return "[no-feed-url]";
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "[invalid-feed-url]";
    }
    return url.origin.slice(0, 300);
  } catch {
    return "[invalid-feed-url]";
  }
}

function log(logger, level, message) {
  const method = logger?.[level];
  if (typeof method === 'function') {
    method.call(logger, message);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createRunLeaseToken() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Web Crypto randomUUID is required');
  }
  return globalThis.crypto.randomUUID();
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto is required to hash feed URLs');
  }
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
