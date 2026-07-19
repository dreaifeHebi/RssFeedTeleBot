import test from 'node:test';
import assert from 'node:assert/strict';

import { handleCallback, handleMessage } from '../src/commands.js';

function makeConfig(overrides = {}) {
  return {
    telegramBotToken: 'test-token',
    botUsername: 'mybot',
    rssBaseUrl: '',
    adminUserIds: new Set(['7']),
    allowedFeedHosts: new Set(),
    ...overrides
  };
}

function makeMessage(text, overrides = {}) {
  return {
    text,
    from: { id: '7' },
    chat: { id: '7', type: 'private' },
    ...overrides
  };
}

function makeKv() {
  const values = new Map();
  const puts = [];
  const deletes = [];
  return {
    values,
    puts,
    deletes,
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async put(key, value, options) {
      values.set(key, value);
      puts.push({ key, value, options });
    },
    async delete(key) {
      values.delete(key);
      deletes.push(key);
    }
  };
}

function makeHarness(overrides = {}) {
  const messages = [];
  const answers = [];
  const services = {
    async sendTelegramMessage(token, chatId, threadId, text, replyMarkup, options) {
      messages.push({ token, chatId, threadId, text, replyMarkup, options });
      return { ok: true };
    },
    async answerCallbackQuery(token, callbackQueryId, text, options) {
      answers.push({ token, callbackQueryId, text, options });
      return { ok: true };
    },
    async addSubscription() {
      return true;
    },
    async listSubscriptions() {
      return [];
    },
    async removeSubscriptions() {
      return 0;
    },
    async copySubscriptions() {
      return 0;
    },
    ...overrides
  };
  return { services, messages, answers };
}

test('management commands deny a group member and allow an administrator', async () => {
  let addCalls = 0;
  const denied = makeHarness({
    async getChatMember() {
      return { status: 'member' };
    },
    async addSubscription() {
      addCalls += 1;
      return true;
    }
  });
  const message = makeMessage(
    '/add rss https://feeds.example/feeds/secret-token/rss?format=xml',
    {
      chat: { id: '-100', type: 'supergroup' }
    }
  );
  const config = makeConfig({
    adminUserIds: new Set(),
    allowedFeedHosts: new Set(['feeds.example'])
  });

  await handleMessage(message, { DB: makeKv() }, config, denied.services);
  assert.equal(addCalls, 0);
  assert.match(denied.messages[0].text, /do not have permission/);

  let added;
  const allowed = makeHarness({
    async getChatMember() {
      return { ok: true, member: { status: 'administrator' } };
    },
    async addSubscription(env, subscription) {
      added = subscription;
      return true;
    }
  });
  await handleMessage(message, { DB: makeKv() }, config, allowed.services);

  assert.deepEqual(added, {
    type: 'rss',
    channelName: 'feeds.example',
    rssUrl: 'https://feeds.example/feeds/secret-token/rss?format=xml',
    chatId: '-100',
    threadId: null
  });
  assert.doesNotMatch(added.channelName, /secret-token/);
  assert.match(allowed.messages.at(-1).text, /Added rss subscription/);
  assert.doesNotMatch(allowed.messages.at(-1).text, /secret-token/);
});

test('command reply failures emit structured logs without exposing the bot token', async () => {
  const logs = [];
  const token = 'test-token-must-not-leak';
  const harness = makeHarness({
    async sendTelegramMessage() {
      return {
        ok: false,
        status: 401,
        retryable: false,
        permanent: true,
        retryAfterSeconds: 0,
        error: 'Unauthorized for ' + token
      };
    },
    logTelegramError(details) {
      logs.push(details);
    }
  });

  await handleMessage(
    makeMessage('/start'),
    { DB: makeKv() },
    makeConfig({ telegramBotToken: token }),
    harness.services
  );

  assert.deepEqual(logs, [{
    message: 'Telegram API request failed.',
    operation: 'sendMessage',
    status: 401,
    retryable: false,
    permanent: true,
    retryAfterSeconds: 0,
    error: 'Unauthorized for [REDACTED]'
  }]);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(token));
});

test('add applies the feed host allowlist and escapes dynamic HTML', async () => {
  let added;
  const harness = makeHarness({
    async addSubscription(env, subscription) {
      added = subscription;
      return true;
    }
  });
  const config = makeConfig({
    rssBaseUrl: 'https://rsshub.example',
    allowedFeedHosts: new Set(['rsshub.example'])
  });

  await handleMessage(
    makeMessage('/add x <b>evil</b>'),
    { DB: makeKv() },
    config,
    harness.services
  );

  assert.equal(added.channelName, '<b>evil</b>');
  assert.equal(
    added.rssUrl,
    'https://rsshub.example/twitter/user/%3Cb%3Eevil%3C%2Fb%3E'
  );
  assert.match(harness.messages.at(-1).text, /&lt;b&gt;evil&lt;\/b&gt;/);
  assert.doesNotMatch(harness.messages.at(-1).text, /subscription: <b>evil<\/b>/);

  added = undefined;
  await handleMessage(
    makeMessage('/add rss https://blocked.example/feed.xml'),
    { DB: makeKv() },
    config,
    harness.services
  );
  assert.equal(added, undefined);
  assert.match(harness.messages.at(-1).text, /host is not allowed/);
});

test('set_forward preserves large chat IDs and safe thread IDs as strings', async () => {
  const kv = makeKv();
  const sourceChatId = '-1009007199254740993000';
  const sourceThreadId = '123456789';
  const targetChatId = '-1009007199254740993999';
  const targetThreadId = '9007199254740991';
  const harness = makeHarness();

  await handleMessage(
    makeMessage(
      '/set_forward ' + targetChatId + ' ' + targetThreadId + ' true topic',
      {
        chat: { id: sourceChatId, type: 'supergroup' },
        message_thread_id: sourceThreadId
      }
    ),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(
    kv.puts[0].key,
    'forward_config:' + sourceChatId + ':' + sourceThreadId
  );
  assert.deepEqual(JSON.parse(kv.puts[0].value), {
    targetChatId,
    targetThreadId,
    onlyForward: true,
    isGlobal: false
  });
  assert.match(harness.messages[0].text, new RegExp(targetChatId));
});

test('forward commands reject thread IDs above Number.MAX_SAFE_INTEGER', async () => {
  const kv = makeKv();
  let listCalls = 0;
  const harness = makeHarness({
    async listSubscriptions() {
      listCalls += 1;
      return [];
    }
  });
  const oversizedThreadId = '9007199254740992';

  await handleMessage(
    makeMessage('/set_forward -200 ' + oversizedThreadId),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(kv.puts.length, 0);
  assert.match(harness.messages.at(-1).text, /Invalid Target Thread ID/);

  await handleMessage(
    makeMessage('/forward_to -200 ' + oversizedThreadId),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(listCalls, 0);
  assert.match(harness.messages.at(-1).text, /Invalid Target Thread ID/);
});

test('list and remove use scoped string chat/thread IDs and escape names', async () => {
  const listFilters = [];
  const removedFilters = [];
  const harness = makeHarness({
    async listSubscriptions(env, filter) {
      listFilters.push(filter);
      return [
        {
          id: 101,
          type: 'x',
          channelName: '<b>unsafe</b>',
          rssUrl: 'https://rsshub.example/twitter/user/unsafe',
          chatId: '-100',
          threadId: '9'
        },
        {
          id: 102,
          type: 'rss',
          channelName: 'legacy/feeds/secret-token/rss',
          rssUrl: 'https://safe-feed.example/feeds/secret-token/rss',
          chatId: '-100',
          threadId: '9'
        },
        {
          id: 103,
          type: 'rss',
          channelName: 'legacy/other-secret/rss',
          rssUrl: 'https://safe-feed.example/other-secret/rss',
          chatId: '-100',
          threadId: '9'
        }
      ];
    },
    async removeSubscriptions(env, filter) {
      removedFilters.push(filter);
      return 1;
    }
  });
  const base = {
    chat: { id: '-100', type: 'supergroup' },
    from: { id: '7' },
    message_thread_id: '9'
  };

  await handleMessage(
    makeMessage('/list', base),
    { DB: makeKv() },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(listFilters[0], { chatId: '-100', threadId: '9' });
  assert.match(harness.messages.at(-1).text, /#101 \[x\]/);
  assert.match(harness.messages.at(-1).text, /#102 \[rss\]/);
  assert.match(harness.messages.at(-1).text, /#103 \[rss\]/);
  assert.match(harness.messages.at(-1).text, /&lt;b&gt;unsafe&lt;\/b&gt;/);
  assert.doesNotMatch(harness.messages.at(-1).text, /- \[x\] <b>unsafe<\/b>/);
  assert.match(harness.messages.at(-1).text, /safe-feed\.example/);
  assert.doesNotMatch(harness.messages.at(-1).text, /secret-token/);

  await handleMessage(
    makeMessage('/remove x <b>unsafe</b>', base),
    { DB: makeKv() },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(removedFilters[0], {
    id: 101,
    chatId: '-100',
    threadId: '9'
  });
  assert.match(harness.messages.at(-1).text, /#101 \[x\]/);
  assert.match(harness.messages.at(-1).text, /&lt;b&gt;unsafe&lt;\/b&gt;/);

  await handleMessage(
    makeMessage('/remove rss safe-feed.example', base),
    { DB: makeKv() },
    makeConfig(),
    harness.services
  );
  assert.equal(removedFilters.length, 1);
  assert.match(harness.messages.at(-1).text, /Multiple subscriptions match/);
  assert.match(harness.messages.at(-1).text, /#102 \[rss\] safe-feed\.example/);
  assert.match(harness.messages.at(-1).text, /#103 \[rss\] safe-feed\.example/);
  assert.doesNotMatch(harness.messages.at(-1).text, /secret-token|other-secret/);

  await handleMessage(
    makeMessage('/del #102', base),
    { DB: makeKv() },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(removedFilters[1], {
    id: 102,
    chatId: '-100',
    threadId: '9'
  });
  assert.match(harness.messages.at(-1).text, /Removed subscription #102/);
});

test('del_forward removes the topic-specific KV key', async () => {
  const kv = makeKv();
  const harness = makeHarness();

  await handleMessage(
    makeMessage('/del_forward', {
      chat: { id: '-100', type: 'supergroup' },
      message_thread_id: '12'
    }),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.deepEqual(kv.deletes, ['forward_config:-100:12']);
  assert.match(harness.messages[0].text, /This Topic/);
});

test('forward sessions bind chat, thread, and initiating user and copy once', async () => {
  const kv = makeKv();
  const copies = [];
  let forwardListFilter;
  const subscriptions = [{
    id: 201,
    type: 'rss',
    channelName: 'legacy/feeds/secret-token/rss',
    rssUrl: 'https://feeds.example/feeds/secret-token/rss',
    chatId: '-100',
    threadId: '9'
  }];
  const harness = makeHarness({
    randomUUID() {
      return 'session_1';
    },
    async listSubscriptions(env, filter) {
      forwardListFilter = filter;
      return subscriptions;
    },
    async copySubscriptions(env, selected, chatId, threadId) {
      copies.push({ selected, chatId, threadId });
      return 1;
    }
  });
  const targetChatId = '-1009007199254740993999';
  const targetThreadId = '9007199254740991';

  await handleMessage(
    makeMessage('/forward_to ' + targetChatId + ' ' + targetThreadId, {
      chat: { id: '-100', type: 'supergroup' },
      message_thread_id: '9'
    }),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.deepEqual(forwardListFilter, { chatId: '-100', threadId: '9' });
  const stored = JSON.parse(kv.values.get('fwd_session:session_1'));
  assert.equal(stored.targetChatId, targetChatId);
  assert.equal(stored.targetThreadId, targetThreadId);
  assert.equal(stored.sourceChatId, '-100');
  assert.equal(stored.sourceThreadId, '9');
  assert.equal(stored.initiatorUserId, '7');
  assert.deepEqual(kv.puts[0].options, { expirationTtl: 3600 });
  assert.equal(stored.subMap[0].channelName, 'feeds.example');
  assert.doesNotMatch(JSON.stringify(stored.subMap[0]), /legacy\/feeds/);
  assert.equal(harness.messages[0].replyMarkup.inline_keyboard[1][0].text,
    '📺 [rss] feeds.example');
  assert.doesNotMatch(
    harness.messages[0].replyMarkup.inline_keyboard[1][0].text,
    /secret-token/
  );

  const callbackBase = {
    id: 'callback-1',
    data: 'fwd:session_1:ALL',
    message: { chat: { id: '-100' }, message_thread_id: '9' }
  };
  await handleCallback(
    { ...callbackBase, from: { id: '8' } },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(copies.length, 0);
  assert.equal(kv.values.has('fwd_session:session_1'), true);
  assert.match(harness.answers.at(-1).text, /not available/);

  await handleCallback(
    { ...callbackBase, from: { id: '7' } },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(copies[0], {
    selected: [{
      type: 'rss',
      channelName: 'feeds.example',
      rssUrl: 'https://feeds.example/feeds/secret-token/rss'
    }],
    chatId: targetChatId,
    threadId: targetThreadId
  });
  assert.equal(kv.values.has('fwd_session:session_1'), false);
  assert.match(harness.answers.at(-1).text, /Forwarded 1/);
});

test('callback consumes the session when allowlist permission was revoked', async () => {
  const kv = makeKv();
  let copyCalls = 0;
  const harness = makeHarness({
    randomUUID() {
      return 'revoked_session';
    },
    async listSubscriptions() {
      return [{
        id: 301,
        type: 'rss',
        channelName: 'feed',
        rssUrl: 'https://feeds.example/feed.xml',
        chatId: '-100',
        threadId: null
      }];
    },
    async copySubscriptions() {
      copyCalls += 1;
      return 1;
    }
  });
  const message = makeMessage('/forward_to -200', {
    chat: { id: '-100', type: 'supergroup' }
  });

  await handleMessage(
    message,
    { DB: kv },
    makeConfig({ adminUserIds: new Set(['7']) }),
    harness.services
  );
  assert.equal(kv.values.has('fwd_session:revoked_session'), true);

  await handleCallback(
    {
      id: 'revoked-callback',
      data: 'fwd:revoked_session:ALL',
      from: { id: '7' },
      message: { chat: { id: '-100', type: 'supergroup' } }
    },
    { DB: kv },
    makeConfig({ adminUserIds: new Set(['99']) }),
    harness.services
  );

  assert.equal(copyCalls, 0);
  assert.equal(kv.values.has('fwd_session:revoked_session'), false);
  assert.match(harness.answers.at(-1).text, /Permission expired/);
});

test('a valid forwarding callback is consumed when rows already exist', async () => {
  const kv = makeKv();
  kv.values.set('fwd_session:existing', JSON.stringify({
    targetChatId: '-200',
    targetThreadId: null,
    sourceChatId: '-100',
    sourceThreadId: null,
    initiatorUserId: '7',
    subMap: [{
      type: 'rss',
      channelName: 'feed',
      rssUrl: 'https://feeds.example/feed.xml'
    }]
  }));
  const harness = makeHarness({
    async copySubscriptions() {
      return 0;
    }
  });

  await handleCallback(
    {
      id: 'callback-2',
      data: 'fwd:existing:ALL',
      from: { id: '7' },
      message: { chat: { id: '-100' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(kv.values.has('fwd_session:existing'), false);
  assert.match(harness.answers[0].text, /already exist/);
});


test('cross-chat commands fail closed unless the initiator manages the target', async () => {
  const kv = makeKv();
  const lookups = [];
  let listCalls = 0;
  const harness = makeHarness({
    async getChatMember(token, chatId, userId) {
      lookups.push(String(chatId));
      return {
        ok: true,
        member: {
          status: String(chatId) === '-100' ? 'administrator' : 'member'
        }
      };
    },
    async listSubscriptions() {
      listCalls += 1;
      return [];
    }
  });
  const messageOverrides = {
    from: { id: '7' },
    chat: { id: '-100', type: 'supergroup' }
  };
  const config = makeConfig({ adminUserIds: new Set() });

  await handleMessage(
    makeMessage('/set_forward -200', messageOverrides),
    { DB: kv },
    config,
    harness.services
  );
  assert.deepEqual(lookups, ['-100', '-200']);
  assert.equal(kv.puts.length, 0);
  assert.match(harness.messages.at(-1).text, /target chat/);

  lookups.length = 0;
  await handleMessage(
    makeMessage('/forward_to -200', messageOverrides),
    { DB: kv },
    config,
    harness.services
  );
  assert.deepEqual(lookups, ['-100', '-200']);
  assert.equal(listCalls, 0);
  assert.match(harness.messages.at(-1).text, /target chat/);
});

test('social names allow common handle characters and reject unsafe shapes', async () => {
  const added = [];
  const harness = makeHarness({
    async addSubscription(env, subscription) {
      added.push(subscription);
      return true;
    }
  });
  const config = makeConfig({
    rssBaseUrl: 'https://rsshub.example',
    allowedFeedHosts: new Set(['rsshub.example'])
  });

  await handleMessage(
    makeMessage('/add x @user.name_test-1'),
    { DB: makeKv() },
    config,
    harness.services
  );
  assert.equal(added[0].channelName, 'user.name_test-1');

  await handleMessage(
    makeMessage('/add x two values'),
    { DB: makeKv() },
    config,
    harness.services
  );
  await handleMessage(
    makeMessage('/add youtube bad\u0001name'),
    { DB: makeKv() },
    config,
    harness.services
  );
  await handleMessage(
    makeMessage('/add x ' + 'a'.repeat(101)),
    { DB: makeKv() },
    config,
    harness.services
  );

  assert.equal(added.length, 1);
  assert.match(harness.messages.at(-3).text, /one value without whitespace/);
  assert.match(harness.messages.at(-2).text, /invalid characters/);
  assert.match(harness.messages.at(-1).text, /too long/);
});
