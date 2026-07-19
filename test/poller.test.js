import assert from 'node:assert/strict';
import test from 'node:test';

import { simpleHash } from '../src/feeds.js';
import { runScheduled } from "../src/poller.js";

async function sha256HexForTest(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

class FakeKv {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.gets = [];
    this.puts = [];
  }

  async get(key) {
    this.gets.push(key);
    return this.values.has(key) ? this.values.get(key) : null;
  }

  async put(key, value) {
    this.puts.push([key, value]);
    this.values.set(key, value);
  }
}

const BASE_CONFIG = Object.freeze({
  telegramBotToken: 'telegram-token',
  allowedFeedHosts: new Set(),
  feedTimeoutMs: 1_000,
  maxFeedBytes: 100_000,
  maxItemsPerFeed: 10,
  maxFeedsPerRun: 3,
  maxTelegramSendsPerRun: 5,
  maxDeliveryAttempts: 10,
  sentHistoryLimit: 100
});

const QUIET_LOGGER = Object.freeze({
  error() {},
  warn() {}
});

function baseDependencies(overrides = {}) {
  return {
    acquireOperationalLease: async () => true,
    releaseOperationalLease: async () => true,
    createRunLeaseToken: () => 'test-run-lease',
    ensureLegacySubscriptionsMigrated: async () => 0,
    listSubscriptions: async () => [],
    fetchFeed: async () => ({ title: '', items: [] }),
    enqueueDeliveries: async () => 0,
    listPendingDeliveries: async () => [],
    sendTelegramMessage: async () => ({ ok: true }),
    markDeliverySent: async () => true,
    markDeliveryRetry: async () => true,
    pruneOperationalState: async () => ({ total: 0 }),
    hashFeedUrl: async (url) => `hash-${url.at(-1)}`,
    logger: QUIET_LOGGER,
    ...overrides
  };
}

test('migrates, rotates feeds, resolves forwarding, enqueues every target, then drains', async () => {
  const DB = new FakeKv({
    poll_cursor: '1',
    'sent_guids:hash-b': JSON.stringify(['legacy-1', 'legacy-2']),
    'forward_config:100': JSON.stringify({
      targetChatId: '-800',
      onlyForward: true,
      isGlobal: true
    }),
    'forward_config:200:7': JSON.stringify({
      targetChatId: '-900',
      targetThreadId: '12',
      onlyForward: false,
      isGlobal: false
    }),
    // A non-global main-thread config must not leak into topic 8.
    'forward_config:201': JSON.stringify({
      targetChatId: '-901',
      onlyForward: true,
      isGlobal: false
    })
  });
  const subscriptions = [
    { rssUrl: 'https://feeds.test/a', channelName: 'A', chatId: '100', threadId: null },
    { rssUrl: 'https://feeds.test/b', channelName: 'B', chatId: '200', threadId: '7' },
    { rssUrl: 'https://feeds.test/b', channelName: 'duplicate', chatId: '200', threadId: '7' },
    { rssUrl: 'https://feeds.test/b', channelName: 'B', chatId: '201', threadId: '8' }
  ];
  const fetchOrder = [];
  const enqueued = [];
  const sent = [];
  const markedSent = [];

  const stats = await runScheduled(
    { DB },
    { ...BASE_CONFIG, maxTelegramSendsPerRun: 1, sentHistoryLimit: 2 },
    baseDependencies({
      ensureLegacySubscriptionsMigrated: async () => 3,
      listSubscriptions: async () => subscriptions,
      fetchFeed: async (url, options) => {
        fetchOrder.push([url, options]);
        const suffix = url.at(-1);
        return {
          title: `Feed ${suffix}`,
          items: [{ title: `Item ${suffix}`, guid: `${suffix}-1`, link: `${url}/1` }]
        };
      },
      enqueueDeliveries: async (_env, payload) => {
        enqueued.push(payload);
        return payload.targets.length;
      },
      listPendingDeliveries: async (_env, limit) => {
        assert.equal(limit, 1);
        assert.equal(enqueued.length, 2, 'all targets are durable before queue draining starts');
        return [{ id: 70, chatId: '-900', threadId: '12', message: 'queued', attempts: 0 }];
      },
      sendTelegramMessage: async (...args) => {
        sent.push(args);
        return { ok: true, status: 200, retryable: false, permanent: false };
      },
      markDeliverySent: async (_env, id) => {
        markedSent.push(id);
        return true;
      }
    })
  );

  assert.deepEqual(fetchOrder.map(([url]) => url), [
    'https://feeds.test/b',
    'https://feeds.test/a'
  ]);
  assert.deepEqual(fetchOrder[0][1], {
    fetchFn: globalThis.fetch,
    timeoutMs: 1_000,
    maxBytes: 100_000,
    maxItems: 10
  });

  assert.deepEqual(enqueued[0].targets, [
    { chatId: '-900', threadId: '12' },
    { chatId: '200', threadId: '7' },
    { chatId: '201', threadId: '8' }
  ]);
  assert.deepEqual(enqueued[1].targets, [
    { chatId: '-800', threadId: null }
  ]);
  assert.match(enqueued[0].itemKey, /^sha256:[0-9a-f]{64}$/);
  assert.match(enqueued[0].message, /<b>Source:<\/b> B/);
  assert.deepEqual(markedSent, [70]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'telegram-token');

  assert.equal(DB.values.get('poll_cursor'), '1');
  const historyB = JSON.parse(DB.values.get('sent_guids:hash-b'));
  assert.equal(historyB.length, 2);
  assert.equal(historyB[0], 'link:https://feeds.test/b/1');
  assert.match(historyB[1], /^sha256:[0-9a-f]{64}$/);

  assert.deepEqual(
    {
      migrated: stats.migratedSubscriptions,
      feeds: stats.feeds,
      selected: stats.feedsSelected,
      succeeded: stats.feedsSucceeded,
      checked: stats.itemsChecked,
      itemsNew: stats.itemsNew,
      enqueued: stats.deliveriesEnqueued,
      processed: stats.deliveriesProcessed,
      sent: stats.deliveriesSent
    },
    {
      migrated: 3,
      feeds: 2,
      selected: 2,
      succeeded: 2,
      checked: 2,
      itemsNew: 2,
      enqueued: 4,
      processed: 1,
      sent: 1
    }
  );
});

test('independent subscription routing overrides legacy KV per subscription', async () => {
  const DB = new FakeKv({
    'forward_config:100': JSON.stringify({
      targetChatId: '-999',
      onlyForward: true,
      isGlobal: true
    }),
    'forward_config:200': JSON.stringify({
      targetChatId: '-600',
      onlyForward: false,
      isGlobal: false
    })
  });
  const subscriptions = [
    {
      id: 1,
      rssUrl: 'https://feeds.test/x',
      channelName: 'X',
      chatId: '100',
      threadId: null,
      routing: {
        includeSource: false,
        targets: [
          { id: 21, chatId: '-500', threadId: null },
          { id: 22, chatId: '-501', threadId: '7' }
        ]
      }
    },
    {
      id: 2,
      rssUrl: 'https://feeds.test/x',
      channelName: 'X',
      chatId: '200',
      threadId: null,
      routing: null
    }
  ];
  const enqueued = [];

  await runScheduled(
    { DB },
    BASE_CONFIG,
    baseDependencies({
      listSubscriptions: async () => subscriptions,
      fetchFeed: async () => ({
        title: 'Independent',
        items: [{
          title: 'New item',
          guid: 'new-item',
          link: 'https://feeds.test/x/1'
        }]
      }),
      enqueueDeliveries: async (_env, payload) => {
        enqueued.push(payload);
        return payload.targets.length;
      }
    })
  );

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0].targets, [
    { chatId: '-500', threadId: null },
    { chatId: '-501', threadId: '7' },
    { chatId: '-600', threadId: null },
    { chatId: '200', threadId: null }
  ]);
  assert.equal(DB.gets.includes('forward_config:100'), false);
  assert.equal(DB.gets.includes('forward_config:200'), true);
});

test('empty independent routing safely falls back to the source target', async () => {
  const DB = new FakeKv();
  const enqueued = [];
  const warnings = [];
  await runScheduled(
    { DB },
    BASE_CONFIG,
    baseDependencies({
      listSubscriptions: async () => [{
        id: 3,
        rssUrl: 'https://feeds.test/y',
        channelName: 'Y',
        chatId: '300',
        threadId: '4',
        routing: { includeSource: false, targets: [] }
      }],
      fetchFeed: async () => ({
        title: 'Fallback',
        items: [{ title: 'New', guid: 'new', link: 'https://feeds.test/y/1' }]
      }),
      enqueueDeliveries: async (_env, payload) => {
        enqueued.push(payload);
        return payload.targets.length;
      },
      logger: { error() {}, warn(message) { warnings.push(message); } }
    })
  );

  assert.deepEqual(enqueued[0].targets, [{ chatId: '300', threadId: '4' }]);
  assert.match(warnings[0], /Falling back to source.*#3/);
});

test('recognizes the original Worker fingerprint and does not enqueue a duplicate', async () => {
  const item = {
    title: 'Hello',
    id: 'volatile-id',
    link: 'https://Example.com/path/?utm_source=x&b=2&a=1#fragment',
    pubDate: 'Today'
  };
  const legacyUrl = 'https://example.com/path?b=2&a=1';
  const legacyFingerprint = simpleHash(`hello|${legacyUrl}`);
  const DB = new FakeKv({
    'sent_guids:feed': JSON.stringify([`fp:${legacyFingerprint}`])
  });
  let enqueueCalls = 0;

  const stats = await runScheduled(
    { DB },
    BASE_CONFIG,
    baseDependencies({
      listSubscriptions: async () => [
        { rssUrl: 'https://feeds.test/legacy', channelName: 'Legacy', chatId: '1', threadId: null }
      ],
      hashFeedUrl: async () => 'feed',
      fetchFeed: async () => ({ title: 'Legacy', items: [item] }),
      enqueueDeliveries: async () => {
        enqueueCalls += 1;
        return 1;
      }
    })
  );

  assert.equal(enqueueCalls, 0);
  assert.equal(stats.itemsChecked, 1);
  assert.equal(stats.itemsNew, 0);
  assert.equal(
    DB.puts.some(([key]) => key === 'sent_guids:feed'),
    false,
    'seen items do not rewrite history'
  );
});

test("uses distinct SHA-256 delivery keys when legacy 32-bit fingerprints collide", async () => {
  const DB = new FakeKv();
  const enqueued = [];

  await runScheduled(
    { DB },
    BASE_CONFIG,
    baseDependencies({
      listSubscriptions: async () => [
        {
          rssUrl: "https://feeds.test/collision",
          channelName: "Collision",
          chatId: "1",
          threadId: null
        }
      ],
      hashFeedUrl: async () => "collision-feed",
      buildItemFingerprint: () => "same-32-bit-value",
      fetchFeed: async () => ({
        title: "Collision",
        items: [
          { title: "One", guid: "guid-one", link: "https://items.test/one" },
          { title: "Two", guid: "guid-two", link: "https://items.test/two" }
        ]
      }),
      enqueueDeliveries: async (_env, payload) => {
        enqueued.push(payload);
        return 1;
      }
    })
  );

  assert.equal(enqueued.length, 2);
  assert.match(enqueued[0].itemKey, /^sha256:[0-9a-f]{64}$/);
  assert.match(enqueued[1].itemKey, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(enqueued[0].itemKey, enqueued[1].itemKey);
  assert.equal(
    JSON.parse(DB.values.get("sent_guids:collision-feed"))
      .includes("fp:same-32-bit-value"),
    false,
    "legacy 32-bit fingerprints are read-only history aliases"
  );
});

test('isolates one feed failure and still drains deliveries', async () => {
  const DB = new FakeKv();
  const fetched = [];
  const sent = [];
  const marked = [];
  const subscriptions = [
    { rssUrl: 'https://feeds.test/bad', channelName: 'Bad', chatId: '1', threadId: null },
    { rssUrl: 'https://feeds.test/good', channelName: 'Good', chatId: '2', threadId: null }
  ];

  const stats = await runScheduled(
    { DB },
    BASE_CONFIG,
    baseDependencies({
      listSubscriptions: async () => subscriptions,
      fetchFeed: async (url) => {
        fetched.push(url);
        if (url.endsWith('/bad')) {
          throw new Error('feed unavailable');
        }
        return { title: 'Good', items: [] };
      },
      listPendingDeliveries: async () => [
        { id: 9, chatId: '2', threadId: null, message: 'old pending', attempts: 0 }
      ],
      sendTelegramMessage: async (_token, chatId) => {
        sent.push(chatId);
        return { ok: true, status: 200 };
      },
      markDeliverySent: async (_env, id) => {
        marked.push(id);
        return true;
      }
    })
  );

  assert.deepEqual(fetched, ['https://feeds.test/bad', 'https://feeds.test/good']);
  assert.deepEqual(sent, ['2']);
  assert.deepEqual(marked, [9]);
  assert.equal(stats.feedsFailed, 1);
  assert.equal(stats.feedsSucceeded, 1);
  assert.equal(stats.deliveriesSent, 1);
  assert.deepEqual(stats.errors, [
    { stage: 'feed', rssUrl: 'https://feeds.test', message: 'feed unavailable' }
  ]);
});

test('classifies successful, retryable, permanent, and rate-limited deliveries', async () => {
  const DB = new FakeKv();
  const results = new Map([
    ['m1', { ok: true, status: 200 }],
    ['m2', { ok: false, status: 500, retryable: true, permanent: false, error: 'server' }],
    ['m3', { ok: false, status: 400, retryable: false, permanent: true, error: 'bad chat' }],
    ['m4', {
      ok: false,
      status: 429,
      retryable: true,
      permanent: false,
      retryAfterSeconds: 17,
      error: 'slow down'
    }],
    ['m5', { ok: true, status: 200 }]
  ]);
  const sentMessages = [];
  const markedSent = [];
  const markedRetry = [];
  const logs = [];

  const stats = await runScheduled(
    { DB },
    BASE_CONFIG,
    baseDependencies({
      listPendingDeliveries: async (_env, limit) => {
        assert.equal(limit, 5);
        return [
          { id: 1, chatId: '900000001', threadId: null, message: 'm1', attempts: 0 },
          { id: 2, chatId: '900000002', threadId: null, message: 'm2', attempts: 2 },
          { id: 3, chatId: '900000003', threadId: null, message: 'm3', attempts: 0 },
          { id: 4, chatId: '900000004', threadId: null, message: 'm4', attempts: 4 },
          { id: 5, chatId: '900000005', threadId: null, message: 'm5', attempts: 0 }
        ];
      },
      sendTelegramMessage: async (_token, _chatId, _threadId, message) => {
        sentMessages.push(message);
        return results.get(message);
      },
      markDeliverySent: async (_env, id) => {
        markedSent.push(id);
        return true;
      },
      markDeliveryRetry: async (_env, id, state) => {
        markedRetry.push([id, state]);
        return true;
      },
      logger: {
        error(details) {
          logs.push(details);
        },
        warn() {}
      }
    })
  );

  assert.deepEqual(sentMessages, ['m1', 'm2', 'm3', 'm4']);
  assert.deepEqual(markedSent, [1]);
  assert.deepEqual(markedRetry, [
    [2, { error: 'server', retryAfterSeconds: 120, permanent: false }],
    [3, { error: 'bad chat', retryAfterSeconds: 0, permanent: true }],
    [4, { error: 'slow down', retryAfterSeconds: 17, permanent: false }]
  ]);
  assert.deepEqual(
    {
      processed: stats.deliveriesProcessed,
      sent: stats.deliveriesSent,
      retried: stats.deliveriesRetried,
      dead: stats.deliveriesDead,
      rateLimited: stats.rateLimited
    },
    { processed: 4, sent: 1, retried: 2, dead: 1, rateLimited: true }
  );
  assert.deepEqual(
    logs.map((entry) => ({
      message: entry.message,
      source: entry.source,
      operation: entry.operation,
      deliveryId: entry.deliveryId,
      attempt: entry.attempt,
      maxAttempts: entry.maxAttempts,
      exhausted: entry.exhausted,
      status: entry.status,
      retryable: entry.retryable,
      permanent: entry.permanent,
      retryAfterSeconds: entry.retryAfterSeconds,
      error: entry.error
    })),
    [
      {
        message: 'Telegram delivery failed.', source: 'scheduled',
        operation: 'sendMessage', deliveryId: 2, attempt: 3, maxAttempts: 10,
        exhausted: false, status: 500, retryable: true, permanent: false,
        retryAfterSeconds: 120, error: 'server'
      },
      {
        message: 'Telegram delivery failed.', source: 'scheduled',
        operation: 'sendMessage', deliveryId: 3, attempt: 1, maxAttempts: 10,
        exhausted: false, status: 400, retryable: false, permanent: true,
        retryAfterSeconds: 0, error: 'bad chat'
      },
      {
        message: 'Telegram delivery failed.', source: 'scheduled',
        operation: 'sendMessage', deliveryId: 4, attempt: 5, maxAttempts: 10,
        exhausted: false, status: 429, retryable: true, permanent: false,
        retryAfterSeconds: 17, error: 'slow down'
      }
    ]
  );
  assert.doesNotMatch(JSON.stringify(logs), /90000000[1-5]|"m[1-5]"/);
});

test('a failed item enqueue is isolated and is not recorded in sent history', async () => {
  const DB = new FakeKv();
  let call = 0;
  const stats = await runScheduled(
    { DB },
    BASE_CONFIG,
    baseDependencies({
      listSubscriptions: async () => [
        { rssUrl: 'https://feeds.test/items', channelName: 'Items', chatId: '1', threadId: null }
      ],
      hashFeedUrl: async () => 'items',
      fetchFeed: async () => ({
        title: 'Items',
        items: [
          { title: 'One', guid: 'one', link: 'https://items.test/one' },
          { title: 'Two', guid: 'two', link: 'https://items.test/two' }
        ]
      }),
      enqueueDeliveries: async () => {
        call += 1;
        if (call === 1) {
          throw new Error('D1 insert failed');
        }
        return 1;
      }
    })
  );

  const history = JSON.parse(DB.values.get('sent_guids:items'));
  assert.deepEqual(history, [
    'id:two',
    'link:https://items.test/two',
    `sha256:${await sha256HexForTest("guid:two")}`
  ]);
  assert.equal(history.some((alias) => alias.includes('one')), false);
  assert.equal(stats.itemsChecked, 2);
  assert.equal(stats.itemsNew, 2);
  assert.equal(stats.itemsFailed, 1);
  assert.equal(stats.deliveriesEnqueued, 1);
});

test('cleanup runs after delivery draining and failures remain isolated', async () => {
  const DB = new FakeKv();
  const order = [];
  const success = await runScheduled(
    { DB },
    BASE_CONFIG,
    baseDependencies({
      listPendingDeliveries: async () => {
        order.push('drain');
        return [];
      },
      pruneOperationalState: async () => {
        order.push('cleanup');
        return { total: 6 };
      }
    })
  );

  assert.deepEqual(order, ['drain', 'cleanup']);
  assert.equal(success.prunedOperationalRows, 6);
  assert.deepEqual(success.errors, []);

  const failure = await runScheduled(
    { DB: new FakeKv() },
    BASE_CONFIG,
    baseDependencies({
      pruneOperationalState: async () => {
        throw new Error('cleanup unavailable');
      }
    })
  );

  assert.equal(failure.prunedOperationalRows, 0);
  assert.deepEqual(failure.errors, [
    {
      stage: 'cleanup',
      rssUrl: "[no-feed-url]",
      message: "cleanup unavailable"
    }
  ]);
});

test('passes a non-empty feed host allowlist to fetchFeed', async () => {
  const allowedFeedHosts = new Set(['feeds.test', '*.trusted.test']);
  let receivedOptions;
  await runScheduled(
    { DB: new FakeKv() },
    { ...BASE_CONFIG, allowedFeedHosts },
    baseDependencies({
      listSubscriptions: async () => [
        {
          rssUrl: 'https://feeds.test/rss',
          channelName: 'Feed',
          chatId: '1',
          threadId: null
        }
      ],
      fetchFeed: async (_url, options) => {
        receivedOptions = options;
        return { title: 'Feed', items: [] };
      }
    })
  );

  assert.equal(receivedOptions.allowedHosts, allowedFeedHosts);
});

test('skips an overlapping run and always releases an acquired run lease', async () => {
  const skippedCalls = [];
  const skipped = await runScheduled(
    { DB: new FakeKv() },
    BASE_CONFIG,
    baseDependencies({
      createRunLeaseToken: () => 'run-skip',
      acquireOperationalLease: async (_env, name, options) => {
        skippedCalls.push(['acquire', name, options]);
        return false;
      },
      ensureLegacySubscriptionsMigrated: async () => {
        skippedCalls.push('migrate');
        return 0;
      },
      releaseOperationalLease: async () => {
        skippedCalls.push('release');
        return true;
      }
    })
  );

  assert.deepEqual(skippedCalls, [
    [
      'acquire',
      'rss-poller',
      { leaseToken: 'run-skip', leaseSeconds: 1200 }
    ]
  ]);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.skipReason, 'lease-held');
  assert.equal(skipped.feedsSelected, 0);

  const releaseCalls = [];
  const expected = new Error('subscription query failed');
  const failingEnv = { DB: new FakeKv() };
  await assert.rejects(
    runScheduled(
      failingEnv,
      BASE_CONFIG,
      baseDependencies({
        createRunLeaseToken: () => 'run-finally',
        listSubscriptions: async () => {
          throw expected;
        },
        releaseOperationalLease: async (...args) => {
          releaseCalls.push(args);
          return true;
        }
      })
    ),
    (error) => error === expected
  );
  assert.deepEqual(releaseCalls, [
    [
      failingEnv,
      'rss-poller',
      { leaseToken: 'run-finally' }
    ]
  ]);
});

test('caps rotated feeds per run and advances the cursor by the selected count', async () => {
  const DB = new FakeKv({ poll_cursor: '1' });
  const fetched = [];
  const subscriptions = ['a', 'b', 'c', 'd', 'e'].map((suffix) => ({
    rssUrl: `https://feeds.test/${suffix}`,
    channelName: suffix.toUpperCase(),
    chatId: suffix,
    threadId: null
  }));

  const stats = await runScheduled(
    { DB },
    { ...BASE_CONFIG, maxFeedsPerRun: 2 },
    baseDependencies({
      listSubscriptions: async () => subscriptions,
      fetchFeed: async (url) => {
        fetched.push(url);
        return { title: '', items: [] };
      }
    })
  );

  assert.deepEqual(fetched, [
    'https://feeds.test/b',
    'https://feeds.test/c'
  ]);
  assert.equal(stats.feeds, 5);
  assert.equal(stats.feedsSelected, 2);
  assert.equal(stats.feedsSucceeded, 2);
  assert.equal(DB.values.get('poll_cursor'), '3');
});

test('dead-letters a retryable delivery when the current failure reaches the attempt ceiling', async () => {
  const marked = [];
  const logs = [];
  const stats = await runScheduled(
    { DB: new FakeKv() },
    { ...BASE_CONFIG, maxDeliveryAttempts: 3 },
    baseDependencies({
      listPendingDeliveries: async () => [
        {
          id: 41,
          chatId: '1',
          threadId: null,
          message: 'retry me',
          attempts: 2
        }
      ],
      sendTelegramMessage: async () => ({
        ok: false,
        status: 503,
        retryable: true,
        permanent: false,
        error: 'temporary outage'
      }),
      markDeliveryRetry: async (_env, id, state) => {
        marked.push([id, state]);
        return true;
      },
      logger: {
        error(details) {
          logs.push(details);
        },
        warn() {}
      }
    })
  );

  assert.equal(stats.deliveriesDead, 1);
  assert.equal(stats.deliveriesRetried, 0);
  assert.deepEqual(marked, [
    [
      41,
      {
        error: 'temporary outage (delivery attempts exhausted at 3)',
        retryAfterSeconds: 0,
        permanent: true
      }
    ]
  ]);
  assert.equal(logs.length, 1);
  assert.deepEqual(
    {
      deliveryId: logs[0].deliveryId,
      attempt: logs[0].attempt,
      maxAttempts: logs[0].maxAttempts,
      exhausted: logs[0].exhausted,
      permanent: logs[0].permanent,
      retryAfterSeconds: logs[0].retryAfterSeconds
    },
    {
      deliveryId: 41,
      attempt: 3,
      maxAttempts: 3,
      exhausted: true,
      permanent: true,
      retryAfterSeconds: 0
    }
  );
});

test('logs and sanitizes thrown sends before a retry-state write can fail', async () => {
  const token = '999999:poller-secret';
  const chatId = '-1005555555555';
  const threadId = '777777';
  const message = 'private delivery payload';
  const logs = [];
  const retryStates = [];
  const cause = new Error(`cause for ${threadId} and ${token}`);
  cause.code = 'ECONNRESET';
  const thrown = new TypeError(
    `failed https://api.telegram.org/bot${token}/sendMessage for ${chatId} ${message}`,
    { cause }
  );

  await assert.rejects(
    runScheduled(
      { DB: new FakeKv() },
      { ...BASE_CONFIG, telegramBotToken: token },
      baseDependencies({
        listPendingDeliveries: async () => [{
          id: 91,
          chatId,
          threadId,
          message,
          attempts: 0
        }],
        sendTelegramMessage: async () => {
          throw thrown;
        },
        markDeliveryRetry: async (_env, id, state) => {
          retryStates.push([id, state]);
          throw new Error('D1 retry-state write failed');
        },
        logger: {
          error(details) {
            logs.push(details);
          },
          warn() {}
        }
      })
    ),
    /D1 retry-state write failed/
  );

  assert.equal(logs.length, 1);
  assert.deepEqual(
    {
      source: logs[0].source,
      operation: logs[0].operation,
      deliveryId: logs[0].deliveryId,
      attempt: logs[0].attempt,
      exhausted: logs[0].exhausted,
      failureKind: logs[0].failureKind,
      failurePhase: logs[0].failurePhase,
      exceptionName: logs[0].exceptionName,
      causeCode: logs[0].causeCode
    },
    {
      source: 'scheduled',
      operation: 'sendMessage',
      deliveryId: 91,
      attempt: 1,
      exhausted: false,
      failureKind: 'caller_exception',
      failurePhase: 'send',
      exceptionName: 'TypeError',
      causeCode: 'ECONNRESET'
    }
  );
  assert.equal(retryStates.length, 1);
  const serializedLogs = JSON.stringify(logs);
  const serializedState = JSON.stringify(retryStates);
  for (const secret of [token, chatId, threadId, message]) {
    assert.equal(serializedLogs.includes(secret), false);
    assert.equal(serializedState.includes(secret), false);
  }
  assert.doesNotMatch(serializedLogs, /api\.telegram\.org\/bot|stack/i);
  assert.doesNotMatch(serializedState, /api\.telegram\.org\/bot/);
});

test('persists stable aliases so changed or missing GUIDs with the same link are not duplicated', async () => {
  const DB = new FakeKv();
  const items = [
    {
      title: 'First title',
      guid: 'old-guid',
      link: 'https://items.test/article?utm_source=feed'
    },
    {
      title: 'Changed title',
      guid: 'new-guid',
      link: 'https://items.test/article?utm_source=feed'
    },
    {
      title: 'Changed again',
      link: 'https://items.test/article?utm_source=feed'
    }
  ];
  let fetchIndex = 0;
  let enqueueCalls = 0;
  const dependencies = baseDependencies({
    listSubscriptions: async () => [
      {
        rssUrl: 'https://feeds.test/stable',
        channelName: 'Stable',
        chatId: '1',
        threadId: null
      }
    ],
    hashFeedUrl: async () => 'stable',
    fetchFeed: async () => ({
      title: 'Stable',
      items: [items[fetchIndex++]]
    }),
    enqueueDeliveries: async () => {
      enqueueCalls += 1;
      return 1;
    }
  });

  const first = await runScheduled(
    { DB },
    { ...BASE_CONFIG, sentHistoryLimit: 2 },
    dependencies
  );
  const second = await runScheduled(
    { DB },
    { ...BASE_CONFIG, sentHistoryLimit: 2 },
    dependencies
  );
  const third = await runScheduled(
    { DB },
    { ...BASE_CONFIG, sentHistoryLimit: 2 },
    dependencies
  );

  assert.equal(enqueueCalls, 1);
  assert.equal(first.itemsNew, 1);
  assert.equal(second.itemsNew, 0);
  assert.equal(third.itemsNew, 0);
  assert.deepEqual(
    JSON.parse(DB.values.get('sent_guids:stable')),
    [
      'link:https://items.test/article',
      `sha256:${await sha256HexForTest("guid:old-guid")}`
    ],
    'SENT_HISTORY_LIMIT is applied after all aliases are persisted'
  );
});

test("does not expose feed URL path tokens through Telegram source labels", async () => {
  const sensitiveUrl =
    "https://user:password@feeds.test/private/path-token-789?api_key=secret#fragment";
  const messages = [];

  const runCase = async (channelName, feedTitle, guid) => {
    await runScheduled(
      { DB: new FakeKv() },
      BASE_CONFIG,
      baseDependencies({
        listSubscriptions: async () => [
          {
            rssUrl: sensitiveUrl,
            channelName,
            chatId: "1",
            threadId: null
          }
        ],
        hashFeedUrl: async () => `privacy-${guid}`,
        fetchFeed: async () => ({
          title: feedTitle,
          items: [
            {
              title: "Article",
              guid,
              link: "https://articles.test/1"
            }
          ]
        }),
        enqueueDeliveries: async (_env, payload) => {
          messages.push(payload.message);
          return 1;
        }
      })
    );
  };

  await runCase("feeds.test/private/path-token-789", "Public Feed", "safe-title");
  await runCase(sensitiveUrl, "https://feeds.test/private/other-token", "hostname");

  assert.match(messages[0], /<b>Source:<\/b> Public Feed/);
  assert.match(messages[1], /<b>Source:<\/b> feeds\.test/);
  assert.doesNotMatch(
    messages.join("\n"),
    /user:password|private|path-token|other-token|api_key|secret|fragment/
  );
});

test('redacts credentials, query strings, and fragments from feed error stats and logs', async () => {
  const sensitiveUrl =
    'https://user:password@feeds.test/private/path?api_key=supersecret#fragment';
  const logs = [];
  const stats = await runScheduled(
    { DB: new FakeKv() },
    BASE_CONFIG,
    baseDependencies({
      listSubscriptions: async () => [
        {
          rssUrl: sensitiveUrl,
          channelName: 'Sensitive',
          chatId: '1',
          threadId: null
        }
      ],
      fetchFeed: async () => {
        throw new Error(`failed to fetch ${sensitiveUrl}`);
      },
      logger: {
        error(message) {
          logs.push(message);
        },
        warn() {}
      }
    })
  );

  assert.deepEqual(stats.errors, [
    {
      stage: 'feed',
      rssUrl: "https://feeds.test",
      message: "failed to fetch https://feeds.test"
    }
  ]);
  const serialized = JSON.stringify(stats) + logs.join('\n');
  assert.doesNotMatch(serialized, /user:password|api_key|supersecret|fragment/);
});
