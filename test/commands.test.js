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
      return { ok: true, result: { message_id: messages.length } };
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
        error: 'Unauthorized for ' + token,
        url: 'https://api.telegram.org/bot' + token + '/sendMessage',
        payload: 'sensitive-payload',
        stack: 'sensitive stack ' + token,
        diagnostic: {
          failureKind: 'network_exception',
          failurePhase: 'fetch',
          durationMs: 7,
          timeoutMs: 10_000,
          upstreamHost: 'untrusted.example',
          upstreamStatus: 0,
          responseContentType: null,
          responseBodyLength: 0,
          timedOut: false,
          exceptionName: 'TypeError',
          exceptionMessage: 'failed for ' + token,
          causeName: 'Error',
          causeCode: 'ECONNRESET',
          causeMessage:
            'https://api.telegram.org/bot' + token + '/sendMessage',
          stack: 'must never be logged'
        }
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
    error: 'Unauthorized for [REDACTED]',
    source: 'webhook',
    failureKind: 'network_exception',
    failurePhase: 'fetch',
    durationMs: 7,
    timeoutMs: 10_000,
    upstreamHost: 'api.telegram.org',
    upstreamStatus: 0,
    responseContentType: null,
    responseBodyLength: 0,
    timedOut: false,
    exceptionName: 'TypeError',
    exceptionMessage: 'failed for [REDACTED]',
    causeName: 'Error',
    causeCode: 'ECONNRESET',
    causeMessage: '[REDACTED_TELEGRAM_URL]'
  }]);
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, new RegExp(token));
  assert.doesNotMatch(serialized, /sensitive-payload|sensitive stack|untrusted/);
  assert.doesNotMatch(serialized, /api\.telegram\.org\/bot/);
});

test('getChatMember failures are logged before permission checks fail closed', async () => {
  const token = 'member-check-token-must-not-leak';
  const logs = [];
  const harness = makeHarness({
    async getChatMember() {
      return {
        ok: false,
        status: 0,
        retryable: true,
        permanent: false,
        retryAfterSeconds: 0,
        error:
          'fetch failed https://api.telegram.org/bot' +
          token +
          '/getChatMember',
        diagnostic: {
          failureKind: 'network_exception',
          failurePhase: 'fetch',
          durationMs: 11,
          timeoutMs: 10_000,
          upstreamStatus: 0,
          responseContentType: null,
          responseBodyLength: 0,
          timedOut: false,
          exceptionName: 'TypeError',
          exceptionMessage: 'fetch failed for ' + token,
          causeName: null,
          causeCode: null,
          causeMessage: null
        }
      };
    },
    logTelegramError(details) {
      logs.push(details);
    }
  });

  await handleMessage(
    makeMessage('/add rss https://feeds.example/rss', {
      chat: { id: '-100123456789', type: 'supergroup' }
    }),
    { DB: makeKv() },
    makeConfig({
      telegramBotToken: token,
      adminUserIds: new Set(),
      allowedFeedHosts: new Set(['feeds.example'])
    }),
    harness.services
  );

  assert.equal(logs.length, 1);
  assert.deepEqual(
    {
      source: logs[0].source,
      operation: logs[0].operation,
      failureKind: logs[0].failureKind,
      failurePhase: logs[0].failurePhase,
      exceptionName: logs[0].exceptionName
    },
    {
      source: 'webhook',
      operation: 'getChatMember',
      failureKind: 'network_exception',
      failurePhase: 'fetch',
      exceptionName: 'TypeError'
    }
  );
  assert.match(harness.messages.at(-1).text, /do not have permission/);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(logs), /api\.telegram\.org\/bot/);
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
    '📋 [rss] feeds.example');
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

test('menu session is scoped, active, and renders bounded navigation callbacks', async () => {
  const kv = makeKv();
  const subscriptions = [{
    id: 1,
    type: 'rss',
    channelName: 'hidden/path',
    rssUrl: 'https://feeds.example/hidden/path?token=secret',
    chatId: '7',
    threadId: null
  }];
  const harness = makeHarness({
    randomUUID() {
      return 'menu_1';
    },
    async listSubscriptions() {
      return subscriptions;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const session = JSON.parse(kv.values.get('ui_session:menu_1'));
  assert.equal(session.sourceChatId, '7');
  assert.equal(session.sourceThreadId, null);
  assert.equal(session.initiatorUserId, '7');
  assert.equal(kv.values.get('ui_active:7:_:7'), 'menu_1');
  assert.match(harness.messages[0].text, /RSS 订阅管理/);
  const callbacks = harness.messages[0].replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.equal(callbacks.includes('ui:menu_1:l:0'), true);
  for (const callback of callbacks) {
    assert.ok(new TextEncoder().encode(callback).length <= 64);
  }

  await handleCallback(
    {
      id: 'wrong-user',
      data: 'ui:menu_1:l:0',
      from: { id: '8' },
      message: { chat: { id: '7', type: 'private' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.match(harness.answers.at(-1).text, /菜单已过期/);

  await handleCallback(
    {
      id: 'right-user',
      data: 'ui:menu_1:l:0',
      from: { id: '7' },
      message: { chat: { id: '7', type: 'private' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.match(harness.messages.at(-1).text, /管理订阅/);
  assert.match(
    harness.messages.at(-1).replyMarkup.inline_keyboard[0][0].text,
    /\[RSS\] feeds\.example/
  );
  assert.doesNotMatch(harness.messages.at(-1).text, /hidden|secret/);
});

test('menu RSS input keeps invalid sessions and consumes successful additions', async () => {
  const kv = makeKv();
  const added = [];
  const harness = makeHarness({
    randomUUID() {
      return 'menu_add';
    },
    async addSubscription(env, subscription) {
      added.push(subscription);
      return true;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleCallback(
    {
      id: 'add-rss',
      data: 'ui:menu_add:at:r',
      from: { id: '7' },
      message: { chat: { id: '7', type: 'private' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const inputKey = 'ui_input:7:_:7';
  assert.equal(JSON.parse(kv.values.get(inputKey)).subscriptionType, 'rss');

  await handleMessage(
    makeMessage('not-a-feed-url'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(kv.values.has(inputKey), true);
  assert.equal(added.length, 0);

  await handleMessage(
    makeMessage('https://feeds.example/private/feed.xml?token=secret'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(kv.values.has(inputKey), false);
  assert.equal(added.length, 1);
  assert.equal(added[0].channelName, 'feeds.example');
  assert.equal(added[0].chatId, '7');
  assert.doesNotMatch(harness.messages.at(-1).text, /token=secret/);
});

test('menu subscription deletion requires confirmation and stays source scoped', async () => {
  const kv = makeKv();
  const removed = [];
  const subscription = {
    id: 42,
    type: 'rss',
    channelName: 'feeds.example',
    rssUrl: 'https://feeds.example/rss',
    chatId: '-100',
    threadId: '9'
  };
  const harness = makeHarness({
    randomUUID() {
      return 'menu_delete';
    },
    async listSubscriptions() {
      return [subscription];
    },
    async removeSubscriptions(env, filter) {
      removed.push(filter);
      return 1;
    },
    async getSubscriptionRouting() {
      return {
        subscriptionId: 42,
        independent: false,
        includeSource: true,
        targets: []
      };
    }
  });
  const messageOverrides = {
    chat: { id: '-100', type: 'supergroup' },
    from: { id: '7' },
    message_thread_id: '9'
  };

  await handleMessage(
    makeMessage('/menu', messageOverrides),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const callbackBase = {
    from: { id: '7' },
    message: {
      chat: { id: '-100', type: 'supergroup' },
      message_thread_id: '9'
    }
  };
  await handleCallback(
    {
      ...callbackBase,
      id: 'delete-confirm',
      data: 'ui:menu_delete:dc:42:0'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(removed.length, 0);
  assert.match(harness.messages.at(-1).text, /确认删除订阅/);

  await handleCallback(
    {
      ...callbackBase,
      id: 'delete-execute',
      data: 'ui:menu_delete:dx:42:0'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(removed, [{
    id: 42,
    chatId: '-100',
    threadId: '9'
  }]);
});

test('first independent target snapshots inherited only-forward behavior', async () => {
  const kv = makeKv();
  kv.values.set('forward_config:7', JSON.stringify({
    targetChatId: '-200',
    targetThreadId: null,
    onlyForward: true,
    isGlobal: true
  }));
  let independent = false;
  let storedSnapshot;
  const subscription = {
    id: 9,
    type: 'rss',
    channelName: 'feeds.example',
    rssUrl: 'https://feeds.example/rss',
    chatId: '7',
    threadId: null
  };
  const harness = makeHarness({
    randomUUID() {
      return 'menu_route';
    },
    async listSubscriptions() {
      return [subscription];
    },
    async getSubscriptionRouting() {
      return independent
        ? {
            subscriptionId: 9,
            independent: true,
            includeSource: storedSnapshot.includeSource,
            targets: storedSnapshot.targets.map((target, index) => ({
              id: index + 1,
              ...target
            }))
          }
        : {
            subscriptionId: 9,
            independent: false,
            includeSource: true,
            targets: []
          };
    },
    async initializeSubscriptionRouting(env, scope, snapshot) {
      assert.deepEqual(scope, {
        subscriptionId: 9,
        chatId: '7',
        threadId: null
      });
      storedSnapshot = structuredClone(snapshot);
      independent = true;
      return { created: true, targetsAdded: snapshot.targets.length };
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleCallback(
    {
      id: 'route-add',
      data: 'ui:menu_route:fa:9',
      from: { id: '7' },
      message: { chat: { id: '7', type: 'private' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleMessage(
    makeMessage('-300 8'),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.deepEqual(storedSnapshot, {
    includeSource: false,
    targets: [
      { chatId: '-200', threadId: null },
      { chatId: '-300', threadId: '8' }
    ]
  });
  assert.equal(kv.values.has('ui_input:7:_:7'), false);
  assert.match(harness.messages.at(-2).text, /已添加独立转发目标/);
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

test('forward copy selector paginates without consuming the session', async () => {
  const kv = makeKv();
  const copies = [];
  const subscriptions = Array.from({ length: 18 }, (_, index) => ({
    id: index + 1,
    type: 'x',
    channelName: 'feed-' + (index + 1),
    rssUrl: 'https://rsshub.example/twitter/user/feed-' + (index + 1),
    chatId: '7',
    threadId: null
  }));
  const harness = makeHarness({
    randomUUID() {
      return 'copy_pages';
    },
    async listSubscriptions() {
      return subscriptions;
    },
    async copySubscriptions(env, selected, chatId, threadId) {
      copies.push({ selected, chatId, threadId });
      return selected.length;
    }
  });

  await handleMessage(
    makeMessage('/forward_to -200'),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const firstCallbacks = harness.messages.at(-1).replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.deepEqual(
    firstCallbacks.filter((value) => /^fwd:copy_pages:\d+$/.test(value)),
    Array.from({ length: 8 }, (_, index) => 'fwd:copy_pages:' + index)
  );
  assert.equal(firstCallbacks.includes('fwd:copy_pages:P1'), true);

  const callbackBase = {
    from: { id: '7' },
    message: { chat: { id: '7', type: 'private' } }
  };
  await handleCallback(
    {
      ...callbackBase,
      id: 'copy-page-2',
      data: 'fwd:copy_pages:P1'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(kv.values.has('fwd_session:copy_pages'), true);
  assert.match(harness.answers.at(-1).text, /已翻页/);
  assert.match(harness.messages.at(-1).text, /第 2\/3 页/);
  const secondCallbacks = harness.messages.at(-1).replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.deepEqual(
    secondCallbacks.filter((value) => /^fwd:copy_pages:\d+$/.test(value)),
    Array.from({ length: 8 }, (_, index) => 'fwd:copy_pages:' + (index + 8))
  );

  await handleCallback(
    {
      ...callbackBase,
      id: 'copy-one',
      data: 'fwd:copy_pages:9'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(kv.values.has('fwd_session:copy_pages'), false);
  assert.deepEqual(copies, [{
    selected: [{
      type: 'x',
      channelName: 'feed-10',
      rssUrl: 'https://rsshub.example/twitter/user/feed-10'
    }],
    chatId: '-200',
    threadId: null
  }]);
});

test('group menu input binds ForceReply to its prompt message', async () => {
  const kv = makeKv();
  const added = [];
  const harness = makeHarness({
    randomUUID() {
      return 'group_input';
    },
    async addSubscription(env, subscription) {
      added.push(subscription);
      return true;
    }
  });
  const group = {
    chat: { id: '-100', type: 'supergroup' },
    from: { id: '7' }
  };

  await handleMessage(
    makeMessage('/menu', group),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleCallback(
    {
      id: 'group-add-rss',
      data: 'ui:group_input:at:r',
      from: { id: '7' },
      message: { chat: { id: '-100', type: 'supergroup' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const prompt = harness.messages.at(-1);
  assert.equal(prompt.replyMarkup.force_reply, true);
  assert.equal(Object.hasOwn(prompt.replyMarkup, 'selective'), false);
  const inputKey = 'ui_input:-100:_:7';
  const input = JSON.parse(kv.values.get(inputKey));
  assert.equal(input.promptMessageId, '2');

  await handleMessage(
    makeMessage('https://feeds.example/no-reply.xml', group),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(added.length, 0);
  assert.equal(kv.values.has(inputKey), true);

  await handleMessage(
    makeMessage('https://feeds.example/replied.xml', {
      ...group,
      reply_to_message: { message_id: 2 }
    }),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(added.length, 1);
  assert.equal(kv.values.has(inputKey), false);
});

test('adding an inherited target keeps the subscription inherited', async () => {
  const kv = makeKv();
  kv.values.set('forward_config:7', JSON.stringify({
    targetChatId: '-200',
    targetThreadId: null,
    onlyForward: false,
    isGlobal: true
  }));
  let initializeCalls = 0;
  const subscription = {
    id: 9,
    type: 'rss',
    channelName: 'feeds.example',
    rssUrl: 'https://feeds.example/rss',
    chatId: '7',
    threadId: null
  };
  const harness = makeHarness({
    randomUUID() {
      return 'inherit_duplicate';
    },
    async listSubscriptions() {
      return [subscription];
    },
    async getSubscriptionRouting() {
      return {
        subscriptionId: 9,
        independent: false,
        includeSource: true,
        targets: []
      };
    },
    async initializeSubscriptionRouting() {
      initializeCalls += 1;
      return { created: true, targetsAdded: 1 };
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleCallback(
    {
      id: 'inherit-add',
      data: 'ui:inherit_duplicate:fa:9',
      from: { id: '7' },
      message: { chat: { id: '7', type: 'private' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleMessage(
    makeMessage('-200'),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(initializeCalls, 0);
  assert.equal(kv.values.has('ui_input:7:_:7'), false);
  assert.equal(
    harness.messages.some((message) => /仍保持继承/.test(message.text)),
    true
  );
});

test('an inherited subscription can opt into source-only routing', async () => {
  const kv = makeKv();
  kv.values.set('forward_config:7', JSON.stringify({
    targetChatId: '-200',
    targetThreadId: null,
    onlyForward: true,
    isGlobal: true
  }));
  let independent = false;
  let storedSnapshot = null;
  let setIncludeSourceCalls = 0;
  const subscription = {
    id: 9,
    type: 'rss',
    channelName: 'feeds.example',
    rssUrl: 'https://feeds.example/rss',
    chatId: '7',
    threadId: null
  };
  const harness = makeHarness({
    randomUUID() {
      return 'source_only';
    },
    async listSubscriptions() {
      return [subscription];
    },
    async getSubscriptionRouting() {
      return {
        subscriptionId: 9,
        independent,
        includeSource: true,
        targets: []
      };
    },
    async initializeSubscriptionRouting(env, scope, snapshot) {
      independent = true;
      storedSnapshot = structuredClone(snapshot);
      return { created: true, targetsAdded: 0 };
    },
    async setSubscriptionIncludeSource() {
      setIncludeSourceCalls += 1;
      return true;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const callbackBase = {
    from: { id: '7' },
    message: { chat: { id: '7', type: 'private' } }
  };
  await handleCallback(
    {
      ...callbackBase,
      id: 'show-routing',
      data: 'ui:source_only:f:9:0'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const routingCallbacks = harness.messages.at(-1).replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.equal(routingCallbacks.includes('ui:source_only:fs:9'), true);

  await handleCallback(
    {
      ...callbackBase,
      id: 'source-only',
      data: 'ui:source_only:fs:9'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(storedSnapshot, { includeSource: true, targets: [] });
  assert.equal(
    harness.messages.some((message) => /仅投递到源会话/.test(message.text)),
    true
  );

  await handleCallback(
    {
      ...callbackBase,
      id: 'source-already-enabled',
      data: 'ui:source_only:fi:9:1'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(setIncludeSourceCalls, 0);
  assert.equal(
    harness.messages.some((message) => /源会话投递已经开启/.test(message.text)),
    true
  );
});
