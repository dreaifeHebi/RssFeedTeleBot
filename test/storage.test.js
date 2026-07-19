import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireOperationalLease,
  addSubscriptionForwardTarget,
  addSubscription,
  claimUpdate,
  completeUpdate,
  copySubscriptions,
  enqueueDeliveries,
  ensureLegacySubscriptionsMigrated,
  getSubscriptionRouting,
  getUpdateState,
  initializeSubscriptionRouting,
  listPendingDeliveries,
  listSubscriptionsWithRouting,
  listSubscriptions,
  markDeliveryRetry,
  markDeliverySent,
  pruneOperationalState,
  releaseOperationalLease,
  releaseUpdate,
  removeSubscriptionForwardTarget,
  resetSubscriptionRouting,
  setSubscriptionIncludeSource,
  removeSubscriptions
} from '../src/storage.js';

class FakeD1Statement {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new FakeD1Statement(this.database, this.sql, params);
  }

  async first() {
    this.database.firstCalls.push(snapshot(this));
    return shiftResult(this.database.firstResults, null);
  }

  async all() {
    this.database.allCalls.push(snapshot(this));
    return shiftResult(this.database.allResults, { results: [] });
  }

  async run() {
    this.database.runCalls.push(snapshot(this));
    return shiftResult(this.database.runResults, changed(1));
  }
}

class FakeD1 {
  constructor({ first = [], all = [], run = [], batch = [] } = {}) {
    this.firstResults = [...first];
    this.allResults = [...all];
    this.runResults = [...run];
    this.batchResults = [...batch];
    this.firstCalls = [];
    this.allCalls = [];
    this.runCalls = [];
    this.batchCalls = [];
  }

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    this.batchCalls.push(statements.map(snapshot));
    return shiftResult(
      this.batchResults,
      statements.map(() => changed(1))
    );
  }
}

test('addSubscription uses D1 uniqueness and normalizes IDs as TEXT', async () => {
  const SQL = new FakeD1({ run: [changed(1), changed(0)] });
  const env = { SQL };
  const subscription = {
    type: 'RSS',
    channelName: ' Example Feed ',
    rssUrl: ' https://example.com/feed.xml ',
    chatId: -100123,
    threadId: null
  };

  assert.equal(await addSubscription(env, subscription), true);
  assert.equal(await addSubscription(env, subscription), false);

  assert.match(SQL.runCalls[0].sql, /ON CONFLICT\(rss_url, chat_id, thread_id\) DO NOTHING/);
  assert.deepEqual(SQL.runCalls[0].params, [
    'rss',
    'example.com',
    'https://example.com/feed.xml',
    '-100123',
    ''
  ]);
});

test('RSS channel names keep only the URL hostname while non-RSS names are preserved', async () => {
  const SQL = new FakeD1({
    run: [changed(1), changed(1), changed(1)]
  });
  const secretPath = '/feeds/secret-token/rss';

  await addSubscription(
    { SQL },
    {
      type: 'rss',
      channelName: secretPath,
      rssUrl: `https://rsshub.example${secretPath}`,
      chatId: '1',
      threadId: null
    }
  );
  await addSubscription(
    { SQL },
    {
      type: 'x',
      channelName: 'x-user',
      rssUrl: 'https://rsshub.example/x/user',
      chatId: '1',
      threadId: null
    }
  );
  await addSubscription(
    { SQL },
    {
      type: 'youtube',
      channelName: 'Video Channel',
      rssUrl: 'https://rsshub.example/youtube/channel/id',
      chatId: '1',
      threadId: null
    }
  );

  assert.equal(SQL.runCalls[0].params[1], 'rsshub.example');
  assert.equal(SQL.runCalls[0].params[2], `https://rsshub.example${secretPath}`);
  assert.doesNotMatch(SQL.runCalls[0].params[1], /secret-token|\/feeds\//);
  assert.equal(SQL.runCalls[1].params[1], 'x-user');
  assert.equal(SQL.runCalls[2].params[1], 'Video Channel');
});

test('listSubscriptions maps D1 rows back to the application shape', async () => {
  const SQL = new FakeD1({
    all: [
      {
        results: [
          {
            id: 7,
            type: 'youtube',
            channel_name: 'Channel',
            rss_url: 'https://example.com/youtube.xml',
            chat_id: '-1001',
            thread_id: '',
            created_at: 123
          }
        ]
      }
    ]
  });

  assert.deepEqual(await listSubscriptions({ SQL }), [
    {
      id: 7,
      type: 'youtube',
      channelName: 'Channel',
      rssUrl: 'https://example.com/youtube.xml',
      chatId: '-1001',
      threadId: null,
      createdAt: 123
    }
  ]);
  assert.match(SQL.allCalls[0].sql, /ORDER BY id ASC/);
});

test('listSubscriptions applies parameterized destination filters', async () => {
  const SQL = new FakeD1({ all: [{ results: [] }] });

  assert.deepEqual(
    await listSubscriptions(
      { SQL },
      { chatId: -1001, threadId: null }
    ),
    []
  );
  assert.match(
    compactSql(SQL.allCalls[0].sql),
    /FROM subscriptions WHERE chat_id = \? AND thread_id = \? ORDER BY id ASC/
  );
  assert.deepEqual(SQL.allCalls[0].params, ['-1001', '']);
});

test('removeSubscriptions builds a parameterized, scoped DELETE', async () => {
  const SQL = new FakeD1({ run: [changed(2), changed(1)] });

  assert.equal(
    await removeSubscriptions(
      { SQL },
      { chatId: -1001, threadId: null, type: 'RSS', channelName: 'Feed' }
    ),
    2
  );
  assert.match(
    compactSql(SQL.runCalls[0].sql),
    /DELETE FROM subscriptions WHERE chat_id = \? AND thread_id = \? AND type = \? AND channel_name = \?/
  );
  assert.deepEqual(SQL.runCalls[0].params, ['-1001', '', 'rss', 'Feed']);

  assert.equal(
    await removeSubscriptions(
      { SQL },
      { id: '123', chatId: -1001, threadId: null }
    ),
    1
  );
  assert.match(
    compactSql(SQL.runCalls[1].sql),
    /DELETE FROM subscriptions WHERE id = \? AND chat_id = \? AND thread_id = \?/
  );
  assert.deepEqual(SQL.runCalls[1].params, [123, '-1001', '']);

  await assert.rejects(
    removeSubscriptions({ SQL }, {}),
    /at least one supported value/
  );
});

test('subscription filters reject invalid ids', async () => {
  const invalidIds = [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    '',
    ' ',
    '+1',
    '-1',
    '1.0',
    '1e3',
    '9007199254740992',
    null,
    undefined
  ];

  for (const id of invalidIds) {
    const SQL = new FakeD1();
    await assert.rejects(
      removeSubscriptions({ SQL }, { id }),
      /filter\.id must be a positive safe integer/
    );
    assert.equal(SQL.runCalls.length, 0);
  }
});

test('legacy KV migration is atomic, idempotent, and leaves the KV key intact', async () => {
  const SQL = new FakeD1({
    first: [null, { value: '{"source":"kv:subscriptions"}' }],
    batch: [[changed(1), changed(0), changed(1)]]
  });
  const kvCalls = [];
  const DB = {
    async get(key) {
      kvCalls.push(['get', key]);
      return JSON.stringify([
        {
          type: 'rss',
          channelName: 'One',
          rssUrl: 'https://example.com/one.xml',
          chatId: 123,
          threadId: null
        },
        {
          type: 'x',
          channelName: 'Two',
          rssUrl: 'https://example.com/two.xml',
          chatId: -456,
          threadId: 8
        }
      ]);
    },
    async delete(key) {
      kvCalls.push(['delete', key]);
    }
  };

  assert.equal(await ensureLegacySubscriptionsMigrated({ SQL, DB }), 1);
  assert.equal(await ensureLegacySubscriptionsMigrated({ SQL, DB }), 0);

  assert.deepEqual(kvCalls, [['get', 'subscriptions']]);
  assert.equal(SQL.batchCalls.length, 1);
  assert.deepEqual(SQL.batchCalls[0][0].params, [
    'rss',
    'example.com',
    'https://example.com/one.xml',
    '123',
    ''
  ]);
  assert.deepEqual(SQL.batchCalls[0][1].params, [
    'x',
    'Two',
    'https://example.com/two.xml',
    '-456',
    '8'
  ]);
  assert.match(SQL.batchCalls[0][2].sql, /INSERT INTO app_meta/);
});

test('legacy migration errors never write the completion marker', async () => {
  const SQL = new FakeD1({ first: [null] });
  const expected = new Error('KV unavailable');
  const DB = {
    async get(key) {
      assert.equal(key, 'subscriptions');
      throw expected;
    }
  };

  await assert.rejects(
    ensureLegacySubscriptionsMigrated({ SQL, DB }),
    (error) => error === expected
  );
  assert.equal(SQL.batchCalls.length, 0);
});

test('copySubscriptions deduplicates the batch for one normalized target', async () => {
  const SQL = new FakeD1({ batch: [[changed(1)]] });
  const duplicate = {
    type: 'rss',
    channelName: 'Feed',
    rssUrl: 'https://example.com/feed.xml',
    chatId: 'ignored',
    threadId: 99
  };

  assert.equal(
    await copySubscriptions({ SQL }, [duplicate, duplicate], -200, null),
    1
  );
  assert.equal(SQL.batchCalls[0].length, 1);
  assert.deepEqual(SQL.batchCalls[0][0].params, [
    'rss',
    'example.com',
    'https://example.com/feed.xml',
    '-200',
    ''
  ]);
});

test('update leases can be claimed, completed, released, and reclaimed only after expiry', async () => {
  const SQL = new FakeD1({
    run: [changed(1), changed(0), changed(1), changed(1)]
  });

  assert.equal(
    await claimUpdate(
      { SQL },
      987654,
      { leaseToken: 'lease-a', leaseSeconds: 300 }
    ),
    true
  );
  assert.equal(
    await claimUpdate(
      { SQL },
      987654,
      { leaseToken: 'lease-b', leaseSeconds: 300 }
    ),
    false
  );
  assert.equal(
    await completeUpdate({ SQL }, 987654, { leaseToken: 'lease-a' }),
    true
  );
  assert.equal(
    await releaseUpdate({ SQL }, 123456, { leaseToken: 'lease-c' }),
    true
  );

  assert.deepEqual(SQL.runCalls[0].params, ['987654', 'lease-a', 300]);
  assert.match(SQL.runCalls[0].sql, /ON CONFLICT\(update_id\) DO UPDATE/);
  assert.match(
    compactSql(SQL.runCalls[0].sql),
    /processed_updates\.status = 'processing' AND processed_updates\.lease_expires_at <= unixepoch\(\)/
  );
  assert.deepEqual(SQL.runCalls[2].params, ['987654', 'lease-a']);
  assert.match(SQL.runCalls[2].sql, /status = 'completed'/);
  assert.deepEqual(SQL.runCalls[3].params, ['123456', 'lease-c']);
  assert.match(SQL.runCalls[3].sql, /DELETE FROM processed_updates/);

  await assert.rejects(
    claimUpdate(
      { SQL },
      1,
      { leaseToken: 'lease', leaseSeconds: 29 }
    ),
    /leaseSeconds/
  );
});

test('getUpdateState distinguishes completed, processing, and missing updates', async () => {
  const SQL = new FakeD1({
    first: [
      { status: 'completed', lease_expires_at: 0 },
      { status: 'processing', lease_expires_at: 1234 },
      null
    ]
  });

  assert.deepEqual(await getUpdateState({ SQL }, 7), {
    status: 'completed',
    leaseExpiresAt: 0
  });
  assert.deepEqual(await getUpdateState({ SQL }, '8'), {
    status: 'processing',
    leaseExpiresAt: 1234
  });
  assert.equal(await getUpdateState({ SQL }, 9), null);

  assert.deepEqual(
    SQL.firstCalls.map((call) => call.params),
    [['7'], ['8'], ['9']]
  );
  assert.match(SQL.firstCalls[0].sql, /FROM processed_updates/);
});

test('operational leases are acquired atomically and released only by their owner', async () => {
  const SQL = new FakeD1({
    run: [changed(1), changed(0), changed(1)]
  });

  assert.equal(
    await acquireOperationalLease(
      { SQL },
      'rss-poller',
      { leaseToken: 'run-a', leaseSeconds: 1200 }
    ),
    true
  );
  assert.equal(
    await acquireOperationalLease(
      { SQL },
      'rss-poller',
      { leaseToken: 'run-b', leaseSeconds: 1200 }
    ),
    false
  );
  assert.equal(
    await releaseOperationalLease(
      { SQL },
      'rss-poller',
      { leaseToken: 'run-a' }
    ),
    true
  );

  assert.deepEqual(SQL.runCalls[0].params, ['rss-poller', 'run-a', 1200]);
  assert.match(SQL.runCalls[0].sql, /ON CONFLICT\(name\) DO UPDATE/);
  assert.match(SQL.runCalls[0].sql, /lease_expires_at <= unixepoch\(\)/);
  assert.deepEqual(SQL.runCalls[2].params, ['rss-poller', 'run-a']);
  assert.match(SQL.runCalls[2].sql, /DELETE FROM operational_leases/);

  await assert.rejects(
    acquireOperationalLease(
      { SQL },
      'rss-poller',
      { leaseToken: 'run', leaseSeconds: 59 }
    ),
    /leaseSeconds/
  );
});

test('pruneOperationalState deletes only old terminal records', async () => {
  const SQL = new FakeD1({
    batch: [[changed(2), changed(3), changed(4)]]
  });

  assert.deepEqual(
    await pruneOperationalState(
      { SQL },
      {
        processedUpdateRetentionDays: 7,
        sentDeliveryRetentionDays: 8,
        deadDeliveryRetentionDays: 30
      }
    ),
    {
      processedUpdates: 2,
      sentDeliveries: 3,
      deadDeliveries: 4,
      total: 9
    }
  );

  assert.equal(SQL.batchCalls.length, 1);
  assert.deepEqual(
    SQL.batchCalls[0].map((statement) => statement.params),
    [[604800, 604800], [691200], [2592000]]
  );
  assert.match(
    compactSql(SQL.batchCalls[0][0].sql),
    /status = 'completed'.*completed_at IS NOT NULL.*status = 'processing'.*lease_expires_at/
  );
  assert.match(
    compactSql(SQL.batchCalls[0][1].sql),
    /status = 'sent'.*COALESCE\(sent_at, updated_at\)/
  );
  assert.match(
    compactSql(SQL.batchCalls[0][2].sql),
    /status = 'dead'.*updated_at/
  );

  await assert.rejects(
    pruneOperationalState(
      { SQL },
      { processedUpdateRetentionDays: 0 }
    ),
    /processedUpdateRetentionDays/
  );
});

test('delivery APIs normalize targets and persist retry state per target', async () => {
  const SQL = new FakeD1({
    batch: [[changed(1), changed(0)]],
    all: [
      {
        results: [
          {
            id: 9,
            feed_key: 'feed',
            item_key: 'item',
            message: '<b>message</b>',
            target_chat_id: '-1',
            target_thread_id: '',
            status: 'pending',
            attempts: 2,
            next_attempt_at: 100,
            last_error: 'rate limited',
            created_at: 50,
            updated_at: 90
          }
        ]
      }
    ],
    run: [changed(1), changed(1)]
  });

  assert.equal(
    await enqueueDeliveries(
      { SQL },
      {
        feedKey: 'feed',
        itemKey: 'item',
        message: '<b>message</b>',
        targets: [
          { chatId: -1, threadId: null },
          { chatId: -2, threadId: 12 }
        ]
      }
    ),
    1
  );
  assert.deepEqual(SQL.batchCalls[0][0].params, [
    'feed',
    'item',
    '<b>message</b>',
    '-1',
    ''
  ]);
  assert.deepEqual(SQL.batchCalls[0][1].params, [
    'feed',
    'item',
    '<b>message</b>',
    '-2',
    '12'
  ]);

  assert.deepEqual(await listPendingDeliveries({ SQL }, 500), [
    {
      id: 9,
      feedKey: 'feed',
      itemKey: 'item',
      message: '<b>message</b>',
      chatId: '-1',
      threadId: null,
      status: 'pending',
      attempts: 2,
      nextAttemptAt: 100,
      lastError: 'rate limited',
      createdAt: 50,
      updatedAt: 90
    }
  ]);
  assert.deepEqual(SQL.allCalls[0].params, [100]);
  assert.match(SQL.allCalls[0].sql, /next_attempt_at <= unixepoch\(\)/);

  assert.equal(await markDeliverySent({ SQL }, 9), true);
  assert.deepEqual(SQL.runCalls[0].params, [9]);
  assert.match(SQL.runCalls[0].sql, /status = 'sent'/);

  assert.equal(
    await markDeliveryRetry(
      { SQL },
      10,
      { error: new Error('temporary'), retryAfterSeconds: 2.2, permanent: true }
    ),
    true
  );
  assert.deepEqual(SQL.runCalls[1].params, ['dead', 3, 'temporary', 10]);
});

test('subscription routing APIs map rows and scope every mutation', async () => {
  const SQL = new FakeD1({
    all: [
      {
        results: [
          {
            id: 5,
            type: 'rss',
            channel_name: 'example.com',
            rss_url: 'https://example.com/feed.xml',
            chat_id: '-100',
            thread_id: '9',
            created_at: 100,
            routing_subscription_id: 5,
            include_source: 0,
            routing_created_at: 110,
            routing_updated_at: 120,
            target_id: 11,
            target_chat_id: '-200',
            target_thread_id: '',
            target_created_at: 130
          },
          {
            id: 5,
            type: 'rss',
            channel_name: 'example.com',
            rss_url: 'https://example.com/feed.xml',
            chat_id: '-100',
            thread_id: '9',
            created_at: 100,
            routing_subscription_id: 5,
            include_source: 0,
            routing_created_at: 110,
            routing_updated_at: 120,
            target_id: 12,
            target_chat_id: '-201',
            target_thread_id: '8',
            target_created_at: 140
          }
        ]
      },
      {
        results: [{
          subscription_id: 6,
          routing_subscription_id: null,
          include_source: 1,
          target_id: null,
          target_chat_id: null,
          target_thread_id: null
        }]
      }
    ],
    batch: [
      [changed(1), changed(1)],
      [changed(1), changed(1)]
    ],
    run: [changed(1), changed(1)]
  });
  const env = { SQL };

  assert.deepEqual(await listSubscriptionsWithRouting(env), [{
    id: 5,
    type: 'rss',
    channelName: 'example.com',
    rssUrl: 'https://example.com/feed.xml',
    chatId: '-100',
    threadId: '9',
    createdAt: 100,
    routing: {
      includeSource: false,
      createdAt: 110,
      updatedAt: 120,
      targets: [
        { id: 11, chatId: '-200', threadId: null, createdAt: 130 },
        { id: 12, chatId: '-201', threadId: '8', createdAt: 140 }
      ]
    }
  }]);
  assert.match(
    compactSql(SQL.allCalls[0].sql),
    /FROM subscriptions.*LEFT JOIN subscription_routing_settings.*LEFT JOIN subscription_forward_targets/
  );

  assert.deepEqual(
    await getSubscriptionRouting(
      env,
      { subscriptionId: 6, chatId: '-100', threadId: null }
    ),
    {
      subscriptionId: 6,
      independent: false,
      includeSource: true,
      targets: []
    }
  );
  assert.deepEqual(SQL.allCalls[1].params, [6, '-100', '']);

  assert.equal(
    await addSubscriptionForwardTarget(
      env,
      { subscriptionId: 5, chatId: '-100', threadId: '9' },
      { chatId: '-300', threadId: '10' }
    ),
    true
  );
  assert.match(
    compactSql(SQL.batchCalls[0][0].sql),
    /INSERT INTO subscription_routing_settings.*SELECT id, 1/
  );
  assert.deepEqual(SQL.batchCalls[0][0].params, [5, '-100', '9']);
  assert.deepEqual(
    SQL.batchCalls[0][1].params,
    ['-300', '10', 5, '-100', '9', 10]
  );
  assert.match(
    compactSql(SQL.batchCalls[0][1].sql),
    /SELECT COUNT\(\*\) FROM subscription_forward_targets WHERE subscription_id = subscriptions\.id \) < \?/
  );

  assert.equal(
    await removeSubscriptionForwardTarget(
      env,
      {
        subscriptionId: 5,
        targetId: 11,
        chatId: '-100',
        threadId: '9'
      }
    ),
    true
  );
  assert.deepEqual(
    SQL.runCalls[0].params,
    [11, 5, '-100', '9', 5, 5, 11]
  );
  assert.match(
    compactSql(SQL.runCalls[0].sql),
    /include_source = 1.*sibling\.id <> \?/
  );

  assert.equal(
    await setSubscriptionIncludeSource(
      env,
      { subscriptionId: 5, chatId: '-100', threadId: '9' },
      false
    ),
    true
  );
  assert.deepEqual(SQL.runCalls[1].params, [0, 5, '-100', '9', 0]);
  assert.match(
    compactSql(SQL.runCalls[1].sql),
    /OR EXISTS \( SELECT 1 FROM subscription_forward_targets/
  );

  assert.equal(
    await resetSubscriptionRouting(
      env,
      { subscriptionId: 5, chatId: '-100', threadId: '9' }
    ),
    2
  );
  assert.deepEqual(SQL.batchCalls[1][0].params, [5, '-100', '9']);
  assert.deepEqual(SQL.batchCalls[1][1].params, [5, '-100', '9']);
});

test('initial routing snapshot is materialized atomically and deduplicates targets', async () => {
  const SQL = new FakeD1({
    batch: [[changed(1), changed(1), changed(0)]]
  });
  const env = { SQL };
  const result = await initializeSubscriptionRouting(
    env,
    { subscriptionId: 7, chatId: '-100', threadId: '9' },
    {
      includeSource: false,
      targets: [
        { chatId: '-200', threadId: null },
        { chatId: '-201', threadId: '8' },
        { chatId: '-200', threadId: null }
      ]
    }
  );

  assert.deepEqual(result, { created: true, targetsAdded: 1 });
  assert.equal(SQL.batchCalls[0].length, 3);
  assert.deepEqual(SQL.batchCalls[0][0].params, [0, 7, '-100', '9']);
  assert.deepEqual(
    SQL.batchCalls[0][1].params,
    ['-200', '', 7, '-100', '9', 10]
  );
  assert.deepEqual(
    SQL.batchCalls[0][2].params,
    ['-201', '8', 7, '-100', '9', 10]
  );
  assert.match(
    compactSql(SQL.batchCalls[0][1].sql),
    /INNER JOIN subscription_routing_settings.*subscriptions\.id = \?.*subscriptions\.chat_id = \?.*subscriptions\.thread_id = \?/
  );
  assert.match(
    compactSql(SQL.batchCalls[0][1].sql),
    /SELECT COUNT\(\*\).*subscription_forward_targets.*< \?/
  );


  const rejected = new FakeD1();
  await assert.rejects(
    initializeSubscriptionRouting(
      { SQL: rejected },
      { subscriptionId: 7, chatId: '-100', threadId: '9' },
      { includeSource: false, targets: [] }
    ),
    /keep the source or contain at least one target/
  );
  assert.equal(rejected.batchCalls.length, 0);
});

test('initial routing snapshot rejects more than ten unique targets before D1 access', async () => {
  const SQL = new FakeD1();
  const targets = Array.from({ length: 11 }, (_, index) => ({
    chatId: String(-200 - index),
    threadId: null
  }));

  await assert.rejects(
    initializeSubscriptionRouting(
      { SQL },
      { subscriptionId: 7, chatId: '-100', threadId: '9' },
      { includeSource: true, targets }
    ),
    /routing\.targets must contain at most 10 unique targets/
  );
  assert.equal(SQL.batchCalls.length, 0);
});

test('subscription routing rejects unsafe identifiers and booleans', async () => {
  const env = { SQL: new FakeD1() };
  await assert.rejects(
    getSubscriptionRouting(
      env,
      { subscriptionId: '../1', chatId: '1', threadId: null }
    ),
    /positive safe integer/
  );
  await assert.rejects(
    removeSubscriptionForwardTarget(
      env,
      { subscriptionId: 1, targetId: 0, chatId: '1', threadId: null }
    ),
    /targetId must be a positive safe integer/
  );
  await assert.rejects(
    setSubscriptionIncludeSource(
      env,
      { subscriptionId: 1, chatId: '1', threadId: null },
      'false'
    ),
    /includeSource must be a boolean/
  );
});

function snapshot(statement) {
  return {
    sql: statement.sql,
    params: [...statement.params]
  };
}

function shiftResult(queue, fallback) {
  if (queue.length === 0) {
    return fallback;
  }
  const result = queue.shift();
  if (result instanceof Error) {
    throw result;
  }
  return result;
}

function changed(changes) {
  return { success: true, meta: { changes } };
}

function compactSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}
